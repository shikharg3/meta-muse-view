import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

/**
 * The portal assistant's transport: NDJSON, streamed straight through to the customer's browser.
 *
 * The streaming sibling of `portal/entry.ts`, with the same secret and the same identity rule —
 * `PORTAL_API_TOKEN`, and `X-Actor-Email` taken from `auth.me()`, never from the request — so the
 * VPS treats a turn exactly like a `portal*` op: client audience, the caller's own grants, nothing
 * else reachable. It forwards to exactly one route, `POST /api/v1/portal/chat/stream`, whose tools
 * read the one brand the request names after the VPS has checked that brand against the caller's
 * scope (`src/server/agent/portal`).
 *
 * Deliberately different from `portal`:
 * - **No 45s timer.** A turn is several model round-trips and legitimately runs past a dashboard
 *   read's leash; the model client on the VPS carries its own time limits.
 * - **The body is passed through unread.** `base44.functions.fetch()` hands the browser the raw
 *   `Response`, so returning `upstream.body` keeps each event flowing as it is written instead of
 *   buffering the whole answer — the regression the internal app's `vps-stream` exists to avoid.
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

  // `auth.me()` throws rather than returning null — see the note in portal/entry.ts.
  let user: { email?: string | null } | null = null;
  try {
    user = await createClientFromRequest(req).auth.me();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[portal-stream] auth.me() failed:", message);
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

  const upstream = await fetch(`${base.replace(/\/+$/, "")}/api/v1/portal/chat/stream`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/x-ndjson",
      "x-actor-email": user.email,
    },
    body: await req.text(),
  }).catch(() => null);

  if (!upstream) {
    return Response.json(
      {
        ok: false,
        error: { code: "upstream_unreachable", message: "The analytics service did not respond." },
      },
      { status: 504 },
    );
  }
  // A refusal (no such brand, daily limit, not signed up) is the VPS's JSON envelope; pass it on
  // with its status so the browser can show the sentence.
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
