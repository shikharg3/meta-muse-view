import { z } from "zod";
import { runAsActor } from "@/lib/auth/actor";
import { getChatCredentials } from "@/lib/credentials";
import { runAsPortalActor } from "@/portal/context";
import { portalScope, type PortalActor } from "@/portal/scope";
import {
  InFlightTurns,
  PORTAL_CHAT_DAILY_TURNS,
  PORTAL_CHAT_MAX_IN_FLIGHT,
  finishPortalTurn,
  reservePortalTurn,
} from "@/server/fns/portal-chat";
import { AnthropicClient } from "../anthropic";
import { failedTurn, runAgentLoop, type ChatMessage, type TurnOutcome } from "../chat";
import type { ChatEvent, ToolTrace } from "../events";
import { buildPortalSystemPrompt, buildPortalVolatileContext } from "./prompt";
import { bindPortalBrand, portalToolbox, type BrandBinding } from "./tools";

/**
 * One portal assistant turn, end to end: validate, bind to a brand, meter, stream, log.
 *
 * Served as `POST /api/v1/portal/chat/stream` to customers and as
 * `POST /api/v1/viewPortalAs/chat/stream` to an admin previewing a customer — the SAME function in
 * both cases, so a preview shows exactly what the customer would get. The transport
 * (`src/server/api/http.ts`) has already resolved and approved whoever `actor` is.
 *
 * The conversation is held by the browser and sent whole each turn. The server keeps no thread to
 * look up, so there is no conversation id a request could name that belongs to somebody else, and
 * nothing the browser sends can widen a turn: its messages are text only (no tool results are
 * accepted back), and the brand it names is checked against the caller's own scope.
 */

/** Model effort for customer turns. Portal questions are dashboard questions, not investigations. */
export const PORTAL_CHAT_EFFORT = "medium";
/** Model round-trips per turn. At most the staff loop's `MAX_ITERATIONS`, never more. */
export const PORTAL_MAX_ITERATIONS = 5;
/** Tools run per turn, across all round-trips — see `LoopOptions.maxToolCalls`. */
export const PORTAL_MAX_TOOL_CALLS = 12;
/** Longest new question, in characters. */
export const MAX_QUESTION_CHARS = 2000;
/** Longest replayed message (assistant answers run longer than questions), in characters. */
const MAX_MESSAGE_CHARS = 8000;
/** Messages per request, question included. The browser sends its last 20. */
export const MAX_HISTORY_MESSAGES = 20;
/**
 * All messages together, in characters. The per-message bound alone would allow 160k characters of
 * replayed "history" — none of it logged, all of it paid for as input on every round-trip.
 */
export const MAX_HISTORY_CHARS = 40_000;

/** Running turns per requester, capped at `PORTAL_CHAT_MAX_IN_FLIGHT`. One per process. */
const inFlight = new InFlightTurns(PORTAL_CHAT_MAX_IN_FLIGHT);

const chatBody = z.object({
  brandId: z.string().min(1).max(256),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(MAX_MESSAGE_CHARS),
      }),
    )
    .min(1)
    .max(MAX_HISTORY_MESSAGES),
});

export interface PortalChatRequest {
  brandId: string;
  /** Ends with the customer's question. */
  messages: ChatMessage[];
}

/** Parse and bound a request body; a string is the reason it was refused. */
export function parsePortalChat(raw: unknown): PortalChatRequest | string {
  const parsed = chatBody.safeParse(raw);
  if (!parsed.success) {
    return `Send { brandId, messages } with at most ${MAX_HISTORY_MESSAGES} messages of up to ${MAX_MESSAGE_CHARS} characters each.`;
  }
  const { brandId, messages } = parsed.data;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return "The last message must be the question.";
  const question = last.content.trim();
  if (!question) return "Ask a question first.";
  if (question.length > MAX_QUESTION_CHARS) {
    return `Questions are limited to ${MAX_QUESTION_CHARS} characters.`;
  }
  if (messages.reduce((sum, m) => sum + m.content.length, 0) > MAX_HISTORY_CHARS) {
    return "This conversation is too long to continue. Start a new chat.";
  }
  return {
    brandId,
    messages: [
      ...messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: question },
    ],
  };
}

/**
 * What a customer's browser receives: the staff assistant's `ChatEvent`s that are about the answer
 * itself, and `done` stripped of `costUsd` — what a turn costs the agency is not the customer's
 * business. Never `start` (there is no server-side thread) or `report` (it carries an internal
 * markup). Named member by member, so an event added to the staff union is not a customer event
 * until it is added here.
 */
export type PortalChatEvent =
  | Extract<
      ChatEvent,
      { type: "status" | "tool_start" | "tool_end" | "delta" | "cards" | "series" | "error" }
    >
  | { type: "done"; toolCalls: ToolTrace[] };

/**
 * The only way an event reaches a customer. Exhaustive with no default: a new `ChatEvent` member
 * fails to compile here until someone decides whether a customer may see it.
 */
export function toCustomerEvent(e: ChatEvent): PortalChatEvent | null {
  switch (e.type) {
    case "status":
    case "tool_start":
    case "tool_end":
    case "delta":
    case "cards":
    case "series":
    case "error":
      return e;
    case "done":
      return { type: "done", toolCalls: e.toolCalls };
    case "start":
    case "report":
      return null;
  }
}

/** Refusal in the transport's error envelope. */
const refuse = (status: number, code: string, message: string): Response =>
  Response.json({ ok: false, error: { code, message } }, { status });

const UNAVAILABLE = "The assistant isn't available right now. Please try again later.";
const FAILED = "Something went wrong while answering. Please try again.";

/**
 * Answer one turn for `actor` as an NDJSON stream of `PortalChatEvent`s.
 *
 * `viewedBy` is the previewing admin's `users.id`, or null when the customer is asking. A preview is
 * logged against the customer but not metered against their daily limit.
 */
export async function handlePortalChat(
  actor: PortalActor,
  raw: unknown,
  viewedBy: string | null,
): Promise<Response> {
  const request = parsePortalChat(raw);
  if (typeof request === "string") return refuse(400, "bad_request", request);

  // The staff context is explicitly empty and the portal actor set, exactly as for a `portal*` op:
  // any staff check reached from here fails closed.
  const asCustomer = <T>(fn: () => Promise<T>): Promise<T> =>
    runAsActor(null, () => runAsPortalActor(actor, fn));

  let binding: BrandBinding | null;
  try {
    binding = bindPortalBrand(await asCustomer(() => portalScope(actor)), request.brandId);
  } catch (e) {
    console.error("[portal-ai] scope lookup failed", e);
    return refuse(503, "internal", "Your brands could not be loaded just now.");
  }
  // One answer for "not yours" and "does not exist": which ids are somebody's brand is not ours to
  // confirm.
  if (!binding) return refuse(403, "brand_forbidden", "You don't have access to this brand.");

  // Held until the turn's server-side work ends, NOT until the browser hangs up: Stop does not stop
  // the model, so releasing on abort would let a script abort and re-fire past the cap. A preview is
  // keyed by the previewing admin, so it neither blocks nor is blocked by the client's own turns.
  const release = inFlight.claim(viewedBy === null ? actor.id : `preview:${viewedBy}`);
  if (!release) {
    return refuse(
      429,
      "too_many_in_flight",
      "Another answer is still being written. Wait for it to finish, then ask again.",
    );
  }

  const bound: BrandBinding = binding;
  const { brand } = bound;
  const question = request.messages[request.messages.length - 1].content;

  let turnId: string;
  try {
    const reservation = await reservePortalTurn({
      portalUserId: actor.id,
      brandId: brand.id,
      question,
      viewedBy,
    });
    if (!reservation.ok) {
      release();
      return refuse(
        429,
        "daily_limit",
        `You've asked ${PORTAL_CHAT_DAILY_TURNS} questions today, which is the daily limit. It resets at midnight UTC.`,
      );
    }
    turnId = reservation.id;
  } catch (e) {
    release();
    console.error("[portal-ai] turn reservation failed", e);
    return refuse(503, "internal", "The assistant isn't available right now.");
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (e: PortalChatEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          closed = true; // the browser hung up (Stop); the turn still finishes and is logged
        }
      };
      const forward = (e: ChatEvent) => {
        const out = toCustomerEvent(e);
        if (out) send(out);
      };

      // Whatever happens below, the reserved row is filled in exactly once.
      let outcome: TurnOutcome = failedTurn("stream failed");
      let model: string | null = null;
      try {
        const creds = await getChatCredentials();
        if (!creds) {
          outcome = failedTurn("No Claude API key configured.");
          send({ type: "error", message: UNAVAILABLE });
          return;
        }
        model = creds.model;
        try {
          outcome = await asCustomer(() =>
            runAgentLoop(
              new AnthropicClient(creds.token),
              buildPortalSystemPrompt(brand.name),
              request.messages,
              {
                model: creds.model,
                effort: PORTAL_CHAT_EFFORT,
                toolbox: portalToolbox(bound),
                volatile: buildPortalVolatileContext(brand.name),
                maxIterations: PORTAL_MAX_ITERATIONS,
                maxToolCalls: PORTAL_MAX_TOOL_CALLS,
                emit: forward,
              },
            ),
          );
        } catch (e) {
          console.error(`[portal-ai] turn failed for ${actor.email} / ${brand.id}`, e);
          outcome = failedTurn(e instanceof Error ? e.message : String(e));
        }

        // The raw failure (an upstream status, a stack) goes to the log, never to the customer.
        if (outcome.error) forward({ type: "error", message: FAILED });
        else forward({ type: "done", costUsd: outcome.costUsd, toolCalls: outcome.toolCalls });
      } catch (e) {
        console.error("[portal-ai] stream failed", e);
        send({ type: "error", message: FAILED });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the browser aborting
        }
        await finishPortalTurn(turnId, {
          answer: outcome.reply,
          toolCalls: outcome.toolCalls,
          error: outcome.error ?? null,
          model: outcome.model || model,
          costUsd: outcome.costUsd,
        }).catch((e: unknown) => console.error("[portal-ai] turn log failed", e));
        release();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no", // nginx would otherwise buffer the stream
    },
  });
}
