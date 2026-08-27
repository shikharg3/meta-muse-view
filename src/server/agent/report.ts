import { and, eq, gte, lte, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { pickAction } from "@/meta/insights";
import { resultSpec } from "@/server/creative";
import { familyCount, familyValue } from "@/server/agg";
import { trailingRange } from "@/sync/jobs/insights";
import type { InsightRow } from "@/meta/types";
import { getClientRow, effectiveAccountIds } from "@/sync/jobs/clients";
import { DEFAULT_REPORT_COLUMN_KEYS } from "@/lib/report-options";
import { metric, type ReportColumnKind } from "@/lib/report-catalog";
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

/**
 * Per-row-key accumulator.
 *
 * Scalars live in a map keyed by insight-row field name rather than as fixed properties, so the
 * totals row folds exactly the same structures the data rows do and cannot silently omit one. The
 * previous shape restated its eight fields in a second place, which is how every event column came
 * to render 0 in totals.
 */
interface Agg {
  scalars: Map<string, number>;
  results: number;
  events: Map<string, number>;
  eventValues: Map<string, number>;
}

// "Results" is objective-dependent in Ads Manager (traffic→link clicks,
// leads→leads, sales→purchases, …). We query at campaign level so each row
// carries a campaign_id, map it to its objective, and count that objective's
// result action — matching what the dashboards show. The `conversions` column's omni_purchase
// baseline now lives in the catalog as an `action` descriptor.

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
    const k = metric(key) ? key : COLUMN_ALIASES[key.replace(/[^a-z]/g, "")];
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
 * A synced insights_daily row as an InsightRow the engine can read named fields off.
 *
 * `raw` is the full Meta response for this row and is ALREADY on the wire — every select in
 * dbRowSource is unprojected — so spreading it makes every synced metric reachable at no extra query
 * cost. Promoted columns are spread LAST and therefore win any key collision: they are normalised
 * numbers, whereas raw carries Meta's original strings and, for a partial sync pass, may omit keys
 * entirely. Exported so that precedence can be tested without a database.
 */
export function insightRowFrom(r: typeof schema.insightsDaily.$inferSelect): InsightRow {
  return {
    ...((r.raw ?? {}) as Record<string, unknown>),
    date_start: r.date,
    date_stop: r.date,
    spend: String(r.spend),
    impressions: String(r.impressions),
    reach: String(r.reach),
    clicks: String(r.clicks),
    inline_link_clicks: String(r.inlineLinkClicks),
    actions: (r.actions ?? undefined) as InsightRow["actions"],
    action_values: (r.actionValues ?? undefined) as InsightRow["action_values"],
  };
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
  const core = insightRowFrom;
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
  scalars: new Map(),
  results: 0,
  events: new Map(),
  eventValues: new Map(),
});

const addTo = (m: Map<string, number>, key: string, n: number): void => {
  if (n) m.set(key, (m.get(key) ?? 0) + n);
};

/** Sum into `a` only the row fields the selected descriptors actually need. */
function accumulate(
  a: Agg,
  r: InsightRow,
  objectiveByCampaign: Record<string, string>,
  fields: readonly string[],
): void {
  for (const f of fields) addTo(a.scalars, f, num((r as Record<string, unknown>)[f]));
  a.results += resultValue(r, objectiveByCampaign[String(r.campaign_id ?? "")]);
  for (const act of (r.actions as { action_type: string; value: string }[] | undefined) ?? [])
    addTo(a.events, act.action_type, Number(act.value) || 0);
  for (const act of (r.action_values as { action_type: string; value: string }[] | undefined) ?? [])
    addTo(a.eventValues, act.action_type, Number(act.value) || 0);
}

const mergeAgg = (into: Agg, from: Agg): void => {
  for (const [k, v] of from.scalars) addTo(into.scalars, k, v);
  into.results += from.results;
  for (const [k, v] of from.events) addTo(into.events, k, v);
  for (const [k, v] of from.eventValues) addTo(into.eventValues, k, v);
};

/** Row fields a descriptor set needs summed, following `derived` dependencies transitively. */
function neededFields(keys: readonly string[]): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const m = metric(key);
    if (!m) return;
    if (m.source.kind === "scalar") out.add(m.source.field);
    else if (m.source.kind === "derived") m.source.deps.forEach(walk);
  };
  keys.forEach(walk);
  return [...out];
}

/** Resolve one descriptor against an accumulator, memoising so shared dependencies compute once. */
function resolveMetric(key: string, a: Agg, memo: Map<string, number>): number {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const m = metric(key);
  if (!m) return 0;
  let v = 0;
  switch (m.source.kind) {
    case "scalar":
      v = a.scalars.get(m.source.field) ?? 0;
      break;
    case "result":
      v = a.results;
      break;
    case "action":
      v = (m.source.measure === "count" ? a.events : a.eventValues).get(m.source.type) ?? 0;
      break;
    case "event":
      v =
        m.source.measure === "count"
          ? familyCount(a.events, m.source.family)
          : familyValue(a.eventValues, m.source.family);
      break;
    case "derived": {
      const deps: Record<string, number> = {};
      for (const d of m.source.deps) deps[d] = resolveMetric(d, a, memo);
      v = m.source.fn(deps);
      break;
    }
  }
  memo.set(key, v);
  return v;
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
  const metricCols = keys.filter((k) => metric(k) !== undefined);
  const cols = metricCols.length ? metricCols : DEFAULT_COLUMNS;
  const dim = spec.breakdown;
  const fields = neededFields(cols);

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
      accumulate(a, r, spec.objectiveByCampaign, fields);
    }
  }

  // Client-facing markup inflates spend so derived cost metrics (cpc/cpm/cost-per-result) rise and
  // roas falls; delivered figures (impressions/clicks/results/revenue) are real and stay untouched.
  if (spec.markup) {
    const factor = 1 + spec.markup;
    for (const a of aggByKey.values()) {
      const s = a.scalars.get("spend");
      if (s) a.scalars.set("spend", s * factor);
    }
  }

  // Order rows: chronological when split by day (keys start with the date), spend-first else.
  if (spec.byDay) order.sort();
  else if (dim !== "none")
    order.sort(
      (x, y) =>
        (aggByKey.get(y)!.scalars.get("spend") ?? 0) - (aggByKey.get(x)!.scalars.get("spend") ?? 0),
    );
  const limited = order.slice(0, MAX_ROWS);

  const hasDimCol = dim !== "none" || spec.byDay;
  const dimLabel =
    dim === "none"
      ? "Date"
      : spec.byDay
        ? `Date · ${REPORT_DIMS[dim].label}`
        : REPORT_DIMS[dim].label;
  const columns: ReportColumn[] = [
    ...(hasDimCol ? [{ key: "_dim", label: dimLabel, kind: "text" as const }] : []),
    ...cols.map((k) => {
      const m = metric(k)!;
      return { key: m.key, label: m.label, kind: m.kind };
    }),
  ];

  const metricCells = (a: Agg): number[] => {
    const memo = new Map<string, number>();
    return cols.map((k) => resolveMetric(k, a, memo));
  };
  const rows: (string | number)[][] = limited.map((key) => {
    const a = aggByKey.get(key)!;
    return hasDimCol ? [key, ...metricCells(a)] : metricCells(a);
  });

  // Totals across every key (only meaningful when there are multiple rows). mergeAgg folds the same
  // structures the data rows use, so the totals row cannot omit a field the way the previous
  // hand-restated version did.
  const total = emptyAgg();
  for (const a of aggByKey.values()) mergeAgg(total, a);
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
