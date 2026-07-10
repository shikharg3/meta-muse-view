import { createServerFn } from "@tanstack/react-start";
import { sendChatTurn, saveReportTurn } from "@/server/fns/chat";
import type { ReportPayload } from "@/server/agent/report";

/** Send one message to a conversation (creating it if conversationId is null); the server loads
 *  history, runs the agent, persists the turn, and returns the reply + cost + conversationId. */
export const sendChat = createServerFn({ method: "POST" })
  .inputValidator((d: { conversationId: string | null; message: string }) => d)
  .handler(({ data }) => sendChatTurn(data));

/** Persist a builder-generated report into the (new or existing) conversation thread. */
export const saveReport = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      conversationId: string | null;
      summary: string;
      clientName: string;
      report: ReportPayload;
    }) => d,
  )
  .handler(({ data }) => saveReportTurn(data));
