import { createServerFn } from "@tanstack/react-start";
import { reportForClient, type ClientReportInput } from "@/server/agent/report";

/** Direct report generation for the UI builder (bypasses the LLM). */
export const generateClientReport = createServerFn({ method: "POST" })
  .inputValidator((d: ClientReportInput) => d)
  .handler(({ data }) => reportForClient(data));
