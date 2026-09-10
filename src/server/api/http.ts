import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { runAsActor } from "@/lib/auth/actor";
import { authFailure } from "@/lib/auth/errors";
import { findUserByEmail, toPublicUser, type PublicUser } from "@/lib/auth/users";
import { env } from "@/lib/env";
import { handleChatStream } from "@/server/agent/stream";
import { allOps, lookupOp } from "./ops";

/**
 * The HTTP API the Base44 frontend talks to.
 *
 * Shape and threat model, because both are deliberate:
 *
 * - **Uniform POST RPC** at `/api/v1/<opName>` with a JSON body, not a REST noun hierarchy. The
 *   only caller is a Base44 backend function, several ops take nested inputs (`accountIds[]`,
 *   `columns[]`), and the app it replaces was already RPC. Query-string encoding rules would be
 *   pure ceremony.
 * - **No CORS, ever.** Browsers must not reach this. The bearer token below is a single shared
 *   secret with the authority of the whole database, so it lives only in a Base44 *backend*
 *   function's secrets and never in shipped frontend code. Absent `Access-Control-Allow-Origin`,
 *   a stolen-then-replayed browser request is impossible rather than merely discouraged.
 * - **Identity is asserted, authorisation is not.** The proxy sends `X-Actor-Email` for the
 *   Base44-authenticated user; this resolves that email against the local `users` table and runs
 *   the op as that row. Role, approval status, the audit trail and the whole approve/reject
 *   lifecycle therefore stay in Postgres where they already are. Base44 says *who*, never *what
 *   they may do* — a compromised Base44 app cannot mint an admin.
 */

const PREFIX = "/api/v1/";
const CHAT_STREAM_PATH = `${PREFIX}chat/stream`;

const envelope = z.object({ op: z.string().min(1).optional(), data: z.unknown().optional() });

type ErrorCode =
  | "api_disabled"
  | "method_not_allowed"
  | "insecure_transport"
  | "unauthorized"
  | "unknown_actor"
  | "bad_request"
  | "invalid_input"
  | "unknown_op"
  | "forbidden"
  | "internal";

function fail(status: number, code: ErrorCode, message: string, extra?: unknown): Response {
  return Response.json(
    { ok: false, error: { code, message, ...(extra === undefined ? {} : { detail: extra }) } },
    { status },
  );
}

/**
 * Constant-time secret comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak the token length, so both
 * sides are hashed to a fixed 32 bytes first.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function resolveActor(request: Request): Promise<PublicUser | null | "unknown"> {
  const email = request.headers.get("x-actor-email")?.trim().toLowerCase();
  if (!email) return null;
  const row = await findUserByEmail(email);
  if (!row) return "unknown";
  return toPublicUser(row);
}

/**
 * Map a thrown domain error onto a status code.
 *
 * Only the auth classes are translated. The eight ops that *return* `{ error }` instead of throwing
 * keep doing so — that is their contract, and rewriting it here would make the same failure arrive
 * two different ways depending on which delegate produced it. Transport reports transport
 * failures; domain results stay in `data`.
 */
function errorResponse(op: string, e: unknown): Response {
  if (e instanceof z.ZodError) {
    return fail(400, "invalid_input", `Invalid input for "${op}".`, e.issues);
  }
  const auth = authFailure(e);
  if (auth) {
    const status = auth.name === "UnauthorizedError" ? 401 : 403;
    return fail(status, status === 401 ? "unauthorized" : "forbidden", auth.message);
  }
  console.error(`[api] op "${op}" failed`, e);
  return fail(500, "internal", "The operation failed. Check the server log.");
}

/**
 * Answer an API request, or return `null` when the path is not ours.
 *
 * Called from `src/server.ts` *before* the cookie gate: the gate 302s HTML callers to `/login` and
 * 401s the rest, neither of which is a useful answer for a token-authenticated machine caller.
 */
export async function handleApiRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return null;

  const token = env().VPS_API_TOKEN;
  if (!token) {
    return fail(503, "api_disabled", "VPS_API_TOKEN is not set on this server.");
  }

  // A bearer token crossing plain HTTP is a token in the clear. nginx forwards the real scheme, so
  // refuse in production rather than trusting that certbot has been run.
  if (process.env.NODE_ENV === "production") {
    const proto = request.headers.get("x-forwarded-proto");
    if (proto && proto.split(",")[0]?.trim() !== "https") {
      return fail(403, "insecure_transport", "The API requires HTTPS.");
    }
  }

  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!presented || !secretMatches(presented, token)) {
    return fail(401, "unauthorized", "Invalid or missing bearer token.");
  }

  // Outside the op's try/catch, so an unreachable database here would otherwise escape to
  // `src/server.ts` and be answered with the HTML error page — a machine caller must always get
  // JSON, and "the DB is down" must not read as "your token is bad".
  let actor: PublicUser | null | "unknown";
  try {
    actor = await resolveActor(request);
  } catch (e) {
    console.error("[api] actor lookup failed", e);
    return fail(503, "internal", "Could not resolve the caller — the database is unreachable.");
  }
  if (actor === "unknown") {
    return fail(
      403,
      "unknown_actor",
      "No user with that email exists here. Have an admin approve the account on the Users page first.",
    );
  }

  if (url.pathname === CHAT_STREAM_PATH) {
    if (request.method !== "POST") return fail(405, "method_not_allowed", "POST only.");
    return handleChatStream(request, actor);
  }

  // The manifest exists so a client can assert at startup that the op it is about to call still
  // exists, instead of discovering a rename as a 404 mid-render.
  if (url.pathname === `${PREFIX}_ops` && request.method === "GET") {
    return Response.json({
      ok: true,
      data: allOps().map((o) => ({ name: o.name, mode: o.mode })),
    });
  }

  if (request.method !== "POST") {
    return fail(405, "method_not_allowed", "Ops are invoked with POST.");
  }

  let body: z.infer<typeof envelope>;
  try {
    body = envelope.parse(await request.json());
  } catch {
    return fail(400, "bad_request", "Body must be JSON.");
  }

  // Both spellings work: the op in the path (`/api/v1/getOverview`) or in the body (`{op}` posted
  // to `/api/v1/invoke`), so one Base44 function can serve every op without rebuilding URLs.
  const tail = url.pathname.slice(PREFIX.length);
  const name = tail === "invoke" ? body.op : tail;
  if (!name)
    return fail(400, "bad_request", "Missing op name — POST to /api/v1/<op> or send {op}.");

  const op = lookupOp(name);
  if (!op) return fail(404, "unknown_op", `No such op: "${name}".`);

  try {
    const data = await runAsActor(actor, () => op.run(body.data));
    return Response.json({ ok: true, data: data ?? null });
  } catch (e) {
    return errorResponse(name, e);
  }
}
