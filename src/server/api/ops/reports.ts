import { z } from "zod";
import {
  createReportRun,
  deleteTemplate,
  fetchReportRun,
  fetchReportRuns,
  fetchTemplates,
  generateReportForCaller,
  markReportExported,
  saveTemplate,
} from "@/server/fns/reports";
import { defineOp } from "../registry";
import { idOnly, ymd } from "../schemas";

/**
 * Report template, run, and generation ops.
 *
 * Every delegate calls `requireApproved()` itself, so no op adds a check — the guard is in the
 * delegate precisely so it cannot be lost with the transport it used to sit behind.
 */

/**
 * `ClientReportInput` (`@/server/agent/report`). `splitByDay` is the pre-`time_increment` spelling
 * and is still accepted, because templates and frozen runs saved before `timeIncrement` existed
 * carry it.
 */
const clientReportInput = z.object({
  clientId: z.string().min(1),
  preset: z.string().optional(),
  days: z.number().optional(),
  since: ymd.optional(),
  until: ymd.optional(),
  columns: z.array(z.string()),
  breakdown: z.string(),
  timeIncrement: z.string().optional(),
  splitByDay: z.boolean().optional(),
  markup: z.number().optional(),
  campaignIds: z.array(z.string()).optional(),
});

/**
 * `TemplateInput` (`@/server/fns/reports`). The nullable-and-optional fields are not redundant:
 * `saveTemplate` writes what it is given, so `null` clears the column while an absent key leaves
 * the stored value alone.
 */
const templateInput = z.object({
  id: z.string().nullable().optional(),
  name: z.string(),
  clientId: z.string().nullable().optional(),
  columns: z.array(z.string()),
  breakdown: z.string().optional(),
  timeIncrement: z.string().optional(),
  markup: z.number().nullable().optional(),
  rangePreset: z.string().nullable().optional(),
  campaignIds: z.array(z.string()).nullable().optional(),
});

export const listReportTemplates = defineOp({
  name: "listReportTemplates",
  mode: "read",
  handler: () => fetchTemplates(),
});

export const listReportRuns = defineOp({
  name: "listReportRuns",
  mode: "read",
  input: z.object({
    clientId: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }),
  handler: (input) => fetchReportRuns(input),
});

export const getReportRun = defineOp({
  name: "getReportRun",
  mode: "read",
  input: idOnly,
  handler: (input) => fetchReportRun(input),
});

export const saveReportTemplate = defineOp({
  name: "saveReportTemplate",
  mode: "write",
  input: templateInput,
  handler: (input) => saveTemplate(input),
});

export const deleteReportTemplate = defineOp({
  name: "deleteReportTemplate",
  mode: "write",
  input: idOnly,
  handler: (input) => deleteTemplate(input),
});

export const startReportRun = defineOp({
  name: "startReportRun",
  mode: "write",
  input: clientReportInput.extend({ templateId: z.string().nullable().optional() }),
  handler: (input) => createReportRun(input),
});

export const stampReportExport = defineOp({
  name: "stampReportExport",
  mode: "write",
  input: z.object({ runId: z.string().min(1), format: z.enum(["csv", "pdf"]) }),
  handler: (input) => markReportExported(input),
});

/**
 * `read` despite the historical POST: the client-page builder's ad-hoc report is generated and
 * returned, never persisted (that is `startReportRun`). The method was POST only because the input
 * is a large object.
 */
export const generateClientReport = defineOp({
  name: "generateClientReport",
  mode: "read",
  input: clientReportInput,
  handler: (input) => generateReportForCaller(input),
});
