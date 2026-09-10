import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

/**
 * The only door between the Base44 frontend and the VPS.
 *
 * Why a proxy rather than letting the SPA call the VPS directly: `VPS_API_TOKEN` is a single shared
 * secret with the authority of the whole database — every credential write, `resetAndResync`, the
 * finance figures. Anything the browser holds is public, so the token lives here, in a backend
 * function's secrets, and the VPS API answers no cross-origin requests at all.
 *
 * This function asserts *identity* only. It sends the Base44-authenticated email; the VPS resolves
 * that against its own `users` table for role, approval status and the audit trail. A compromised
 * Base44 app therefore cannot mint an admin — the worst it can do is act as an already-approved
 * user. Team members must exist and be approved on the VPS Users page; their Base44 login email
 * must match their VPS account email exactly.
 *
 * The upstream envelope (`{ok, data}` / `{ok, error}`) and its status code are passed through
 * untouched, so the frontend sees exactly what the VPS said.
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

  // `auth.me()` THROWS rather than returning null — no session, an expired token, and an
  // unpublished app all arrive here as a `Base44Error`. Uncaught it becomes a bare 500
  // "user worker threw an exception", which says nothing about which of those it was.
  let user: { email?: string | null } | null = null;
  try {
    user = await createClientFromRequest(req).auth.me();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[vps] auth.me() failed:", message);
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

  // 5 minutes is this runtime's hard ceiling, and `resetAndResync` / `startReportRun` are the ops
  // that get anywhere near it. Abort a little early so the caller gets a JSON timeout instead of
  // the platform killing the invocation with no response at all.
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
