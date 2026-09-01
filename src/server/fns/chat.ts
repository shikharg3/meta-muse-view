import { currentUser } from "./auth";
import {
  getConversation,
  createConversation,
  appendTurn,
  type MessagePayload,
} from "./conversations";
import { emptyExtras } from "@/server/agent/events";
import type { ReportPayload } from "@/server/agent/report";

/**
 * The conversational turn lives in `src/server/agent/stream.ts`, not here.
 *
 * It was a server fn returning one whole `ChatSendResult`, which is exactly what made the UI sit on a
 * spinner through every model round-trip. Only the report-builder path remains a plain fn: it makes
 * no LLM call, so there is nothing to stream.
 */

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

  const payload: MessagePayload = { ...emptyExtras(), report: input.report };
  await appendTurn(conversationId, `📄 Report — ${input.summary}`, {
    content: `Here's your report for ${input.clientName}.`,
    payload,
    costUsd: 0,
  });
  return { conversationId };
}
