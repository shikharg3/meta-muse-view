import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { runAsActor } from "@/lib/auth/actor";
import { authFailure } from "@/lib/auth/errors";
import { provisionFederatedUser, toPublicUser, type PublicUser } from "@/lib/auth/users";
import { env } from "@/lib/env";
import { handleChatStream } from "@/server/agent/stream";
import { handlePortalChat } from "@/server/agent/portal/turn";
import { streamPortalChatAs } from "@/server/fns/portal-view-as";
import { runAsPortalActor } from "@/portal/context";
import { resolvePortalActor, touchPortalActor, type PortalActor } from "@/portal/scope";
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
/**
 * The portal assistant (`src/server/agent/portal`), on the PORTAL audience. Streams NDJSON, so it
 * is a route beside the op dispatcher rather than an op — and not `portal*`-named in the op table,
 * which `portal-surface.test.ts` pins.
 */
const PORTAL_CHAT_STREAM_PATH = `${PREFIX}portal/chat/stream`;
/** The same assistant for an admin previewing a client, on the STAFF audience (`viewPortalAs`). */
const VIEW_AS_CHAT_STREAM_PATH = `${PREFIX}viewPortalAs/chat/stream`;

const envelope = z.object({ op: z.string().min(1).optional(), data: z.unknown().optional() });

/** Which shared secret the caller presented, and therefore which ops they may address at all. */
type Audience = "staff" | "portal";

type ErrorCode =
  | "api_disabled"
  | "misconfigured"
  | "method_not_allowed"
  | "insecure_transport"
  | "unauthorized"
  | "no_actor"
  | "invalid_actor"
  | "unknown_actor"
  | "not_approved"
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

/**
 * Resolve — and on first sight create — the caller from the proxy's identity header.
 *
 * Base44 owns sign-up, so an email legitimately arrives having never existed here. It is created
 * `pending`, which grants nothing: the approval floor below refuses every op but `getCurrentUser`
 * until an admin approves the account on `/users`. Role and status stay in Postgres, so Base44
 * still cannot mint an admin.
 */
async function resolveActor(request: Request): Promise<PublicUser | null | "invalid"> {
  const email = request.headers.get("x-actor-email")?.trim().toLowerCase();
  if (!email) return null;
  const row = await provisionFederatedUser(email);
  return row ? toPublicUser(row) : "invalid";
}

/**
 * Ops callable by an account nobody has approved yet.
 *
 * Everything else requires `approved`, mirroring the cookie gate, which 403s a pending user before
 * any server fn runs (`lib/auth/gate.ts`). This floor is not optional: 28 ops carry no
 * authorisation check of their own — the whole dashboard, the client reads, alerts, activity,
 * health — because the gate was always in front of them. Without it, anyone who can sign up on the
 * Base44 app reads the agency's numbers.
 *
 * `getCurrentUser` has to stay reachable or the frontend cannot render its own "waiting for
 * approval" screen.
 */
const PENDING_ALLOWED: Record<string, true> = { getCurrentUser: true };

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

/** The prefix that marks an op as callable by a client. Enforced, not merely a naming habit. */
const PORTAL_OP_PREFIX = "portal";
/**
 * Answer a request that presented the PORTAL token.
 *
 * Three things are deliberately different from the staff path above:
 *
 * 1. **The op must be a `portal*` op.** An allowlist by construction: the staff ops are not merely
 *    unauthorised here, they are unaddressable, and a new staff op cannot accidentally become
 *    client-reachable by being added to a module.
 * 2. **An unknown email is refused, not created.** The staff path calls `provisionFederatedUser()`,
 *    which is right for a colleague signing in for the first time but wrong for a public sign-up
 *    form: it would fill the staff Users page with customers. An operator invites a portal user.
 * 3. **The staff actor context is explicitly empty.** `runAsActor(null, …)` wraps the call, so any
 *    staff check reached from portal code (`requireAdmin()`, `requireApproved()`) fails closed
 *    instead of reading a cookie that is not there. The portal actor lives in its own context.
 */
async function handlePortalRequest(request: Request, url: URL): Promise<Response> {
  if (url.pathname === `${PREFIX}_ops` && request.method === "GET") {
    return Response.json({
      ok: true,
      data: allOps()
        .filter((o) => o.name.startsWith(PORTAL_OP_PREFIX))
        .map((o) => ({ name: o.name, mode: o.mode })),
    });
  }
  if (request.method !== "POST") {
    return fail(405, "method_not_allowed", "Ops are invoked with POST.");
  }

  const email = request.headers.get("x-actor-email")?.trim().toLowerCase();
  if (!email) {
    return fail(401, "no_actor", "Missing X-Actor-Email — the proxy must identify the caller.");
  }

  let actor: PortalActor | null;
  try {
    actor = await resolvePortalActor(email);
  } catch (e) {
    console.error("[portal] actor lookup failed", e);
    return fail(503, "internal", "Could not resolve the caller — the database is unreachable.");
  }
  // Says nothing about whether the address exists: the portal shows its own "no access yet"
  // screen, and confirming which emails are customers of the agency is not this endpoint's job.
  if (!actor) {
    return fail(403, "unknown_actor", "This account has no portal access.");
  }
  if (actor.status !== "approved") {
    return fail(
      403,
      "not_approved",
      actor.status === "rejected"
        ? "Your portal access was withdrawn."
        : "Your portal access is not active yet.",
    );
  }

  // After the approval floor and before the op envelope: a turn is a stream, not an op. The body is
  // `{ brandId, messages }`, validated — brand included, against this actor's own scope — inside.
  if (url.pathname === PORTAL_CHAT_STREAM_PATH) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return fail(400, "bad_request", "Body must be JSON.");
    }
    void touchPortalActor(actor.id);
    return handlePortalChat(actor, raw, null);
  }

  let body: z.infer<typeof envelope>;
  try {
    body = envelope.parse(await request.json());
  } catch {
    return fail(400, "bad_request", "Body must be JSON.");
  }

  const tail = url.pathname.slice(PREFIX.length);
  const name = tail === "invoke" ? body.op : tail;
  if (!name) {
    return fail(400, "bad_request", "Missing op name — POST to /api/v1/<op> or send {op}.");
  }
  // Checked before the lookup so a staff op reports the same "no such op" a typo does, rather than
  // confirming which internal operations exist.
  const op = name.startsWith(PORTAL_OP_PREFIX) ? lookupOp(name) : undefined;
  if (!op) return fail(404, "unknown_op", `No such op: "${name}".`);

  void touchPortalActor(actor.id);

  try {
    const data = await runAsActor(null, () => runAsPortalActor(actor, () => op.run(body.data)));
    return Response.json({ ok: true, data: data ?? null });
  } catch (e) {
    return errorResponse(name, e);
  }
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

  // Two audiences share this surface, told apart by WHICH secret was presented — not by a role on
  // the caller. The internal token authorises every op; the portal token authorises only `portal*`,
  // and each of those scopes itself to the calling client's own grants.
  //
  // Deciding on the token is what makes the client-facing app safe to ship: it physically cannot
  // address `getFinance` or `resetAndResync`, so a compromise of that app exposes one client's
  // marked-up figures rather than the agency's. A role check on a single shared token would leave
  // those ops one forgotten `if` away.
  const { VPS_API_TOKEN: staffToken, PORTAL_API_TOKEN: portalToken } = env();
  if (!staffToken && !portalToken) {
    return fail(503, "api_disabled", "Neither VPS_API_TOKEN nor PORTAL_API_TOKEN is set.");
  }
  // Identical secrets would silently promote every portal caller to staff, because the staff
  // comparison below runs first. Refuse rather than pick a winner.
  if (staffToken && portalToken && staffToken === portalToken) {
    return fail(503, "misconfigured", "VPS_API_TOKEN and PORTAL_API_TOKEN must differ.");
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
  let audience: Audience | null = null;
  if (presented && staffToken && secretMatches(presented, staffToken)) audience = "staff";
  else if (presented && portalToken && secretMatches(presented, portalToken)) audience = "portal";
  if (!audience) {
    return fail(401, "unauthorized", "Invalid or missing bearer token.");
  }

  if (audience === "portal") return handlePortalRequest(request, url);

  // Outside the op's try/catch, so an unreachable database here would otherwise escape to
  // `src/server.ts` and be answered with the HTML error page — a machine caller must always get
  // JSON, and "the DB is down" must not read as "your token is bad".
  let actor: PublicUser | null | "invalid";
  try {
    actor = await resolveActor(request);
  } catch (e) {
    console.error("[api] actor lookup failed", e);
    return fail(503, "internal", "Could not resolve the caller — the database is unreachable.");
  }
  if (actor === "invalid") {
    return fail(400, "invalid_actor", "X-Actor-Email is not a valid email address.");
  }
  // No anonymous access, even holding the token. The 28 ops with no authorisation check of their
  // own would otherwise be readable by the bearer alone, and the proxy always knows who is asking.
  if (!actor) {
    return fail(401, "no_actor", "Missing X-Actor-Email — the proxy must identify the caller.");
  }

  if (url.pathname === CHAT_STREAM_PATH) {
    if (request.method !== "POST") return fail(405, "method_not_allowed", "POST only.");
    return handleChatStream(request, actor);
  }

  // Needs an approved account explicitly: this route sits in front of the op approval floor below,
  // and `requireAdmin()` inside checks the role, not the status.
  if (url.pathname === VIEW_AS_CHAT_STREAM_PATH) {
    if (request.method !== "POST") return fail(405, "method_not_allowed", "POST only.");
    if (actor.status !== "approved") {
      return fail(403, "not_approved", "Your account is waiting for an admin to approve it.");
    }
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return fail(400, "bad_request", "Body must be JSON.");
    }
    try {
      return await runAsActor(actor, () => streamPortalChatAs(raw));
    } catch (e) {
      return errorResponse("viewPortalAs/chat/stream", e);
    }
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

  if (actor.status !== "approved" && !PENDING_ALLOWED[name]) {
    return fail(
      403,
      "not_approved",
      actor.status === "rejected"
        ? "Your access to MetaConsole was declined."
        : "Your account is waiting for an admin to approve it.",
    );
  }

  try {
    const data = await runAsActor(actor, () => op.run(body.data));
    return Response.json({ ok: true, data: data ?? null });
  } catch (e) {
    return errorResponse(name, e);
  }
}
