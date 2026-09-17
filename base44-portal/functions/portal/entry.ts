import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

/**
 * The only door between the CLIENT PORTAL frontend and the VPS.
 *
 * Deployed in the Base44 app `6a91757327c7555d5f5a8f91` ("DotAnalytics"), which is the app the
 * agency's customers log into. Its sibling in `base44/functions/vps/entry.ts` does the same job for
 * the internal app (`MetaMuse`) — same shape, different secret, and that difference is the whole
 * security boundary:
 *
 *   internal app -> VPS_API_TOKEN    -> every op
 *   THIS app     -> PORTAL_API_TOKEN -> only `portal*` ops, each scoped to the caller's grants
 *
 * The VPS decides the audience from which secret arrives (`src/server/api/http.ts`), so this app
 * cannot address `getFinance`, `listUsers` or `resetAndResync` even if it tried. A total compromise
 * of this frontend exposes one client's already-marked-up figures, never the agency's numbers.
 *
 * There is deliberately NO streaming sibling here. The internal app's `vps-stream` proxies the AI
 * assistant, whose tools read finance, infrastructure and every client — none of which a customer
 * may see. A portal assistant needs its own scoped tool set before it gets a transport.
 */
export default async function (req: Request): Promise<Response> {
  const base = secrets.get("PORTAL_API_URL");
  const token = secrets.get("PORTAL_API_TOKEN");
  if (!base || !token) {
    return Response.json(
      {
        ok: false,
        error: { code: "misconfigured", message: "PORTAL_API_URL / PORTAL_API_TOKEN unset." },
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
    console.error("[portal] auth.me() failed:", message);
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

  // Portal ops are dashboard reads, not the multi-minute jobs the internal app runs, so this is a
  // far shorter leash than `vps`'s four minutes — a portal request that has not answered in 45s is
  // a fault to surface, not something to keep a customer's spinner alive for.
  const abort = AbortSignal.timeout(45_000);

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
            ? `"${body.op}" did not finish in time.`
            : "The analytics service did not respond.",
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
