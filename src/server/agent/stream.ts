import { SESSION_COOKIE, readCookie, verifySession } from "@/lib/auth/session";
import { findUserById, toPublicUser, type PublicUser } from "@/lib/auth/users";
import {
  appendTurn,
  createConversation,
  getConversationFull,
  type MessagePayload,
} from "@/server/fns/conversations";
import { chatTurn, type ChatMessage } from "./chat";
import { emptyExtras, type ChatEvent } from "./events";

/** Resolve the cookie session for the in-repo UI's `/api/chat/stream` calls. */
async function userFromCookie(request: Request): Promise<PublicUser | null> {
  const session = verifySession(readCookie(request, SESSION_COOKIE));
  if (!session) return null;
  const row = await findUserById(session.uid);
  return row ? toPublicUser(row) : null;
}

/**
 * The streaming chat endpoint, served straight off the raw fetch handler in `src/server.ts`.
 *
 * Not a TanStack server fn: those serialise a whole return value, which is precisely the shape that
 * forced a user to watch a static spinner through five model round-trips. This writes newline-
 * delimited `ChatEvent` JSON as the turn happens.
 *
 * Two callers, two ways of learning who is asking:
 *
 * - the in-repo UI posts to `/api/chat/stream` with a session cookie, already vetted by
 *   `handleAuth`; `actor` is omitted and the session is re-read here, because there is no
 *   server-fn request context to call `currentUser()` from.
 * - the Base44 frontend posts to `/api/v1/chat/stream`, where `src/server/api/http.ts` has already
 *   verified the bearer token and resolved the actor from its identity header, and passes it in.
 *
 * Either way the approval check below is the one that matters, and NDJSON survives the Base44
 * proxy because `base44.functions.fetch()` hands back the raw `Response` body.
 */
export async function handleChatStream(
  request: Request,
  actor?: PublicUser | null,
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const user = actor === undefined ? await userFromCookie(request) : actor;
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (user.status !== "approved") return new Response("Forbidden", { status: 403 });

  let body: { conversationId?: unknown; message?: unknown };
  try {
    body = (await request.json()) as { conversationId?: unknown; message?: unknown };
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return new Response("Empty message", { status: 400 });
  const requestedId = typeof body.conversationId === "string" ? body.conversationId : null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (e: ChatEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          closed = true; // client hung up mid-turn; the turn still finishes and persists
        }
      };

      try {
        // An unknown or foreign conversation id silently starts a fresh thread rather than leaking
        // that it exists.
        const prior = requestedId ? await getConversationFull(user.id, requestedId) : null;
        const conversationId = prior
          ? (requestedId as string)
          : await createConversation(user.id, message);
        send({ type: "start", conversationId });

        const history: ChatMessage[] = [
          ...(prior ?? []).map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.payload?.replay?.length ? { toolResults: m.payload.replay } : {}),
          })),
          { role: "user", content: message },
        ];

        const result = await chatTurn(history, { userId: user.id, role: user.role }, send);

        if (result.error) {
          send({ type: "error", message: result.error });
        } else {
          send({ type: "done", costUsd: result.costUsd, toolCalls: result.toolCalls });
        }

        const payload: MessagePayload = {
          ...emptyExtras(),
          cards: result.cards,
          series: result.series,
          report: result.report,
          toolCalls: result.toolCalls,
          replay: result.replay,
          model: result.model,
          usage: result.usage,
          ...(result.error ? { error: result.error } : {}),
        };
        await appendTurn(conversationId, message, {
          content: result.reply,
          payload,
          costUsd: result.costUsd,
        });
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the client aborting
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no", // nginx sits in front in prod and would otherwise buffer the stream
    },
  });
}
