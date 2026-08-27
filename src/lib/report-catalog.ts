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

/**
 * Metric groups, in picker display order.
 *
 * There is deliberately no "quality & ranking" group. The only ranking fields Meta returns
 * (`quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking`) are text enums like
 * "ABOVE_AVERAGE" — they cannot be summed across rows or days, and `quality_ranking` is non-null in
 * 0 of 513,253 ad-level rows in production anyway. An empty group would be dead furniture.
 */
export type MetricGroup =
  | "delivery"
  | "traffic"
  | "engagement"
  | "video"
  | "conversions"
  | "value"
  | "cost"
  | "messaging";

export const GROUP_LABELS: Record<MetricGroup, string> = {
  delivery: "Delivery",
  traffic: "Clicks & traffic",
  engagement: "Engagement",
  video: "Video",
  conversions: "Conversions",
  value: "Conversion value",
  cost: "Cost per",
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

const BASE: ReportMetric[] = [
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

/**
 * Scalar metrics that exist in the synced `raw` blob.
 *
 * Enumerated from production, not from Meta's field catalogue: a query over 40k spending ad-day rows
 * across 400 days returned exactly 111 distinct raw keys, and only these are worth offering. The
 * key IS the Meta field name; the label, group and format are the editorial part.
 *
 * Deliberately excluded:
 * - identity and dimension fields (`account_id`, `campaign_name`, `objective`, `date_start`, …)
 * - every precomputed cost, rate, ratio and benchmark Meta ships (`cpc`, `cost_per_action_type`,
 *   `*_rate`, `*_ctr`, `purchase_roas`, `average_purchases_conversion_value`, …). These are DERIVED
 *   below instead, because the client markup is applied to spend at report time and a stored cost
 *   would print un-inflated beside inflated spend.
 * - `video_avg_time_watched_actions` and `video_play_curve_actions`: an average and a distribution,
 *   neither of which can be re-aggregated across rows without weights we do not store.
 * - `conversion_rate_ranking` / `engagement_rate_ranking`: text enums ("ABOVE_AVERAGE") that cannot
 *   be summed, and whose meaning is per-ad rather than per-report.
 */
const STORED: [key: string, label: string, group: MetricGroup, kind: ReportColumnKind][] = [
  // delivery
  ["full_view_impressions", "Full-View Impressions", "delivery", "int"],
  ["full_view_reach", "Full-View Reach", "delivery", "int"],
  ["social_spend", "Social Spend", "delivery", "money"],
  // clicks & traffic
  ["unique_inline_link_clicks", "Unique Link Clicks", "traffic", "int"],
  ["unique_outbound_clicks", "Unique Outbound Clicks", "traffic", "int"],
  ["shop_clicks", "Shop Clicks", "traffic", "int"],
  // engagement
  ["inline_post_engagement", "Post Engagements", "engagement", "int"],
  ["instagram_profile_visits", "Instagram Profile Visits", "engagement", "int"],
  ["instagram_upcoming_event_reminders_set", "IG Event Reminders", "engagement", "int"],
  // video
  ["video_play_actions", "Video Plays", "video", "int"],
  ["video_p25_watched_actions", "Video 25% Views", "video", "int"],
  ["video_p50_watched_actions", "Video 50% Views", "video", "int"],
  ["video_p75_watched_actions", "Video 75% Views", "video", "int"],
  ["video_p95_watched_actions", "Video 95% Views", "video", "int"],
  ["video_p100_watched_actions", "Video 100% Views", "video", "int"],
  ["video_thruplay_watched_actions", "ThruPlays", "video", "int"],
  ["video_6_sec_watched_actions", "6s Video Views", "video", "int"],
  ["video_15_sec_watched_actions", "15s Video Views", "video", "int"],
  ["video_30_sec_watched_actions", "30s Video Views", "video", "int"],
  ["unique_video_view_15_sec", "Unique 15s Video Views", "video", "int"],
  ["video_continuous_2_sec_watched_actions", "2s Continuous Views", "video", "int"],
  // conversions
  ["shops_assisted_purchases", "Shop-Assisted Purchases", "conversions", "int"],
  ["marketing_messages_website_purchase", "Message Purchases", "conversions", "int"],
  ["marketing_messages_website_add_to_cart", "Message Add to Cart", "conversions", "int"],
  ["marketing_messages_website_initiate_checkout", "Message Checkouts", "conversions", "int"],
  // value
  ["marketing_messages_website_purchase_values", "Message Purchase Value", "value", "money"],
  // messaging
  ["marketing_messages_sent", "Messages Sent", "messaging", "int"],
  ["marketing_messages_delivered", "Messages Delivered", "messaging", "int"],
  ["marketing_messages_read", "Messages Read", "messaging", "int"],
  ["marketing_messages_link_btn_click", "Message Link Clicks", "messaging", "int"],
  ["marketing_messages_quick_reply_btn_click", "Message Quick Replies", "messaging", "int"],
  ["marketing_messages_spend", "Message Spend", "messaging", "money"],
];

/** Ratios and costs, always computed so the client markup on spend is inherited. */
const DERIVED: ReportMetric[] = [
  def("cpp", "Cost / 1k Reached", "delivery", "money", ratio("spend", "reach", 1000)),
  def("unique_ctr", "Unique CTR", "traffic", "pct", ratio("unique_clicks", "impressions", 100)),
  def("link_ctr", "Link CTR", "traffic", "pct", ratio("link_clicks", "impressions", 100)),
  def("cost_per_link_click", "Cost / Link Click", "cost", "money", costPer("link_clicks")),
  def("cost_per_unique_click", "Cost / Unique Click", "cost", "money", costPer("unique_clicks")),
  def(
    "cost_per_post_engagement",
    "Cost / Post Engagement",
    "cost",
    "money",
    costPer("inline_post_engagement"),
  ),
  def(
    "cost_per_unique_outbound_click",
    "Cost / Unique Outbound Click",
    "cost",
    "money",
    costPer("unique_outbound_clicks"),
  ),
  def(
    "cost_per_thruplay",
    "Cost / ThruPlay",
    "cost",
    "money",
    costPer("video_thruplay_watched_actions"),
  ),
  def(
    "avg_order_value",
    "Avg. Order Value",
    "value",
    "money",
    ratio("conversion_value", "purchases"),
  ),
  // Hook and hold rate: what share of impressions reached 25% and 100% of the video. Standard
  // creative-diagnostic pair for media buyers, and neither is stored by Meta.
  def(
    "hook_rate",
    "Hook Rate",
    "video",
    "pct",
    ratio("video_p25_watched_actions", "impressions", 100),
  ),
  def(
    "hold_rate",
    "Hold Rate",
    "video",
    "pct",
    ratio("video_p100_watched_actions", "impressions", 100),
  ),
  def(
    "message_read_rate",
    "Message Read Rate",
    "messaging",
    "pct",
    ratio("marketing_messages_read", "marketing_messages_delivered", 100),
  ),
  def(
    "cost_per_message_delivered",
    "Cost / Message Delivered",
    "cost",
    "money",
    costPer("marketing_messages_delivered"),
  ),
  def(
    "cost_per_message_link_click",
    "Cost / Message Link Click",
    "cost",
    "money",
    costPer("marketing_messages_link_btn_click"),
  ),
];

/**
 * Event families as report columns.
 *
 * Mirrors EVENT_FAMILIES in src/server/agg.ts, which this client-safe module cannot import; a test
 * in agg.test.ts asserts the two lists agree. Five families already have historical keys and keep
 * them, because saved reports and the existing UI reference those exact strings.
 */
export const EVENT_FAMILY_LABELS = [
  "Purchases",
  "Leads",
  "Registrations",
  "Add to cart",
  "Checkouts initiated",
  "View content",
  "Add payment info",
  "Subscriptions",
  "Trials started",
  "Searches",
  "Contacts",
  "App installs",
  "Messaging conversations",
  "Landing page views",
  "Link clicks",
  "Post engagements",
  "Video views",
] as const;

/** Families whose count and cost columns predate the catalog and must keep their keys. */
const LEGACY_FAMILY_COUNT: Record<string, string> = {
  Purchases: "purchases",
  Leads: "leads",
  Registrations: "registrations",
  "Checkouts initiated": "initiate_checkout",
  "Landing page views": "landing_page_views",
};
const LEGACY_FAMILY_COST: Record<string, string> = {
  Purchases: "cost_per_purchase",
  Leads: "cost_per_lead",
  Registrations: "cost_per_registration",
};

const slug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, "_");

function eventMetrics(): ReportMetric[] {
  const out: ReportMetric[] = [];
  for (const family of EVENT_FAMILY_LABELS) {
    const s = slug(family);
    const countKey = LEGACY_FAMILY_COUNT[family] ?? `event_${s}`;
    if (!LEGACY_FAMILY_COUNT[family]) {
      out.push(def(countKey, family, "conversions", "int", event(family, "count")));
    }
    out.push(def(`value_${s}`, `${family} value`, "value", "money", event(family, "value")));
    if (!LEGACY_FAMILY_COST[family]) {
      out.push(def(`cost_per_${s}`, `Cost / ${family}`, "cost", "money", costPer(countKey)));
    }
  }
  return out;
}

/**
 * The catalog. Order is display order: the historical 22 first, then stored scalars, derived ratios,
 * and the event families.
 */
export const REPORT_METRICS: ReportMetric[] = [
  ...BASE,
  ...STORED.map(([key, label, group, kind]) => def(key, label, group, kind, scalar(key))),
  ...DERIVED,
  ...eventMetrics(),
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
