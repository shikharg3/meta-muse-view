import { createServerFn } from "@tanstack/react-start";
import type { ClientReportInput } from "@/server/agent/report";
import { generateReportForCaller } from "@/server/fns/reports";

/** Direct report generation for the UI builder (bypasses the LLM). Auth + markup scoping live in
 *  `generateReportForCaller`, so this stays the thin wrapper every `lib/api` module is. */
export const generateClientReport = createServerFn({ method: "POST" })
  .inputValidator((d: ClientReportInput) => d)
  .handler(({ data }) => generateReportForCaller(data));
