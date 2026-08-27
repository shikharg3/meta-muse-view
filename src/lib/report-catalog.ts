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

/**
 * One catalog entry. Positional on purpose: at ~150 metrics a keyed object literal per entry is
 * three screens of `key:`/`label:` noise, and the argument order (what · shown as · grouped under ·
 * formatted as · read from) is the same for every row.
 */
const def = (
  key: string,
  label: string,
  group: MetricGroup,
  kind: ReportColumnKind,
  source: MetricSource,
): ReportMetric => ({ key, label, group, kind, source });

const scalar = (field: string): MetricSource => ({ kind: "scalar", field });
const event = (family: string, measure: "count" | "value"): MetricSource => ({
  kind: "event",
  family,
  measure,
});
const action = (type: string, measure: "count" | "value"): MetricSource => ({
  kind: "action",
  type,
  measure,
});

export const REPORT_METRICS: ReportMetric[] = [
  // ---- delivery
  def("spend", "Spend", "delivery", "money", scalar("spend")),
  def("impressions", "Impressions", "delivery", "int", scalar("impressions")),
  def("reach", "Reach", "delivery", "int", scalar("reach")),
  def("frequency", "Frequency", "delivery", "float", ratio("impressions", "reach")),
  def("cpm", "CPM", "delivery", "money", ratio("spend", "impressions", 1000)),

  // ---- clicks & traffic
  def("clicks", "Clicks", "traffic", "int", scalar("clicks")),
  def("link_clicks", "Link Clicks", "traffic", "int", scalar("inline_link_clicks")),
  def("unique_clicks", "Unique Clicks", "traffic", "int", scalar("unique_clicks")),
  def("ctr", "CTR", "traffic", "pct", ratio("clicks", "impressions", 100)),
  def("cpc", "CPC", "traffic", "money", ratio("spend", "clicks")),

  // ---- conversions
  def("results", "Results", "conversions", "int", { kind: "result" }),
  def("conversions", "Conversions", "conversions", "int", action("omni_purchase", "count")),
  def("registrations", "Registrations", "conversions", "int", event("Registrations", "count")),
  def("leads", "Leads", "conversions", "int", event("Leads", "count")),
  def(
    "initiate_checkout",
    "Checkouts",
    "conversions",
    "int",
    event("Checkouts initiated", "count"),
  ),
  def("purchases", "Purchases", "conversions", "int", event("Purchases", "count")),
  def(
    "landing_page_views",
    "Landing Page Views",
    "conversions",
    "int",
    event("Landing page views", "count"),
  ),

  // ---- conversion value
  def("conversion_value", "Conv. Value", "value", "money", action("omni_purchase", "value")),
  def("roas", "ROAS", "value", "float", ratio("conversion_value", "spend")),

  // ---- cost per
  def("cost_per_result", "Cost / Result", "cost", "money", costPer("results")),
  def("cost_per_registration", "Cost / Reg.", "cost", "money", costPer("registrations")),
  def("cost_per_lead", "Cost / Lead", "cost", "money", costPer("leads")),
  def("cost_per_purchase", "Cost / Purchase", "cost", "money", costPer("purchases")),
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
