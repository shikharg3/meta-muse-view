import { getCredentials } from "@/lib/credentials";
import { MetaClient } from "@/meta/client";
import { pickAction } from "@/meta/insights";
import { trailingRange } from "@/sync/jobs/insights";
import type { InsightRow, InsightsClient } from "@/meta/types";

export type Breakdown =
  | "none"
  | "day"
  | "platform"
  | "placement"
  | "age"
  | "gender"
  | "country"
  | "region";

type Kind = "text" | "int" | "money" | "float" | "pct";

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
}

const BASE_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "inline_link_clicks",
  "actions",
  "action_values",
];

// "Results" has no single API field; approximate as a deduped sum of outcome
// actions (leads + registrations + purchases + installs). Documented in the UI.
const RESULT_ACTION_TYPES = ["lead", "complete_registration", "omni_purchase", "omni_app_install"];
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

interface ColDef {
  label: string;
  kind: Kind;
  value: (a: Agg) => number;
}
const CATALOG: Record<string, ColDef> = {
  spend: { label: "Spend", kind: "money", value: (a) => a.spend },
  impressions: { label: "Impressions", kind: "int", value: (a) => a.impressions },
  reach: { label: "Reach", kind: "int", value: (a) => a.reach },
  clicks: { label: "Clicks", kind: "int", value: (a) => a.clicks },
  link_clicks: { label: "Link Clicks", kind: "int", value: (a) => a.linkClicks },
  ctr: {
    label: "CTR",
    kind: "pct",
    value: (a) => (a.impressions ? (a.clicks / a.impressions) * 100 : 0),
  },
  cpc: { label: "CPC", kind: "money", value: (a) => (a.clicks ? a.spend / a.clicks : 0) },
  cpm: {
    label: "CPM",
    kind: "money",
    value: (a) => (a.impressions ? (a.spend / a.impressions) * 1000 : 0),
  },
  frequency: {
    label: "Frequency",
    kind: "float",
    value: (a) => (a.reach ? a.impressions / a.reach : 0),
  },
  results: { label: "Results", kind: "int", value: (a) => a.results },
  cost_per_result: {
    label: "Cost / Result",
    kind: "money",
    value: (a) => (a.results ? a.spend / a.results : 0),
  },
  conversions: { label: "Conversions", kind: "int", value: (a) => a.conversions },
  conversion_value: { label: "Conv. Value", kind: "money", value: (a) => a.conversionValue },
  roas: { label: "ROAS", kind: "float", value: (a) => (a.spend ? a.conversionValue / a.spend : 0) },
};

export const DEFAULT_COLUMNS = ["spend", "impressions", "ctr", "cpc", "results"];

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
  level: "account" | "campaign" | "ad";
  since: string;
  until: string;
  columns: string[];
  breakdown: Breakdown;
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
});
function accumulate(a: Agg, r: InsightRow): void {
  a.spend += num(r.spend);
  a.impressions += num(r.impressions);
  a.reach += num(r.reach);
  a.clicks += num(r.clicks);
  a.linkClicks += num(r.inline_link_clicks);
  for (const t of RESULT_ACTION_TYPES) a.results += pickAction(r.actions, t);
  a.conversions += pickAction(r.actions, CONVERSION_TYPE);
  a.conversionValue += pickAction(r.action_values, CONVERSION_TYPE);
}

const MAX_ROWS = 500;

/**
 * Query the Meta Insights API live for each account, aggregate by the breakdown
 * key, and shape into a tabular report. Pure w.r.t. the API (client injected).
 * Per-account API errors (e.g. old accounts outside the BM) are skipped.
 */
export async function buildReport(
  client: InsightsClient,
  spec: BuildSpec,
  subjectName: string,
): Promise<ReportPayload> {
  const keys = spec.columns.length ? spec.columns : DEFAULT_COLUMNS;
  const metricCols = keys.filter((k) => k in CATALOG);
  const cols = metricCols.length ? metricCols : DEFAULT_COLUMNS;
  const dim = spec.breakdown;

  const aggByKey = new Map<string, Agg>();
  const order: string[] = [];
  let contributors = 0;
  let skipped = 0;

  for (const acc of spec.accountIds) {
    const params: Record<string, unknown> = {
      level: spec.level,
      time_range: { since: spec.since, until: spec.until },
      fields: BASE_FIELDS,
      use_unified_attribution_setting: true,
    };
    if (dim === "day") params.time_increment = 1;
    else if (dim !== "none") params.breakdowns = [META_BREAKDOWN[dim]];

    let rows: InsightRow[];
    try {
      rows = await client.getInsights(acc, params);
      contributors++;
    } catch {
      skipped++;
      continue;
    }
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
      accumulate(a, r);
    }
  }

  // Order rows: chronological for day, biggest-spend-first for dimensions.
  if (dim === "day") order.sort();
  else if (dim !== "none") order.sort((x, y) => aggByKey.get(y)!.spend - aggByKey.get(x)!.spend);
  const limited = order.slice(0, MAX_ROWS);

  const columns: ReportColumn[] =
    dim === "none"
      ? cols.map((k) => ({ key: k, label: CATALOG[k].label, kind: CATALOG[k].kind }))
      : [
          { key: "_dim", label: DIM_LABEL[dim], kind: "text" },
          ...cols.map((k) => ({ key: k, label: CATALOG[k].label, kind: CATALOG[k].kind })),
        ];

  const metricCells = (a: Agg): number[] => cols.map((k) => CATALOG[k].value(a));
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
    skipped > 0
      ? `${contributors} of ${spec.accountIds.length} accounts returned data (${skipped} skipped — likely outside the current Business Manager).`
      : null;

  return {
    title: `${subjectName} — performance report`,
    subtitle: `${spec.since} → ${spec.until}${dimNote}`,
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
  level: "account" | "campaign" | "ad";
}

/** Build the Meta client from stored creds and produce the report (or an error for the LLM). */
export async function runReport(args: ReportArgs): Promise<ReportPayload | { error: string }> {
  if (args.accountIds.length === 0)
    return { error: `No ad accounts are mapped to "${args.name}".` };
  const creds = await getCredentials();
  if (!creds) return { error: "Meta API credentials aren't configured. Set them in Settings." };
  const client = new MetaClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    token: creds.token,
    version: creds.apiVersion,
  });
  const payload = await buildReport(
    client,
    {
      accountIds: args.accountIds,
      level: args.level,
      since: args.since,
      until: args.until,
      columns: args.columns,
      breakdown: args.breakdown,
    },
    args.name,
  );
  if (payload.rowCount === 0) {
    return { error: `No Meta data for "${args.name}" in ${args.since} → ${args.until}.` };
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
