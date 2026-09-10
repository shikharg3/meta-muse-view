import { createServerFn } from "@tanstack/react-start";
import type { ClientReportInput } from "@/server/agent/report";
import * as ops from "@/server/api/ops/reports";

/** Direct report generation for the UI builder (bypasses the LLM). Auth + markup scoping live in
 *  the op's delegate, so this stays the thin wrapper every `lib/api` module is. The op itself lives
 *  in `ops/reports` alongside the other report ops; only this wrapper keeps its own file. */
export const generateClientReport = createServerFn({ method: "POST" })
  .inputValidator((d: ClientReportInput) => d)
  .handler(({ data }) => ops.generateClientReport.run(data));
