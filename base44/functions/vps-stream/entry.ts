import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

/**
 * The AI assistant's transport: NDJSON, streamed straight through.
 *
 * Separate from the `vps` op proxy because a turn emits `ChatEvent` lines while the model is still
 * working — tool progress, token deltas — and buffering them into one JSON reply is the exact
 * regression the streaming endpoint was built to fix. `base44.functions.fetch()` on the client hands
 * back the raw `Response`, and passing `upstream.body` through unread keeps the chunks flowing.
 *
 * Identity handling is the same as `vps`: Base44 says who, the VPS decides what they may do.
 */
export default async function (req: Request): Promise<Response> {
  const base = secrets.get("VPS_API_URL");
  const token = secrets.get("VPS_API_TOKEN");
  if (!base || !token) {
    return Response.json({ error: "VPS_API_URL / VPS_API_TOKEN unset." }, { status: 503 });
  }

  // Throws rather than returning null; see the note in functions/vps/entry.ts.
  let user: { email?: string | null } | null = null;
  try {
    user = await createClientFromRequest(req).auth.me();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[vps-stream] auth.me() failed:", message);
    return Response.json({ error: `Not signed in — ${message}` }, { status: 401 });
  }
  if (!user?.email) return Response.json({ error: "Sign in first." }, { status: 401 });

  const upstream = await fetch(`${base.replace(/\/+$/, "")}/api/v1/chat/stream`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/x-ndjson",
      "x-actor-email": user.email,
    },
    body: await req.text(),
  }).catch(() => null);

  if (!upstream) return Response.json({ error: "The VPS API did not respond." }, { status: 504 });
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
