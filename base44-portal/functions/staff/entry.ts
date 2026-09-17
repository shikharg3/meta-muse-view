import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

/**
 * The agency-side door, in the same Base44 app as the client portal.
 *
 * This app serves two audiences — customers on `/` and agency staff on `/admin` — so it holds both
 * secrets. That is a deliberate trade the owner made to keep the already-built admin UI in one
 * app, and it costs the property its sibling `portal/entry.ts` has: a compromise of this frontend
 * is no longer limited to one client's figures, because `VPS_API_TOKEN` is the whole database.
 *
 * Two gates stand behind that, and NEITHER is optional:
 *
 * 1. **Here: the Base44 role must be `admin`.** Not defence in depth — load-bearing. The VPS
 *    resolves `X-Actor-Email` with `provisionFederatedUser()`, which CREATES a staff `users` row
 *    for any email it is handed. Forwarding a customer's request would therefore enrol every
 *    customer in the internal Users page as `pending`. Refusing before the fetch is what keeps the
 *    staff user table staff-only.
 * 2. **On the VPS: role and approval live in Postgres.** `requireAdmin()` re-decides from the
 *    `users` row, not from anything this function claims. So a customer who somehow reached this
 *    function still cannot act as an admin — the worst case is an unapproved row, which grants
 *    nothing. Base44 asserts identity; the droplet decides authority.
 *
 * Client-facing reads do NOT come through here. They use `portal/entry.ts` and the portal token,
 * which can address only `portal*` ops. Keep it that way: routing a portal page through this
 * function to save a round trip would hand a customer's page the agency's authority.
 */
export default async function (req: Request): Promise<Response> {
  const base = secrets.get("VPS_API_URL");
  const token = secrets.get("VPS_API_TOKEN");
  if (!base || !token) {
    return Response.json(
      {
        ok: false,
        error: { code: "misconfigured", message: "VPS_API_URL / VPS_API_TOKEN unset." },
      },
      { status: 503 },
    );
  }

  // `auth.me()` throws rather than returning null — see the note in portal/entry.ts.
  let user: { email?: string | null; role?: string | null } | null = null;
  try {
    user = await createClientFromRequest(req).auth.me();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[staff] auth.me() failed:", message);
    return Response.json(
      { ok: false, error: { code: "unauthorized", message: `Not signed in — ${message}` } },
      { status: 401 },
    );
  }
  if (!user?.email) {
    return Response.json(
      { ok: false, error: { code: "unauthorized", message: "Sign in first." } },
      { status: 401 },
    );
  }
  // Fail closed on an absent role: a missing field must never read as "admin".
  if (user.role !== "admin") {
    return Response.json(
      { ok: false, error: { code: "forbidden", message: "Admin access required." } },
      { status: 403 },
    );
  }

  let body: { op?: unknown; data?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { ok: false, error: { code: "bad_request", message: "Body must be JSON." } },
      { status: 400 },
    );
  }
  if (typeof body.op !== "string" || body.op === "") {
    return Response.json(
      { ok: false, error: { code: "bad_request", message: "Missing op name." } },
      { status: 400 },
    );
  }
  // `portal*` ops are the customer surface and scope themselves to the CALLER's own grants, which
  // for a staff caller is nothing. Routing one through here would return an empty dashboard and
  // read as a data bug, so refuse with something that says why.
  if (body.op.startsWith("portal")) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: `"${body.op}" is a client-portal op — call it through /portal.`,
        },
      },
      { status: 400 },
    );
  }

  // Generous: `resetAndResync` and `startReportRun` are the ops that approach the runtime ceiling.
  const abort = AbortSignal.timeout(4 * 60 * 1000 + 30_000);

  let upstream: Response;
  try {
    upstream = await fetch(`${base.replace(/\/+$/, "")}/api/v1/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-actor-email": user.email,
      },
      body: JSON.stringify({ op: body.op, data: body.data }),
      signal: abort,
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return Response.json(
      {
        ok: false,
        error: {
          code: timedOut ? "upstream_timeout" : "upstream_unreachable",
          message: timedOut
            ? `"${body.op}" did not finish within the function time limit.`
            : "The VPS API did not respond.",
        },
      },
      { status: 504 },
    );
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
