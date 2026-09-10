import { createServerFn } from "@tanstack/react-start";
import type { ClientReportInput } from "@/server/agent/report";
import type { TemplateInput } from "@/server/fns/reports";
import * as ops from "@/server/api/ops/reports";

// ── Reads

export const listReportTemplates = createServerFn({ method: "GET" }).handler(() =>
  ops.listReportTemplates.run(undefined),
);

export const listReportRuns = createServerFn({ method: "GET" })
  .inputValidator((d: { clientId?: string; limit?: number }) => d)
  .handler(({ data }) => ops.listReportRuns.run(data));

export const getReportRun = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.getReportRun.run(data));

// ── Templates

export const saveReportTemplate = createServerFn({ method: "POST" })
  .inputValidator((d: TemplateInput) => d)
  .handler(({ data }) => ops.saveReportTemplate.run(data));

export const deleteReportTemplate = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.deleteReportTemplate.run(data));

// ── Runs

export const startReportRun = createServerFn({ method: "POST" })
  .inputValidator((d: ClientReportInput & { templateId?: string | null }) => d)
  .handler(({ data }) => ops.startReportRun.run(data));

export const stampReportExport = createServerFn({ method: "POST" })
  .inputValidator((d: { runId: string; format: "csv" | "pdf" }) => d)
  .handler(({ data }) => ops.stampReportExport.run(data));
