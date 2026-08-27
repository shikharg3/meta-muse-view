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
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";

// Every dimension a report can break down by. Entity dims read insights_daily at that level;
// meta dims read the synced insights_breakdown_daily types. All compose with `byDay`.
export type Breakdown =
  | "none"
  | "campaign"
  | "adset"
  | "ad"
  | "platform"
  | "placement"
  | "device"
  | "age"
  | "gender"
  | "age_gender"
  | "country"
  | "region"
  | "market"
  | "hour"
  | "hour_audience"
  | "frequency"
  | "product"
  | "image_asset"
  | "video_asset"
  | "title_asset"
  | "body_asset"
  | "cta_asset"
  | "description_asset"
  | "link_asset";

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

export type ReportDimDef =
  | { label: string; source: "entity"; level: "campaign" | "adset" | "ad" }
  | { label: string; source: "meta"; metaType: string; adLevel?: boolean };

/** Registry of report dimensions → where their rows come from. `metaType` is the stored
 *  breakdown_type key (pipe-joined Meta breakdown group, exactly as syncBreakdowns writes it);
 *  `adLevel` marks dynamic-creative asset breakdowns Meta only serves at ad level. */
export const REPORT_DIMS: Record<Exclude<Breakdown, "none">, ReportDimDef> = {
  campaign: { label: "Campaign", source: "entity", level: "campaign" },
  adset: { label: "Ad set", source: "entity", level: "adset" },
  ad: { label: "Ad", source: "entity", level: "ad" },
  platform: { label: "Platform", source: "meta", metaType: "publisher_platform" },
  placement: {
    label: "Placement",
    source: "meta",
    // The synced placement group is the full triple — a solo platform_position is never stored.
    metaType: "publisher_platform|platform_position|impression_device",
  },
  device: { label: "Device", source: "meta", metaType: "device_platform" },
  age: { label: "Age", source: "meta", metaType: "age" },
  gender: { label: "Gender", source: "meta", metaType: "gender" },
  age_gender: { label: "Age · Gender", source: "meta", metaType: "age|gender" },
  country: { label: "Country", source: "meta", metaType: "country" },
  region: { label: "Region", source: "meta", metaType: "region" },
  market: { label: "Market (DMA)", source: "meta", metaType: "comscore_market" },
  hour: {
    label: "Hour (account time)",
    source: "meta",
    metaType: "hourly_stats_aggregated_by_advertiser_time_zone",
  },
  hour_audience: {
    label: "Hour (audience time)",
    source: "meta",
    metaType: "hourly_stats_aggregated_by_audience_time_zone",
  },
  frequency: { label: "Frequency", source: "meta", metaType: "frequency_value" },
  product: { label: "Product", source: "meta", metaType: "product_id" },
  image_asset: { label: "Image asset", source: "meta", metaType: "image_asset", adLevel: true },
  video_asset: { label: "Video asset", source: "meta", metaType: "video_asset", adLevel: true },
  title_asset: { label: "Headline asset", source: "meta", metaType: "title_asset", adLevel: true },
  body_asset: { label: "Body text asset", source: "meta", metaType: "body_asset", adLevel: true },
  cta_asset: {
    label: "CTA asset",
    source: "meta",
    metaType: "call_to_action_asset",
    adLevel: true,
  },
  description_asset: {
    label: "Description asset",
    source: "meta",
    metaType: "description_asset",
    adLevel: true,
  },
  link_asset: {
    label: "Link URL asset",
    source: "meta",
    metaType: "link_url_asset",
    adLevel: true,
  },
};

/** The synced row's dimension value, attached by dbRowSource under this key. */
export const DIM_VALUE_KEY = "__dim";

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
    const key = raw.trim().toLowerCase();
    // A direct catalog key wins (covers every column, incl. new ones); else map free text via aliases.
    const k = COL_META.has(key) ? key : COLUMN_ALIASES[key.replace(/[^a-z]/g, "")];
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

export interface ResolvedBreakdown {
  dim: Breakdown;
  byDay: boolean;
}

/**
 * Free-text / legacy breakdown input (+ optional split-by-day flag) → dimension + byDay.
 * Accepts exact registry keys, legacy composites ("day", "<dim>_day"), and natural phrasings
 * ("daily by ad set", "device platform", "age and gender", "headline").
 */
export function parseBreakdown(input: unknown, splitByDay?: unknown): ResolvedBreakdown {
  let v = String(input ?? "")
    .toLowerCase()
    .trim();
  let byDay = Boolean(splitByDay);
  if (["day", "daily", "by day", "date"].includes(v)) return { dim: "none", byDay: true };
  if (v.endsWith("_day")) {
    byDay = true;
    v = v.slice(0, -4);
  } else if (v.includes("day") || v.includes("daily") || (v !== "date" && v.includes("date"))) {
    byDay = true;
  }
  if (v in REPORT_DIMS) return { dim: v as Breakdown, byDay };
  const has = (...subs: string[]): boolean => subs.some((s) => v.includes(s));
  const dim = ((): Breakdown => {
    if (has("image")) return "image_asset";
    if (has("video")) return "video_asset";
    if (has("title", "headline")) return "title_asset";
    if (has("body", "primary text")) return "body_asset";
    if (has("cta", "call to action", "call_to_action")) return "cta_asset";
    if (has("description")) return "description_asset";
    if (has("link url", "link_url")) return "link_asset";
    if (has("age") && has("gender")) return "age_gender";
    if (has("age")) return "age";
    if (has("gender")) return "gender";
    if (has("adset", "ad set", "ad-set", "ad_set")) return "adset";
    if (has("campaign")) return "campaign";
    if (has("placement", "position")) return "placement";
    if (has("device", "impression_device")) return "device";
    if (has("platform", "publisher")) return "platform";
    if (has("country")) return "country";
    if (has("region", "state")) return "region";
    if (has("dma", "market", "comscore")) return "market";
    if (has("hour") && has("audience")) return "hour_audience";
    if (has("hour")) return "hour";
    if (has("frequency")) return "frequency";
    if (has("product")) return "product";
    if (/\bads?\b/.test(v)) return "ad";
    return "none";
  })();
  return { dim, byDay };
}

export interface BuildSpec {
  accountIds: string[];
  since: string;
  until: string;
  columns: string[];
  breakdown: Breakdown;
  /** Additionally split every dimension row by day (key = "date · value"). */
  byDay: boolean;
  /** campaign_id → objective, for objective-aware "results". */
  objectiveByCampaign: Record<string, string>;
  /** Cost markup fraction (e.g. 0.1 = +10%) applied to spend for client-facing reports. */
  markup?: number;
  /** Restrict rows to these campaign ids (empty/undefined = all campaigns). */
  campaignIds?: string[];
}

/** Supplies a report's rows for one account. Injected so buildReport stays pure and unit-testable. */
export type ReportRowSource = (accountId: string) => Promise<InsightRow[]>;

/** Readable label for an asset-dim value: Meta returns these as OBJECTS ({text}/{video_id,url}/…),
 *  so the stored breakdown_value stringifies to "[object Object]" — read the dims jsonb instead. */
function assetLabel(v: unknown): string {
  if (v == null) return "—";
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  const keys = [
    "text",
    "name",
    "video_name",
    "image_name",
    "website_url",
    "display_url",
    "url",
    "video_id",
    "hash",
    "id",
  ];
  for (const k of keys) {
    const x = o[k];
    if (typeof x === "string" && x) return x;
    if (typeof x === "number") return String(x);
  }
  return JSON.stringify(o).slice(0, 80);
}

/**
 * Report rows sourced from the synced DB, not a live Meta call — reports must cover accounts that
 * are disabled or outside the current Business Manager (their history is retained locally but the
 * token can no longer query them live, which otherwise yields an empty "No data" report).
 * none read campaign-level insights_daily (full objective-aware results); entity dims read
 * insights_daily at their level; meta dims read insights_breakdown_daily at exactly one level.
 */
export function dbRowSource(spec: BuildSpec): ReportRowSource {
  const scopedTo = spec.campaignIds?.length ? new Set(spec.campaignIds) : null;
  const core = (r: typeof schema.insightsDaily.$inferSelect): InsightRow => ({
    date_start: r.date,
    date_stop: r.date,
    spend: String(r.spend),
    impressions: String(r.impressions),
    reach: String(r.reach),
    clicks: String(r.clicks),
    inline_link_clicks: String(r.inlineLinkClicks),
    actions: (r.actions ?? undefined) as InsightRow["actions"],
    action_values: (r.actionValues ?? undefined) as InsightRow["action_values"],
  });
  const dailyRows = (accountId: string, level: string) =>
    db
      .select()
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, level),
          eq(schema.insightsDaily.accountId, accountId),
          gte(schema.insightsDaily.date, spec.since),
          lte(schema.insightsDaily.date, spec.until),
        ),
      );
  // ad id → campaign id (and ad names), for ad-grain rows and ad-level asset breakdowns.
  const adMaps = async (accountId: string) => {
    const [ads, sets] = await Promise.all([
      db
        .select({ id: schema.ads.id, name: schema.ads.name, adSetId: schema.ads.adSetId })
        .from(schema.ads)
        .where(eq(schema.ads.accountId, accountId)),
      db
        .select({ id: schema.adSets.id, campaignId: schema.adSets.campaignId })
        .from(schema.adSets)
        .where(eq(schema.adSets.accountId, accountId)),
    ]);
    const campBySet = new Map(sets.map((s) => [s.id, s.campaignId]));
    return {
      nameById: new Map(ads.map((a) => [a.id, a.name])),
      campaignByAd: new Map(ads.map((a) => [a.id, campBySet.get(a.adSetId)])),
    };
  };

  return async (accountId) => {
    const dim = spec.breakdown;
    // Totals / by-day: campaign-level daily rows (objective-aware results, campaign scoping).
    if (dim === "none") {
      const rows = await db
        .select()
        .from(schema.insightsDaily)
        .where(
          and(
            eq(schema.insightsDaily.level, "campaign"),
            eq(schema.insightsDaily.accountId, accountId),
            gte(schema.insightsDaily.date, spec.since),
            lte(schema.insightsDaily.date, spec.until),
            scopedTo ? inArray(schema.insightsDaily.entityId, [...scopedTo]) : undefined,
          ),
        );
      return rows.map((r): InsightRow => ({ ...core(r), campaign_id: r.entityId }));
    }
    const def = REPORT_DIMS[dim];
    if (def.source === "entity") {
      // One row per campaign / ad set / ad (its name is the dimension value).
      let nameById: Map<string, string>;
      let campaignByEntity: (id: string) => string | undefined;
      if (def.level === "campaign") {
        const cs = await db
          .select({ id: schema.campaigns.id, name: schema.campaigns.name })
          .from(schema.campaigns)
          .where(eq(schema.campaigns.accountId, accountId));
        nameById = new Map(cs.map((c) => [c.id, c.name]));
        campaignByEntity = (id) => id;
      } else if (def.level === "adset") {
        const sets = await db
          .select({
            id: schema.adSets.id,
            name: schema.adSets.name,
            campaignId: schema.adSets.campaignId,
          })
          .from(schema.adSets)
          .where(eq(schema.adSets.accountId, accountId));
        nameById = new Map(sets.map((s) => [s.id, s.name]));
        const camp = new Map(sets.map((s) => [s.id, s.campaignId]));
        campaignByEntity = (id) => camp.get(id);
      } else {
        const m = await adMaps(accountId);
        nameById = m.nameById;
        campaignByEntity = (id) => m.campaignByAd.get(id);
      }
      const rows = await dailyRows(accountId, def.level);
      return rows.flatMap((r): InsightRow[] => {
        const camp = campaignByEntity(r.entityId);
        if (scopedTo && (!camp || !scopedTo.has(camp))) return [];
        return [
          {
            ...core(r),
            campaign_id: camp,
            [DIM_VALUE_KEY]: nameById.get(r.entityId) ?? r.entityId,
          },
        ];
      });
    }
    // Meta dimension: synced insights_breakdown_daily. The same data exists as an account-level
    // rollup AND per-campaign rows (and asset types at ad level only) — pick exactly ONE level or
    // metrics double-count. Campaign scoping uses campaign rows (or the ads of those campaigns).
    const level = def.adLevel ? "ad" : scopedTo ? "campaign" : "account";
    let allowedAds: Set<string> | null = null;
    let adCampaign: Map<string, string | undefined> | null = null;
    if (def.adLevel) {
      const m = await adMaps(accountId);
      adCampaign = m.campaignByAd;
      if (scopedTo) {
        allowedAds = new Set(
          [...m.campaignByAd.entries()].filter(([, c]) => c && scopedTo.has(c)).map(([id]) => id),
        );
      }
    }
    const rows = await db
      .select()
      .from(schema.insightsBreakdownDaily)
      .where(
        and(
          eq(schema.insightsBreakdownDaily.breakdownType, def.metaType),
          eq(schema.insightsBreakdownDaily.accountId, accountId),
          eq(schema.insightsBreakdownDaily.level, level),
          !def.adLevel && scopedTo
            ? inArray(schema.insightsBreakdownDaily.entityId, [...scopedTo])
            : undefined,
          gte(schema.insightsBreakdownDaily.date, spec.since),
          lte(schema.insightsBreakdownDaily.date, spec.until),
        ),
      );
    return rows.flatMap((r): InsightRow[] => {
      if (allowedAds && !allowedAds.has(r.entityId)) return [];
      const raw = (r.raw ?? {}) as Record<string, unknown>;
      return [
        {
          date_start: r.date,
          date_stop: r.date,
          campaign_id:
            level === "campaign" ? r.entityId : (adCampaign?.get(r.entityId) ?? undefined),
          [DIM_VALUE_KEY]: def.adLevel
            ? assetLabel((r.dims as Record<string, unknown> | null)?.[def.metaType])
            : r.breakdownValue.split("|").join(" · "),
          spend: String(r.spend),
          impressions: String(r.impressions),
          reach: String(r.reach),
          clicks: String(r.clicks),
          inline_link_clicks:
            raw.inline_link_clicks != null ? String(raw.inline_link_clicks) : undefined,
          actions: (raw.actions ?? undefined) as InsightRow["actions"],
          action_values: (raw.action_values ?? undefined) as InsightRow["action_values"],
        },
      ];
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
      const dimVal = (): string => String(r[DIM_VALUE_KEY] ?? "—");
      const key =
        dim === "none"
          ? spec.byDay
            ? r.date_start
            : "Total"
          : spec.byDay
            ? `${r.date_start} · ${dimVal()}`
            : dimVal();
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

  // Order rows: chronological when split by day (keys start with the date), spend-first else.
  if (spec.byDay) order.sort();
  else if (dim !== "none") order.sort((x, y) => aggByKey.get(y)!.spend - aggByKey.get(x)!.spend);
  const limited = order.slice(0, MAX_ROWS);

  const hasDimCol = dim !== "none" || spec.byDay;
  const dimLabel =
    dim === "none"
      ? "Date"
      : spec.byDay
        ? `Date · ${REPORT_DIMS[dim].label}`
        : REPORT_DIMS[dim].label;
  const columns: ReportColumn[] = !hasDimCol
    ? cols.map((k) => ({ key: k, label: COL_META.get(k)!.label, kind: COL_META.get(k)!.kind }))
    : [
        { key: "_dim", label: dimLabel, kind: "text" as const },
        ...cols.map((k) => ({
          key: k,
          label: COL_META.get(k)!.label,
          kind: COL_META.get(k)!.kind,
        })),
      ];

  const metricCells = (a: Agg): number[] => cols.map((k) => VALUE_FNS[k](a));
  const rows: (string | number)[][] = limited.map((key) => {
    const a = aggByKey.get(key)!;
    return hasDimCol ? [key, ...metricCells(a)] : metricCells(a);
  });

  // Totals across every key (only meaningful when there are multiple rows). Folding the event map in
  // is what the previous version omitted: familyCount saw an empty map, so every event column and
  // every cost-per column rendered 0 in the totals row while the data rows above were correct.
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
    for (const [type, n] of a.events) total.events.set(type, (total.events.get(type) ?? 0) + n);
  }
  const totals = hasDimCol ? (["Total", ...metricCells(total)] as (string | number)[]) : null;

  const dimNote = hasDimCol ? ` · by ${dimLabel.toLowerCase()}` : "";
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
    filename: `${slug(subjectName)}_${spec.since}_${spec.until}${dim === "none" ? (spec.byDay ? "_by_day" : "") : `_by_${dim}${spec.byDay ? "_day" : ""}`}`,
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
  byDay: boolean;
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
    byDay: args.byDay,
    objectiveByCampaign: await objectiveMap(args.accountIds),
    markup: args.markup,
    campaignIds: args.campaignIds,
  };
  const payload = await buildReport(dbRowSource(spec), spec, args.name);
  if (payload.rowCount === 0) {
    // Meta-dimension tables refresh only on the daily FULL sync, so a fresh window can have
    // campaign rows but no breakdown rows yet. Say that, instead of a misleading "no data".
    // (Entity dims — campaign/adset/ad — read insights_daily like day does; they never lag.)
    const def = spec.breakdown === "none" ? null : REPORT_DIMS[spec.breakdown];
    if (def?.source === "meta") {
      const [has] = await db
        .select({ id: schema.insightsDaily.entityId })
        .from(schema.insightsDaily)
        .where(
          and(
            eq(schema.insightsDaily.level, "campaign"),
            inArray(schema.insightsDaily.accountId, args.accountIds),
            gte(schema.insightsDaily.date, args.since),
            lte(schema.insightsDaily.date, args.until),
          ),
        )
        .limit(1);
      if (has)
        return {
          error:
            `"${args.name}" HAS data for ${args.since} → ${args.until}, but the "${spec.breakdown}" ` +
            `breakdown hasn't been synced for that window yet (Meta-dimension breakdowns refresh on ` +
            `the daily full sync). Re-run without a breakdown (or by day / campaign / ad set / ad, ` +
            `which never lag), or retry after the next full sync.`,
        };
    }
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
  // Clamp to the insights retention target (≈37 months) — history is synced to account creation.
  if (Number.isFinite(days) && days > 0) return trailingRange(Math.min(days, 1125));
  return null;
}

export interface ClientReportInput {
  clientId: string;
  days?: number;
  since?: string;
  until?: string;
  columns: string[];
  breakdown: string;
  splitByDay?: boolean;
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
  const bd = parseBreakdown(input.breakdown, input.splitByDay);
  const accountIds = effectiveAccountIds(row);
  // On accounts shared with another client, restrict to the campaigns whose names attribute to THIS
  // client, intersected with any explicit campaign selection.
  const owned = await ownedCampaignIds(input.clientId, accountIds);
  const selected = input.campaignIds?.length ? input.campaignIds : null;
  const campaignIds = selected
    ? owned
      ? selected.filter((id) => owned.includes(id))
      : selected
    : (owned ?? undefined);
  return runReport({
    name: row.name,
    accountIds,
    since: range.since,
    until: range.until,
    columns,
    breakdown: bd.dim,
    byDay: bd.byDay,
    markup: input.markup,
    campaignIds,
  });
}
