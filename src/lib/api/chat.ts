import { createServerFn } from "@tanstack/react-start";
import { saveReportTurn } from "@/server/fns/chat";
import type { ReportPayload } from "@/server/agent/report";

// Conversational turns POST to /api/chat/stream (see src/server/agent/stream.ts) so the answer can
// render while it is still being produced. A server fn cannot do that — it returns one value.

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
