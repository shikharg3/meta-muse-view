import { currentUser } from "./auth";
import {
  getConversation,
  createConversation,
  appendTurn,
  type StoredMessage,
  type MessagePayload,
} from "./conversations";
import { chatTurn, type ChatMessage } from "@/server/agent/chat";
import type { ChatResult } from "@/server/agent/chat";
import type { ReportPayload } from "@/server/agent/report";

export interface ChatSendResult {
  conversationId: string;
  reply: string;
  cards: ChatResult["cards"];
  report: ChatResult["report"];
  toolCalls: ChatResult["toolCalls"];
  costUsd: number;
  error?: string;
}

/** One chat turn against a new-or-existing conversation: load the prior messages (server-owned so it
 *  survives reloads / other devices), run the agent, persist the user + assistant turn with its rich
 *  payload + cost, and return the reply. Everything is scoped to the signed-in user. */
export async function sendChatTurn(input: {
  conversationId: string | null;
  message: string;
}): Promise<ChatSendResult> {
  const me = await currentUser();
  const message = input.message.trim();
  const fail = (error: string): ChatSendResult => ({
    conversationId: input.conversationId ?? "",
    reply: "",
    cards: null,
    report: null,
    toolCalls: [],
    costUsd: 0,
    error,
  });
  if (!me) return fail("You're not signed in.");
  if (!message) return fail("Empty message.");

  let conversationId = input.conversationId;
  let prior: StoredMessage[] = [];
  if (conversationId) {
    const msgs = await getConversation(me.id, conversationId);
    if (msgs === null)
      conversationId = null; // unknown / not owned → start a fresh conversation
    else prior = msgs;
  }
  if (!conversationId) conversationId = await createConversation(me.id, message);

  const history: ChatMessage[] = [
    ...prior.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];
  const result = await chatTurn(history);

  const payload: MessagePayload = {
    cards: result.cards,
    report: result.report,
    toolCalls: result.toolCalls,
    error: result.error,
  };
  await appendTurn(conversationId, message, {
    content: result.reply,
    payload,
    costUsd: result.costUsd,
  });

  return {
    conversationId,
    reply: result.reply,
    cards: result.cards,
    report: result.report,
    toolCalls: result.toolCalls,
    costUsd: result.costUsd,
    error: result.error,
  };
}

/** Persist a builder-generated report as a turn in the thread (no LLM cost) so it restores later. */
export async function saveReportTurn(input: {
  conversationId: string | null;
  summary: string;
  clientName: string;
  report: ReportPayload;
}): Promise<{ conversationId: string }> {
  const me = await currentUser();
  if (!me) throw new Error("You're not signed in.");
  let conversationId = input.conversationId;
  if (conversationId && (await getConversation(me.id, conversationId)) === null)
    conversationId = null;
  if (!conversationId)
    conversationId = await createConversation(me.id, `Report — ${input.clientName}`);

  const payload: MessagePayload = {
    cards: null,
    report: input.report,
    toolCalls: [],
  };
  await appendTurn(conversationId, `📄 Report — ${input.summary}`, {
    content: `Here's your report for ${input.clientName}.`,
    payload,
    costUsd: 0,
  });
  return { conversationId };
}
