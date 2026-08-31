import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resolvePreset } from "@/lib/date-presets";
import { metric } from "@/lib/report-catalog";
import { resolveTimeIncrement, type TimeIncrement } from "@/lib/time-increment";
import {
  reportForClient,
  resolveRange,
  type ClientReportInput,
  type ReportPayload,
} from "@/server/agent/report";
import { audit, requireAdmin } from "./auth";

// Idempotent prod migration (run once on the droplet before deploying):
//
//   CREATE TABLE IF NOT EXISTS report_templates (
//     id text PRIMARY KEY,
//     name text NOT NULL,
//     client_id text REFERENCES clients(id) ON DELETE CASCADE,
//     columns jsonb NOT NULL,
//     breakdown text NOT NULL DEFAULT 'none',
//     time_increment text NOT NULL DEFAULT 'all_days',
//     markup double precision,
//     range_preset text,
//     campaign_ids jsonb,
//     created_by text REFERENCES users(id) ON DELETE SET NULL,
//     created_at timestamptz NOT NULL DEFAULT now(),
//     updated_at timestamptz NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS report_templates_client_idx ON report_templates (client_id);
//
//   CREATE TABLE IF NOT EXISTS report_runs (
//     id text PRIMARY KEY,
//     template_id text REFERENCES report_templates(id) ON DELETE SET NULL,
//     client_id text NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
//     params jsonb NOT NULL,
//     payload jsonb NOT NULL,
//     since date NOT NULL,
//     until date NOT NULL,
//     row_count integer NOT NULL,
//     ran_by text REFERENCES users(id) ON DELETE SET NULL,
//     created_at timestamptz NOT NULL DEFAULT now(),
//     exported_at timestamptz,
//     exported_formats jsonb
//   );
//   CREATE INDEX IF NOT EXISTS report_runs_exported_idx ON report_runs (exported_at, created_at);
//   CREATE INDEX IF NOT EXISTS report_runs_client_idx ON report_runs (client_id, exported_at);
//
// Migration for tables created before `time_increment` replaced the split-by-day boolean. Meta has
// no boolean here — the axis is `all_days | 1 | 7 | 28 | monthly` — and summing daily rows into a
// wider one silently double-counts every de-duplicated metric, so the column had to become the
// granularity itself rather than a flag beside it:
//
//   ALTER TABLE report_templates ADD COLUMN IF NOT EXISTS time_increment text;
//   UPDATE report_templates SET time_increment = CASE WHEN split_by_day THEN '1' ELSE 'all_days' END
//     WHERE time_increment IS NULL;
//   ALTER TABLE report_templates ALTER COLUMN time_increment SET DEFAULT 'all_days';
//   ALTER TABLE report_templates ALTER COLUMN time_increment SET NOT NULL;
//   ALTER TABLE report_templates DROP COLUMN IF EXISTS split_by_day;

/** Drafts older than this are pruned by the sync worker — see `pruneReportDrafts`. */
const DRAFT_RETENTION_DAYS = 7;

export interface TemplateInput {
  id?: string | null;
  name: string;
  clientId?: string | null;
  columns: string[];
  breakdown?: string;
  /** Meta's `time_increment`. */
  timeIncrement?: string;
  markup?: number | null;
  rangePreset?: string | null;
  campaignIds?: string[] | null;
}

/**
 * A stored template as the UI reads it.
 *
 * Every optional of `TemplateInput` is narrowed to what a row always holds, so a consumer never has
 * to re-apply the column defaults that `saveTemplate` already resolved.
 */
export interface TemplateView extends TemplateInput {
  id: string;
  clientId: string | null;
  clientName: string | null;
  breakdown: string;
  timeIncrement: TimeIncrement;
  markup: number | null;
  rangePreset: string | null;
  campaignIds: string[] | null;
  updatedAt: string;
}

export interface RunSummary {
  id: string;
  clientId: string;
  clientName: string;
  since: string;
  until: string;
  rowCount: number;
  exportedAt: string | null;
  exportedFormats: string[];
  ranByEmail: string | null;
  templateName: string | null;
}

export interface RunDetail extends RunSummary {
  payload: ReportPayload;
  /**
   * The input this run was produced from, replayable into the builder. Concrete rather than
   * `unknown` because the server-fn serializer rejects it (see `lib/api/reports.ts`).
   */
  params: ClientReportInput;
}

/** jsonb columns are bare by convention (`schema.ts`), so every read narrows at the read site. */
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Pure validation, split out so the rules are tested without a database. */
export function validateTemplate(input: TemplateInput): { ok: boolean; error?: string } {
  if (!input.name.trim()) return { ok: false, error: "Name is required" };
  const cols = input.columns.filter((k) => metric(k) !== undefined);
  if (cols.length === 0) return { ok: false, error: "Pick at least one column" };
  if (input.campaignIds?.length && !input.clientId) {
    return { ok: false, error: "Campaign filters need a client-bound template" };
  }
  // Any valid day proves a preset KEY exists; which day it resolves against is decided at run time.
  if (input.rangePreset && !resolvePreset(input.rangePreset, "2026-01-01")) {
    return { ok: false, error: `Unknown date preset: ${input.rangePreset}` };
  }
  return { ok: true };
}

/** Append a format, keeping the array a set and preserving first-export order. */
export function nextExportFormats(current: unknown, format: string): string[] {
  const list = asStringArray(current);
  return list.includes(format) ? list : [...list, format];
}

export async function fetchTemplates(): Promise<TemplateView[]> {
  await requireAdmin();
  const rows = await db
    .select({
      id: schema.reportTemplates.id,
      name: schema.reportTemplates.name,
      clientId: schema.reportTemplates.clientId,
      clientName: schema.clients.name,
      columns: schema.reportTemplates.columns,
      breakdown: schema.reportTemplates.breakdown,
      timeIncrement: schema.reportTemplates.timeIncrement,
      markup: schema.reportTemplates.markup,
      rangePreset: schema.reportTemplates.rangePreset,
      campaignIds: schema.reportTemplates.campaignIds,
      updatedAt: schema.reportTemplates.updatedAt,
    })
    .from(schema.reportTemplates)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.reportTemplates.clientId))
    .orderBy(schema.reportTemplates.name);
  return rows.map((r) => ({
    ...r,
    clientName: r.clientName ?? null,
    columns: asStringArray(r.columns),
    // Absent, not empty: a generic template stores NULL, and `[]` would read as "no campaigns".
    campaignIds: r.campaignIds === null ? null : asStringArray(r.campaignIds),
    // A row written before the column existed, or by a future version, still has to resolve to a
    // granularity the engine understands rather than reach the builder as an unknown string.
    timeIncrement: resolveTimeIncrement(r.timeIncrement),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/**
 * Create or update a template.
 *
 * `columns` is stored in the user's order — the picker's order IS the report's column order — and
 * filtered to known catalog keys, because a stale key would otherwise survive into every future run
 * and silently drop a column at report time.
 */
export async function saveTemplate(
  input: TemplateInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const user = await requireAdmin();
  const valid = validateTemplate(input);
  if (!valid.ok) return valid;

  const clientId = input.clientId?.trim() || null;
  if (clientId) {
    const [client] = await db
      .select({ id: schema.clients.id })
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId));
    if (!client) return { ok: false, error: "Client must be a known client" };
  }

  const name = input.name.trim();
  const fields = {
    name,
    clientId,
    columns: input.columns.filter((k) => metric(k) !== undefined),
    breakdown: input.breakdown?.trim() || "none",
    timeIncrement: resolveTimeIncrement(input.timeIncrement),
    markup: input.markup ?? null,
    rangePreset: input.rangePreset?.trim() || null,
    // `validateTemplate` already rejects campaign ids without a client, so this is not that check.
    // It catches the narrower case the validator cannot see: a whitespace-only clientId passes there
    // as a truthy string but normalises to null at line 172, and ids scoped to no client are noise.
    campaignIds: clientId && input.campaignIds?.length ? input.campaignIds : null,
    updatedAt: new Date(),
  };

  let id: string;
  if (input.id) {
    const [existing] = await db
      .select({ id: schema.reportTemplates.id })
      .from(schema.reportTemplates)
      .where(eq(schema.reportTemplates.id, input.id));
    if (!existing) return { ok: false, error: "Template not found" };
    id = input.id;
    await db.update(schema.reportTemplates).set(fields).where(eq(schema.reportTemplates.id, id));
  } else {
    id = randomUUID();
    await db.insert(schema.reportTemplates).values({ ...fields, id, createdBy: user.id });
  }

  await audit("report.template.save", `${name} (${id})`);
  return { ok: true, id };
}

/** No dependency check: `report_runs.template_id` is SET NULL, so history survives the delete. */
export async function deleteTemplate(input: {
  id: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const deleted = await db
    .delete(schema.reportTemplates)
    .where(eq(schema.reportTemplates.id, input.id))
    .returning({ name: schema.reportTemplates.name });
  if (deleted.length === 0) return { ok: false, error: "Template not found" };
  await audit("report.template.delete", `${deleted[0].name} (${input.id})`);
  return { ok: true };
}

// Selected by both run reads, so the summary shape can never drift between the list and the detail.
const RUN_SUMMARY_FIELDS = {
  id: schema.reportRuns.id,
  clientId: schema.reportRuns.clientId,
  clientName: schema.clients.name,
  since: schema.reportRuns.since,
  until: schema.reportRuns.until,
  rowCount: schema.reportRuns.rowCount,
  exportedAt: schema.reportRuns.exportedAt,
  exportedFormats: schema.reportRuns.exportedFormats,
  ranByEmail: schema.users.email,
  templateName: schema.reportTemplates.name,
};

function toRunSummary(r: {
  id: string;
  clientId: string;
  clientName: string | null;
  since: string;
  until: string;
  rowCount: number;
  exportedAt: Date | null;
  exportedFormats: unknown;
  ranByEmail: string | null;
  templateName: string | null;
}): RunSummary {
  return {
    ...r,
    // `client_id` is NOT NULL with ON DELETE RESTRICT, so the join cannot miss; falling back to the
    // slug keeps the row identifiable instead of blank if it ever does.
    clientName: r.clientName ?? r.clientId,
    exportedAt: r.exportedAt?.toISOString() ?? null,
    exportedFormats: asStringArray(r.exportedFormats),
  };
}

export async function fetchReportRuns(input?: {
  clientId?: string;
  limit?: number;
}): Promise<RunSummary[]> {
  await requireAdmin();
  // Exported runs only. An unexported row is a draft somebody generated and walked away from; the
  // history tab is the ledger of what clients actually received, not of every button press.
  const exported = isNotNull(schema.reportRuns.exportedAt);
  const rows = await db
    .select(RUN_SUMMARY_FIELDS)
    .from(schema.reportRuns)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.reportRuns.clientId))
    .leftJoin(schema.users, eq(schema.users.id, schema.reportRuns.ranBy))
    .leftJoin(schema.reportTemplates, eq(schema.reportTemplates.id, schema.reportRuns.templateId))
    .where(
      input?.clientId ? and(exported, eq(schema.reportRuns.clientId, input.clientId)) : exported,
    )
    .orderBy(desc(schema.reportRuns.createdAt))
    .limit(input?.limit ?? 100);
  return rows.map(toRunSummary);
}

/** No `exported_at` filter, unlike the list: the builder reads back the draft it just created. */
export async function fetchReportRun(input: { id: string }): Promise<RunDetail | null> {
  await requireAdmin();
  const [row] = await db
    .select({
      ...RUN_SUMMARY_FIELDS,
      params: schema.reportRuns.params,
      payload: schema.reportRuns.payload,
    })
    .from(schema.reportRuns)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.reportRuns.clientId))
    .leftJoin(schema.users, eq(schema.users.id, schema.reportRuns.ranBy))
    .leftJoin(schema.reportTemplates, eq(schema.reportTemplates.id, schema.reportRuns.templateId))
    .where(eq(schema.reportRuns.id, input.id));
  if (!row) return null;
  return {
    ...toRunSummary(row),
    params: row.params as ClientReportInput,
    payload: row.payload as ReportPayload,
  };
}

/**
 * Generate a report and record it as a draft.
 *
 * The engine stays in `reportForClient` — this only persists what came back. `exported_at` is left
 * NULL so nothing is claimed to have reached the client until an export actually happens; the row
 * is a draft the worker prunes after a week if it never does.
 */
export async function createReportRun(
  input: ClientReportInput & { templateId?: string | null },
): Promise<{ ok: true; runId: string; payload: ReportPayload } | { ok: false; error: string }> {
  const user = await requireAdmin();
  const { templateId = null, ...params } = input;
  // Resolved here, not read back off the payload: the row stores the concrete window a preset stood
  // for on the day it ran, which is what the history list filters and displays.
  const range = resolveRange(params);
  if (!range) return { ok: false, error: "Pick a valid date range." };

  const payload = await reportForClient(params);
  if ("error" in payload) return { ok: false, error: payload.error };

  const runId = randomUUID();
  await db.insert(schema.reportRuns).values({
    id: runId,
    templateId,
    clientId: params.clientId,
    params,
    payload,
    since: range.since,
    until: range.until,
    rowCount: payload.rowCount,
    ranBy: user.id,
    exportedAt: null,
  });
  return { ok: true, runId, payload };
}

/**
 * Stamp a run as delivered.
 *
 * `exported_at` is the moment the client FIRST received the report, so a second export of the same
 * run appends its format without re-dating the row — otherwise re-downloading a March report in May
 * would file it under May.
 */
export async function markReportExported(input: {
  runId: string;
  format: "csv" | "pdf";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const [row] = await db
    .select({
      exportedAt: schema.reportRuns.exportedAt,
      exportedFormats: schema.reportRuns.exportedFormats,
    })
    .from(schema.reportRuns)
    .where(eq(schema.reportRuns.id, input.runId));
  if (!row) return { ok: false, error: "Report run not found" };
  await db
    .update(schema.reportRuns)
    .set({
      exportedAt: row.exportedAt ?? new Date(),
      exportedFormats: nextExportFormats(row.exportedFormats, input.format),
    })
    .where(eq(schema.reportRuns.id, input.runId));
  return { ok: true };
}

/**
 * Drop never-exported drafts. Called from the sync worker's daily gate, so deliberately WITHOUT
 * `requireAdmin()` — there is no session cookie in the worker process.
 *
 * Only drafts are touched: an exported run is the frozen record of what a client received and is
 * kept indefinitely. Cutoff computed in JS to match the sibling prune (`pruneSyncEvents` in
 * `src/sync/state.ts`) rather than introduce a second style; worker and Postgres share the droplet.
 */
export async function pruneReportDrafts(): Promise<number> {
  const cutoff = new Date(Date.now() - DRAFT_RETENTION_DAYS * 86_400_000);
  const deleted = await db
    .delete(schema.reportRuns)
    .where(and(isNull(schema.reportRuns.exportedAt), lt(schema.reportRuns.createdAt, cutoff)))
    .returning({ id: schema.reportRuns.id });
  return deleted.length;
}
