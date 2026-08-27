/**
 * Report metric catalog — the single source of truth for what a report can contain.
 *
 * Client-safe by contract: no DB, server or secret imports, because the column picker and the server
 * engine must agree by construction rather than by two lists staying in sync. The previous design
 * kept labels here in report-options.ts and value functions in server/agent/report.ts; an entry
 * present in one but absent from the other crashed report generation on an unguarded lookup.
 *
 * Adding a metric means adding ONE entry to REPORT_METRICS.
 */
export type ReportColumnKind = "text" | "int" | "money" | "float" | "pct";

export type MetricGroup =
  | "delivery"
  | "traffic"
  | "engagement"
  | "video"
  | "conversions"
  | "value"
  | "cost"
  | "quality"
  | "messaging";

export const GROUP_LABELS: Record<MetricGroup, string> = {
  delivery: "Delivery",
  traffic: "Clicks & traffic",
  engagement: "Engagement",
  video: "Video",
  conversions: "Conversions",
  value: "Conversion value",
  cost: "Cost per",
  quality: "Quality & ranking",
  messaging: "Messaging",
};

export type MetricSource =
  /** A named numeric field on the insight row. `dbRowSource` merges the synced `raw` blob beneath
   *  the promoted columns, so this one kind covers both; promoted values win on a key collision
   *  because they are already normalised. */
  | { kind: "scalar"; field: string }
  /** One de-duplicated event family from EVENT_FAMILIES (src/server/agg.ts). */
  | { kind: "event"; family: string; measure: "count" | "value" }
  /** A single literal Meta action_type. Legacy-compat only: `conversions` and `conversion_value`
   *  pin `omni_purchase` rather than the Purchases family, and must keep doing so. */
  | { kind: "action"; type: string; measure: "count" | "value" }
  /** The objective-aware result count; it needs objectiveByCampaign, so it cannot be a scalar. */
  | { kind: "result" }
  /** Computed from other metrics. The ONLY legal source for a cost or a ratio — see below. */
  | { kind: "derived"; deps: string[]; fn: (v: Readonly<Record<string, number>>) => number };

export interface ReportMetric {
  key: string;
  label: string;
  group: MetricGroup;
  kind: ReportColumnKind;
  source: MetricSource;
}

/**
 * `num / den`, scaled. Zero when the denominator is zero — a report cell must never be NaN or ∞.
 */
const ratio = (num: string, den: string, scale = 1): MetricSource => ({
  kind: "derived",
  deps: [num, den],
  fn: (v) => (v[den] ? (v[num] / v[den]) * scale : 0),
});

/**
 * Cost per one unit of `den`.
 *
 * ALWAYS derived from spend, never read from a stored field. Meta ships precomputed `cpc`, `cpm`,
 * `cost_per_action_type` and friends inside the synced `raw` blob, but the client-facing markup is
 * applied once to spend at report time — so a stored cost value would print un-inflated costs beside
 * inflated spend and understate what the client is charged. There is deliberately no "cost" measure
 * on MetricSource, which makes the mistake unrepresentable rather than merely forbidden.
 */
const costPer = (den: string): MetricSource => ratio("spend", den);

export const REPORT_METRICS: ReportMetric[] = [
  // ---- delivery
  { key: "spend", label: "Spend", group: "delivery", kind: "money", source: { kind: "scalar", field: "spend" } },
  { key: "impressions", label: "Impressions", group: "delivery", kind: "int", source: { kind: "scalar", field: "impressions" } },
  { key: "reach", label: "Reach", group: "delivery", kind: "int", source: { kind: "scalar", field: "reach" } },
  { key: "frequency", label: "Frequency", group: "delivery", kind: "float", source: ratio("impressions", "reach") },
  { key: "cpm", label: "CPM", group: "delivery", kind: "money", source: ratio("spend", "impressions", 1000) },

  // ---- clicks & traffic
  { key: "clicks", label: "Clicks", group: "traffic", kind: "int", source: { kind: "scalar", field: "clicks" } },
  { key: "link_clicks", label: "Link Clicks", group: "traffic", kind: "int", source: { kind: "scalar", field: "inline_link_clicks" } },
  { key: "ctr", label: "CTR", group: "traffic", kind: "pct", source: ratio("clicks", "impressions", 100) },
  { key: "cpc", label: "CPC", group: "traffic", kind: "money", source: ratio("spend", "clicks") },

  // ---- conversions
  { key: "results", label: "Results", group: "conversions", kind: "int", source: { kind: "result" } },
  { key: "conversions", label: "Conversions", group: "conversions", kind: "int", source: { kind: "action", type: "omni_purchase", measure: "count" } },
  { key: "registrations", label: "Registrations", group: "conversions", kind: "int", source: { kind: "event", family: "Registrations", measure: "count" } },
  { key: "leads", label: "Leads", group: "conversions", kind: "int", source: { kind: "event", family: "Leads", measure: "count" } },
  { key: "initiate_checkout", label: "Checkouts", group: "conversions", kind: "int", source: { kind: "event", family: "Checkouts initiated", measure: "count" } },
  { key: "purchases", label: "Purchases", group: "conversions", kind: "int", source: { kind: "event", family: "Purchases", measure: "count" } },
  { key: "landing_page_views", label: "Landing Page Views", group: "conversions", kind: "int", source: { kind: "event", family: "Landing page views", measure: "count" } },

  // ---- conversion value
  { key: "conversion_value", label: "Conv. Value", group: "value", kind: "money", source: { kind: "action", type: "omni_purchase", measure: "value" } },
  { key: "roas", label: "ROAS", group: "value", kind: "float", source: ratio("conversion_value", "spend") },

  // ---- cost per
  { key: "cost_per_result", label: "Cost / Result", group: "cost", kind: "money", source: costPer("results") },
  { key: "cost_per_registration", label: "Cost / Reg.", group: "cost", kind: "money", source: costPer("registrations") },
  { key: "cost_per_lead", label: "Cost / Lead", group: "cost", kind: "money", source: costPer("leads") },
  { key: "cost_per_purchase", label: "Cost / Purchase", group: "cost", kind: "money", source: costPer("purchases") },
];

/** Static key → descriptor table. Built once at module load. */
const BY_KEY: Record<string, ReportMetric> = Object.fromEntries(
  REPORT_METRICS.map((m) => [m.key, m]),
);

export const metric = (key: string): ReportMetric | undefined => BY_KEY[key];

/**
 * The 22 keys the current chip-cloud picker shows, in its historical display order.
 *
 * SCAFFOLDING WITH A DEFINED END: it exists only so the old picker keeps showing 22 options instead
 * of the whole catalog while the replacement picker is built. Plan 2, Task 1 deletes it.
 */
export const LEGACY_UI_COLUMN_KEYS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "link_clicks",
  "ctr",
  "cpc",
  "cpm",
  "frequency",
  "results",
  "cost_per_result",
  "conversions",
  "conversion_value",
  "roas",
  "registrations",
  "leads",
  "initiate_checkout",
  "purchases",
  "landing_page_views",
  "cost_per_registration",
  "cost_per_lead",
  "cost_per_purchase",
];
