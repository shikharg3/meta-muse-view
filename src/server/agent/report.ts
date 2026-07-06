import { and, eq, gte, lte, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { pickAction } from "@/meta/insights";
import { resultSpec } from "@/server/creative";
import { familyCount } from "@/server/agg";
import { trailingRange } from "@/sync/jobs/insights";
import type { InsightRow } from "@/meta/types";
import { getClientRow, effectiveAccountIds } from "@/sync/jobs/clients";
import {
  REPORT_COLUMNS,
  DEFAULT_REPORT_COLUMN_KEYS,
  type ReportColumnKind,
} from "@/lib/report-options";

export type Breakdown =
  | "none"
  | "day"
  | "platform"
  | "placement"
  | "age"
  | "gender"
  | "country"
  | "region";

type Kind = ReportColumnKind;

export interface ReportColumn {
  key: string;
  label: string;
  kind: Kind;
}

export interface ReportPayload {
  title: string;
  subtitle: string;
  note: string | null;
  columns: ReportColumn[];
  rows: (string | number)[][];
  /** Totals row aligned to columns, or null when there's only one (already-total) row. */
  totals: (string | number)[] | null;
  rowCount: number;
  filename: string;
}

interface Agg {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  results: number;
  conversions: number;
  conversionValue: number;
  events: Map<string, number>;
}

// "Results" is objective-dependent in Ads Manager (traffic→link clicks,
// leads→leads, sales→purchases, …). We query at campaign level so each row
// carries a campaign_id, map it to its objective, and count that objective's
// result action — matching what the dashboards show. omni_purchase is the
// conversion baseline used elsewhere.
const CONVERSION_TYPE = "omni_purchase";

const META_BREAKDOWN: Record<Exclude<Breakdown, "none" | "day">, string> = {
  platform: "publisher_platform",
  placement: "platform_position",
  age: "age",
  gender: "gender",
  country: "country",
  region: "region",
};
const DIM_LABEL: Record<Breakdown, string> = {
  none: "",
  day: "Date",
  platform: "Platform",
  placement: "Placement",
  age: "Age",
  gender: "Gender",
  country: "Country",
  region: "Region",
};

// Aggregate → metric value. Labels/kinds live in the client-safe report-options
// module (single source of truth shared with the column-picker UI).
const COL_META = new Map(REPORT_COLUMNS.map((c) => [c.key, c]));
const costPer = (a: Agg, label: string): number => {
  const n = familyCount(a.events, label);
  return n ? a.spend / n : 0;
};
const VALUE_FNS: Record<string, (a: Agg) => number> = {
  spend: (a) => a.spend,
  impressions: (a) => a.impressions,
  reach: (a) => a.reach,
  clicks: (a) => a.clicks,
  link_clicks: (a) => a.linkClicks,
  ctr: (a) => (a.impressions ? (a.clicks / a.impressions) * 100 : 0),
  cpc: (a) => (a.clicks ? a.spend / a.clicks : 0),
  cpm: (a) => (a.impressions ? (a.spend / a.impressions) * 1000 : 0),
  frequency: (a) => (a.reach ? a.impressions / a.reach : 0),
  results: (a) => a.results,
  cost_per_result: (a) => (a.results ? a.spend / a.results : 0),
  conversions: (a) => a.conversions,
  conversion_value: (a) => a.conversionValue,
  roas: (a) => (a.spend ? a.conversionValue / a.spend : 0),
  registrations: (a) => familyCount(a.events, "Registrations"),
  leads: (a) => familyCount(a.events, "Leads"),
  initiate_checkout: (a) => familyCount(a.events, "Checkouts initiated"),
  purchases: (a) => familyCount(a.events, "Purchases"),
  landing_page_views: (a) => familyCount(a.events, "Landing page views"),
  cost_per_registration: (a) => costPer(a, "Registrations"),
  cost_per_lead: (a) => costPer(a, "Leads"),
  cost_per_purchase: (a) => costPer(a, "Purchases"),
};

export const DEFAULT_COLUMNS = DEFAULT_REPORT_COLUMN_KEYS;

const COLUMN_ALIASES: Record<string, string> = {
  spend: "spend",
  cost: "spend",
  impressions: "impressions",
  impr: "impressions",
  imps: "impressions",
  reach: "reach",
  clicks: "clicks",
  linkclicks: "link_clicks",
  inlinelinkclicks: "link_clicks",
  ctr: "ctr",
  cpc: "cpc",
  cpm: "cpm",
  frequency: "frequency",
  freq: "frequency",
  results: "results",
  result: "results",
  costperresult: "cost_per_result",
  cpr: "cost_per_result",
  costresult: "cost_per_result",
  conversions: "conversions",
  conversion: "conversions",
  purchases: "conversions",
  conversionvalue: "conversion_value",
  convvalue: "conversion_value",
  revenue: "conversion_value",
  value: "conversion_value",
  roas: "roas",
};

/** Map free-text column names to catalog keys, dropping unknowns and dupes. */
export function normalizeColumns(input: string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const k = COLUMN_ALIASES[raw.toLowerCase().replace(/[^a-z]/g, "")];
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

export function normalizeBreakdown(input: unknown): Breakdown {
  const v = String(input ?? "").toLowerCase();
  if (v.includes("day") || v.includes("daily") || v.includes("date")) return "day";
  if (v.includes("platform") || v.includes("publisher")) return "platform";
  if (v.includes("placement") || v.includes("position")) return "placement";
  if (v.includes("age")) return "age";
  if (v.includes("gender")) return "gender";
  if (v.includes("country")) return "country";
  if (v.includes("region")) return "region";
  return "none";
}

export interface BuildSpec {
  accountIds: string[];
  since: string;
  until: string;
  columns: string[];
  breakdown: Breakdown;
  /** campaign_id → objective, for objective-aware "results". */
  objectiveByCampaign: Record<string, string>;
  /** Cost markup fraction (e.g. 0.1 = +10%) applied to spend for client-facing reports. */
  markup?: number;
  /** Restrict none/day reports to these campaign ids (empty/undefined = all campaigns). */
  campaignIds?: string[];
}

/** Supplies a report's rows for one account. Injected so buildReport stays pure and unit-testable. */
export type ReportRowSource = (accountId: string) => Promise<InsightRow[]>;

/**
 * Report rows sourced from the synced DB, not a live Meta call — reports must cover accounts that
 * are disabled or outside the current Business Manager (their history is retained locally but the
 * token can no longer query them live, which otherwise yields an empty "No data" report).
 * none/day read campaign-level insights_daily (full objective-aware results); dimension breakdowns
 * read account-level insights_breakdown_daily (no per-campaign objective, so "results" use the
 * default action type).
 */
export function dbRowSource(spec: BuildSpec): ReportRowSource {
  return async (accountId) => {
    if (spec.breakdown === "none" || spec.breakdown === "day") {
      const rows = await db
        .select()
        .from(schema.insightsDaily)
        .where(
          and(
            eq(schema.insightsDaily.level, "campaign"),
            eq(schema.insightsDaily.accountId, accountId),
            gte(schema.insightsDaily.date, spec.since),
            lte(schema.insightsDaily.date, spec.until),
            spec.campaignIds?.length
              ? inArray(schema.insightsDaily.entityId, spec.campaignIds)
              : undefined,
          ),
        );
      return rows.map(
        (r): InsightRow => ({
          date_start: r.date,
          date_stop: r.date,
          campaign_id: r.entityId,
          spend: String(r.spend),
          impressions: String(r.impressions),
          reach: String(r.reach),
          clicks: String(r.clicks),
          inline_link_clicks: String(r.inlineLinkClicks),
          actions: (r.actions ?? undefined) as InsightRow["actions"],
          action_values: (r.actionValues ?? undefined) as InsightRow["action_values"],
        }),
      );
    }
    const type = META_BREAKDOWN[spec.breakdown];
    const rows = await db
      .select()
      .from(schema.insightsBreakdownDaily)
      .where(
        and(
          eq(schema.insightsBreakdownDaily.breakdownType, type),
          eq(schema.insightsBreakdownDaily.accountId, accountId),
          gte(schema.insightsBreakdownDaily.date, spec.since),
          lte(schema.insightsBreakdownDaily.date, spec.until),
        ),
      );
    return rows.map((r): InsightRow => {
      const raw = (r.raw ?? {}) as Record<string, unknown>;
      return {
        date_start: r.date,
        date_stop: r.date,
        [type]: r.breakdownValue,
        spend: String(r.spend),
        impressions: String(r.impressions),
        reach: String(r.reach),
        clicks: String(r.clicks),
        inline_link_clicks:
          raw.inline_link_clicks != null ? String(raw.inline_link_clicks) : undefined,
        actions: (raw.actions ?? undefined) as InsightRow["actions"],
        action_values: (raw.action_values ?? undefined) as InsightRow["action_values"],
      };
    });
  };
}

/** The action type (or "reach") whose value is this row's "result", per objective. */
function resultValue(r: InsightRow, objective: string | undefined): number {
  const spec = resultSpec(objective);
  if (spec.type === "reach") return num(r.reach);
  return pickAction(r.actions, spec.type);
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);
const emptyAgg = (): Agg => ({
  spend: 0,
  impressions: 0,
  reach: 0,
  clicks: 0,
  linkClicks: 0,
  results: 0,
  conversions: 0,
  conversionValue: 0,
  events: new Map(),
});
function accumulate(a: Agg, r: InsightRow, objectiveByCampaign: Record<string, string>): void {
  a.spend += num(r.spend);
  a.impressions += num(r.impressions);
  a.reach += num(r.reach);
  a.clicks += num(r.clicks);
  a.linkClicks += num(r.inline_link_clicks);
  a.results += resultValue(r, objectiveByCampaign[String(r.campaign_id ?? "")]);
  a.conversions += pickAction(r.actions, CONVERSION_TYPE);
  a.conversionValue += pickAction(r.action_values, CONVERSION_TYPE);
  for (const act of (r.actions as { action_type: string; value: string }[] | undefined) ?? [])
    a.events.set(act.action_type, (a.events.get(act.action_type) ?? 0) + (Number(act.value) || 0));
}

const MAX_ROWS = 500;

/**
 * Aggregate a client's synced rows (from the injected source) by the breakdown key and shape them
 * into a tabular report. A client-facing cost markup, when set, inflates spend before the derived
 * cost metrics are computed; accounts with no data in range simply contribute nothing.
 */
export async function buildReport(
  fetchRows: ReportRowSource,
  spec: BuildSpec,
  subjectName: string,
): Promise<ReportPayload> {
  const keys = spec.columns.length ? spec.columns : DEFAULT_COLUMNS;
  const metricCols = keys.filter((k) => COL_META.has(k));
  const cols = metricCols.length ? metricCols : DEFAULT_COLUMNS;
  const dim = spec.breakdown;

  const aggByKey = new Map<string, Agg>();
  const order: string[] = [];
  let contributors = 0;

  for (const acc of spec.accountIds) {
    let rows: InsightRow[];
    try {
      rows = await fetchRows(acc);
    } catch {
      continue; // an account with no synced data contributes nothing; never fatal
    }
    if (rows.length === 0) continue;
    contributors++;
    for (const r of rows) {
      const key =
        dim === "none"
          ? "Total"
          : dim === "day"
            ? r.date_start
            : String(r[META_BREAKDOWN[dim]] ?? "—");
      let a = aggByKey.get(key);
      if (!a) {
        a = emptyAgg();
        aggByKey.set(key, a);
        order.push(key);
      }
      accumulate(a, r, spec.objectiveByCampaign);
    }
  }

  // Client-facing markup inflates spend so derived cost metrics (cpc/cpm/cost-per-result) rise and
  // roas falls; delivered figures (impressions/clicks/results/revenue) are real and stay untouched.
  if (spec.markup) {
    const factor = 1 + spec.markup;
    for (const a of aggByKey.values()) a.spend *= factor;
  }

  // Order rows: chronological for day, biggest-spend-first for dimensions.
  if (dim === "day") order.sort();
  else if (dim !== "none") order.sort((x, y) => aggByKey.get(y)!.spend - aggByKey.get(x)!.spend);
  const limited = order.slice(0, MAX_ROWS);

  const columns: ReportColumn[] =
    dim === "none"
      ? cols.map((k) => ({ key: k, label: COL_META.get(k)!.label, kind: COL_META.get(k)!.kind }))
      : [
          { key: "_dim", label: DIM_LABEL[dim], kind: "text" as const },
          ...cols.map((k) => ({
            key: k,
            label: COL_META.get(k)!.label,
            kind: COL_META.get(k)!.kind,
          })),
        ];

  const metricCells = (a: Agg): number[] => cols.map((k) => VALUE_FNS[k](a));
  const rows: (string | number)[][] = limited.map((key) => {
    const a = aggByKey.get(key)!;
    return dim === "none" ? metricCells(a) : [key, ...metricCells(a)];
  });

  // Totals across every key (only meaningful when there are multiple rows).
  const total = emptyAgg();
  for (const a of aggByKey.values()) {
    total.spend += a.spend;
    total.impressions += a.impressions;
    total.reach += a.reach;
    total.clicks += a.clicks;
    total.linkClicks += a.linkClicks;
    total.results += a.results;
    total.conversions += a.conversions;
    total.conversionValue += a.conversionValue;
  }
  const totals = dim === "none" ? null : (["Total", ...metricCells(total)] as (string | number)[]);

  const dimNote = dim === "none" ? "" : ` · by ${dim}`;
  const accNote =
    contributors < spec.accountIds.length
      ? `${contributors} of ${spec.accountIds.length} accounts have data in this range.`
      : null;

  return {
    title: `${subjectName} — performance report`,
    subtitle: `${spec.since} → ${spec.until}${dimNote}${spec.markup ? ` · incl. ${Math.round(spec.markup * 100)}% markup` : ""}`,
    note: accNote,
    columns,
    rows,
    totals,
    rowCount: rows.length,
    filename: `${slug(subjectName)}_${spec.since}_${spec.until}${dim === "none" ? "" : `_by_${dim}`}`,
  };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "report"
  );
}

/** Compact view of a report for the LLM tool_result (full payload goes to the UI). */
export function summarizeReportForLlm(p: ReportPayload): unknown {
  return {
    title: p.title,
    subtitle: p.subtitle,
    note: p.note,
    columns: p.columns.map((c) => c.label),
    rowCount: p.rowCount,
    totals: p.totals,
    sampleRows: p.rows.slice(0, 8),
  };
}

export interface ReportArgs {
  name: string;
  accountIds: string[];
  since: string;
  until: string;
  columns: string[];
  breakdown: Breakdown;
  markup?: number;
  campaignIds?: string[];
}

/** Load campaign_id → objective for the given accounts (for objective-aware results). */
async function objectiveMap(accountIds: string[]): Promise<Record<string, string>> {
  if (accountIds.length === 0) return {};
  const rows = await db
    .select({ id: schema.campaigns.id, objective: schema.campaigns.objective })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.accountId, accountIds));
  const out: Record<string, string> = {};
  for (const r of rows) if (r.objective) out[r.id] = r.objective;
  return out;
}

/** Produce the report from synced DB data (or an error for the LLM / UI builder). */
export async function runReport(args: ReportArgs): Promise<ReportPayload | { error: string }> {
  if (args.accountIds.length === 0)
    return { error: `No ad accounts are mapped to "${args.name}".` };
  const spec: BuildSpec = {
    accountIds: args.accountIds,
    since: args.since,
    until: args.until,
    columns: args.columns,
    breakdown: args.breakdown,
    objectiveByCampaign: await objectiveMap(args.accountIds),
    markup: args.markup,
    campaignIds: args.campaignIds,
  };
  const payload = await buildReport(dbRowSource(spec), spec, args.name);
  if (payload.rowCount === 0) {
    return { error: `No data for "${args.name}" in ${args.since} → ${args.until}.` };
  }
  return payload;
}

/** Resolve a `days` count or explicit since/until into a date range. */
export function resolveRange(input: {
  days?: unknown;
  since?: unknown;
  until?: unknown;
}): { since: string; until: string } | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (
    typeof input.since === "string" &&
    iso.test(input.since) &&
    typeof input.until === "string" &&
    iso.test(input.until)
  ) {
    return { since: input.since, until: input.until };
  }
  const days = Math.round(Number(input.days));
  if (Number.isFinite(days) && days > 0) return trailingRange(Math.min(days, 365));
  return null;
}

export interface ClientReportInput {
  clientId: string;
  days?: number;
  since?: string;
  until?: string;
  columns: string[];
  breakdown: string;
  markup?: number;
  campaignIds?: string[];
}

/**
 * Direct (no-LLM) report path for the UI Report Builder: the user has already
 * picked the client, range, columns, and breakdown, so resolve and run straight
 * against Meta — deterministic and fast.
 */
export async function reportForClient(
  input: ClientReportInput,
): Promise<ReportPayload | { error: string }> {
  const row = await getClientRow(input.clientId);
  if (!row) return { error: "Unknown client." };
  const range = resolveRange(input);
  if (!range) return { error: "Pick a valid date range." };
  const columns = normalizeColumns(input.columns);
  if (columns.length === 0) return { error: "Select at least one column." };
  return runReport({
    name: row.name,
    accountIds: effectiveAccountIds(row),
    since: range.since,
    until: range.until,
    columns,
    breakdown: normalizeBreakdown(input.breakdown),
    markup: input.markup,
    campaignIds: input.campaignIds,
  });
}
