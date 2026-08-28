import { createServerFn } from "@tanstack/react-start";
import type { ClientReportInput } from "@/server/agent/report";
import {
  createReportRun,
  deleteTemplate,
  fetchReportRun,
  fetchReportRuns,
  fetchTemplates,
  markReportExported,
  saveTemplate,
  type TemplateInput,
} from "@/server/fns/reports";

// ── Reads

export const listReportTemplates = createServerFn({ method: "GET" }).handler(() =>
  fetchTemplates(),
);

export const listReportRuns = createServerFn({ method: "GET" })
  .inputValidator((d: { clientId?: string; limit?: number }) => d)
  .handler(({ data }) => fetchReportRuns(data));

export const getReportRun = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => fetchReportRun(data));

// ── Templates

export const saveReportTemplate = createServerFn({ method: "POST" })
  .inputValidator((d: TemplateInput) => d)
  .handler(({ data }) => saveTemplate(data));

export const deleteReportTemplate = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteTemplate(data));

// ── Runs

export const startReportRun = createServerFn({ method: "POST" })
  .inputValidator((d: ClientReportInput & { templateId?: string | null }) => d)
  .handler(({ data }) => createReportRun(data));

export const stampReportExport = createServerFn({ method: "POST" })
  .inputValidator((d: { runId: string; format: "csv" | "pdf" }) => d)
  .handler(({ data }) => markReportExported(data));
