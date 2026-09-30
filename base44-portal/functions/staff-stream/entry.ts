import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

/**
 * The portal assistant for an agency admin previewing a client ("view as client").
 *
 * Why it exists at all: `portal-stream` identifies the caller by their OWN Base44 email, which for
 * an admin is not a portal login, so a preview through it would be refused. Every other preview
 * call goes through the staff function's `viewPortalAs` op, but that op answers JSON and a turn is
 * a stream — hence this streaming sibling of `staff/entry.ts`.
 *
 * It is `staff/entry.ts`'s gates, unchanged, in front of exactly one route:
 *
 * 1. **Here: the Base44 role must be `admin`.** Load-bearing for the same reason it is there — the
 *    VPS's staff transport creates a `users` row for any email it is handed.
 * 2. **On the VPS: `requireAdmin()` and an approved `users` row** decide, per turn, and write a
 *    `portal.view_as.chat` audit entry. The email of the login being previewed is a request field
 *    only on this staff-token route; the client token cannot address it.
 *
 * It forwards ONLY to `POST /api/v1/viewPortalAs/chat/stream` — never a path from the request — so
 * holding `VPS_API_TOKEN` here grants the browser nothing beyond that one preview. The body is
 * passed through unread and there is no timer, as in `portal-stream`.
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
    console.error("[staff-stream] auth.me() failed:", message);
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

  const upstream = await fetch(`${base.replace(/\/+$/, "")}/api/v1/viewPortalAs/chat/stream`, {
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
      { ok: false, error: { code: "upstream_unreachable", message: "The VPS API did not respond." } },
      { status: 504 },
    );
  }
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
