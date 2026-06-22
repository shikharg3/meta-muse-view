import { and, eq, gte, ilike, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { disableReasonLabel } from "@/lib/format";
import { summarizeTargeting } from "./targeting";
import { db, schema } from "@/db/client";
import {
  accountStatus,
  canonicalEvents,
  deriveKpis,
  pctDelta,
  type ClientEvent,
  type Totals,
} from "@/server/agg";
import { addDays, type DateWindow } from "@/lib/range";
import { creativeFormat, creativeImageUrl, hueFromId, resultSpec } from "@/server/creative";
import type {
  AdAccount,
  BreakdownRow,
  Campaign,
  CreativeCard,
  Kpis,
  KpiDeltas,
  TrendPoint,
} from "@/lib/types";
import { isCycleRunning } from "@/sync/cycle";

const num = (v: unknown): number => Number(v ?? 0);

/** Summed insight totals grouped by entity, for a level over the window. */
function totalsByEntity(level: string, w: DateWindow) {
  return db
    .select({
      entityId: schema.insightsDaily.entityId,
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
      impressions: sql<number>`coalesce(sum(${schema.insightsDaily.impressions}),0)`,
      clicks: sql<number>`coalesce(sum(${schema.insightsDaily.clicks}),0)`,
      conversions: sql<number>`coalesce(sum(${schema.insightsDaily.conversions}),0)`,
      revenue: sql<number>`coalesce(sum(${schema.insightsDaily.conversionValues}),0)`,
      reach: sql<number>`coalesce(max(${schema.insightsDaily.reach}),0)`,
    })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.level, level),
        gte(schema.insightsDaily.date, w.since),
        lte(schema.insightsDaily.date, w.until),
      ),
    )
    .groupBy(schema.insightsDaily.entityId);
}

/** Action sums keyed `${entityId}:${action_type}` at a level (actions live in jsonb). */
async function actionTotals(level: string, w: DateWindow): Promise<Map<string, number>> {
  const rows = await db.execute(sql`
    select entity_id, elem->>'action_type' as type, sum((elem->>'value')::double precision) as val
    from insights_daily
    cross join lateral jsonb_array_elements(actions) elem
    where level = ${level} and date >= ${w.since} and date <= ${w.until}
    group by 1, 2
  `);
  const out = new Map<string, number>();
  for (const r of rows as unknown as { entity_id: string; type: string; val: number }[]) {
    out.set(`${r.entity_id}:${r.type}`, Number(r.val) || 0);
  }
  return out;
}

export interface ScopeResult {
  value: number;
  label: string;
}

/** When a scope spans mixed objectives, label it by the objective that spent most. */
function dominantLabel(m: Map<string, number>): string {
  let best = -1;
  let label = "Results";
  for (const [l, s] of m)
    if (s > best) {
      best = s;
      label = l;
    }
  return label;
}

/**
 * Objective-aware "results" per campaign and per account (plus overall). Each
 * campaign contributes its objective's result action (reach for awareness),
 * summed from campaign-level insights — no ecommerce ROAS assumption.
 */
export async function objectiveResults(w: DateWindow): Promise<{
  campaign: Map<string, ScopeResult>;
  account: Map<string, ScopeResult>;
  total: ScopeResult;
}> {
  const [camps, actions, totals] = await Promise.all([
    db
      .select({
        id: schema.campaigns.id,
        accountId: schema.campaigns.accountId,
        objective: schema.campaigns.objective,
      })
      .from(schema.campaigns),
    actionTotals("campaign", w),
    totalsByEntity("campaign", w),
  ]);
  const spendReach = new Map(totals.map((t) => [t.entityId, t]));
  const campaign = new Map<string, ScopeResult>();
  const acctValue = new Map<string, number>();
  const acctLabelSpend = new Map<string, Map<string, number>>();
  let totalValue = 0;
  const totalLabelSpend = new Map<string, number>();
  for (const c of camps) {
    const rs = resultSpec(c.objective);
    const t = spendReach.get(c.id);
    const value = rs.type === "reach" ? num(t?.reach) : (actions.get(`${c.id}:${rs.type}`) ?? 0);
    const spend = num(t?.spend);
    campaign.set(c.id, { value, label: rs.label });
    acctValue.set(c.accountId, (acctValue.get(c.accountId) ?? 0) + value);
    const ls = acctLabelSpend.get(c.accountId) ?? new Map<string, number>();
    ls.set(rs.label, (ls.get(rs.label) ?? 0) + spend);
    acctLabelSpend.set(c.accountId, ls);
    totalValue += value;
    totalLabelSpend.set(rs.label, (totalLabelSpend.get(rs.label) ?? 0) + spend);
  }
  const account = new Map<string, ScopeResult>();
  for (const [id, value] of acctValue)
    account.set(id, { value, label: dominantLabel(acctLabelSpend.get(id)!) });
  return { campaign, account, total: { value: totalValue, label: dominantLabel(totalLabelSpend) } };
}

/** Account-level totals summed over [since, before). `reach` is the sum of daily reach. */
async function sumWindow(since: string, before?: string, entityId?: string): Promise<Totals> {
  const conds = [eq(schema.insightsDaily.level, "account"), gte(schema.insightsDaily.date, since)];
  if (before) conds.push(lt(schema.insightsDaily.date, before));
  if (entityId) conds.push(eq(schema.insightsDaily.entityId, entityId));
  const [r] = await db
    .select({
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
      impressions: sql<number>`coalesce(sum(${schema.insightsDaily.impressions}),0)`,
      clicks: sql<number>`coalesce(sum(${schema.insightsDaily.clicks}),0)`,
      conversions: sql<number>`coalesce(sum(${schema.insightsDaily.conversions}),0)`,
      revenue: sql<number>`coalesce(sum(${schema.insightsDaily.conversionValues}),0)`,
      reach: sql<number>`coalesce(sum(${schema.insightsDaily.reach}),0)`,
    })
    .from(schema.insightsDaily)
    .where(and(...conds));
  return {
    spend: num(r?.spend),
    impressions: num(r?.impressions),
    clicks: num(r?.clicks),
    conversions: num(r?.conversions),
    revenue: num(r?.revenue),
    reach: num(r?.reach),
  };
}

/** Period-over-period deltas: current trailing window vs the preceding window of equal length. */
export async function windowDeltas(w: DateWindow, entityId?: string): Promise<KpiDeltas> {
  const [cur, prev] = await Promise.all([
    sumWindow(w.since, addDays(w.until, 1), entityId),
    sumWindow(w.prevSince, w.since, entityId),
  ]);
  const c = deriveKpis(cur);
  const p = deriveKpis(prev);
  return {
    spend: pctDelta(c.spend, p.spend),
    revenue: pctDelta(c.revenue, p.revenue),
    roas: pctDelta(c.roas, p.roas),
    ctr: pctDelta(c.ctr, p.ctr),
    conversions: pctDelta(c.conversions, p.conversions),
    impressions: pctDelta(c.impressions, p.impressions),
    cpc: pctDelta(c.cpc, p.cpc),
    cpm: pctDelta(c.cpm, p.cpm),
    reach: pctDelta(c.reach, p.reach),
  };
}

/** Daily account-level series for trend charts and KPI sparklines. */
async function fetchTrend(w: DateWindow, entityId?: string): Promise<TrendPoint[]> {
  const conds = [
    eq(schema.insightsDaily.level, "account"),
    gte(schema.insightsDaily.date, w.since),
    lte(schema.insightsDaily.date, w.until),
  ];
  if (entityId) conds.push(eq(schema.insightsDaily.entityId, entityId));
  const rows = await db
    .select({
      date: schema.insightsDaily.date,
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
      conversions: sql<number>`coalesce(sum(${schema.insightsDaily.conversions}),0)`,
      revenue: sql<number>`coalesce(sum(${schema.insightsDaily.conversionValues}),0)`,
      impressions: sql<number>`coalesce(sum(${schema.insightsDaily.impressions}),0)`,
      clicks: sql<number>`coalesce(sum(${schema.insightsDaily.clicks}),0)`,
      reach: sql<number>`coalesce(sum(${schema.insightsDaily.reach}),0)`,
    })
    .from(schema.insightsDaily)
    .where(and(...conds))
    .groupBy(schema.insightsDaily.date)
    .orderBy(schema.insightsDaily.date);
  return rows.map((r) => ({
    date: r.date,
    spend: num(r.spend),
    conversions: num(r.conversions),
    revenue: num(r.revenue),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    reach: num(r.reach),
  }));
}

export async function fetchAccounts(w: DateWindow): Promise<AdAccount[]> {
  const accounts = await db.select().from(schema.accounts);
  const totals = await totalsByEntity("account", w);
  const totalsById = new Map(totals.map((t) => [t.entityId, t]));
  const results = (await objectiveResults(w)).account;

  // daily spend per account for sparklines
  const sparkRows = await db
    .select({
      entityId: schema.insightsDaily.entityId,
      date: schema.insightsDaily.date,
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
    })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.level, "account"),
        gte(schema.insightsDaily.date, w.since),
        lte(schema.insightsDaily.date, w.until),
      ),
    )
    .groupBy(schema.insightsDaily.entityId, schema.insightsDaily.date)
    .orderBy(schema.insightsDaily.date);
  const sparkById = new Map<string, number[]>();
  for (const r of sparkRows) {
    const arr = sparkById.get(r.entityId) ?? [];
    arr.push(Math.round(num(r.spend)));
    sparkById.set(r.entityId, arr);
  }

  // "Disabled since" = the latest account-status-change activity (best available proxy; null if unsynced).
  const disabledIds = accounts
    .filter((a) => accountStatus(a.status) === "DISABLED")
    .map((a) => a.id);
  const disabledSince = new Map<string, string>();
  if (disabledIds.length > 0) {
    const ev = await db
      .select({
        accountId: schema.metaActivities.accountId,
        at: sql<string>`max(${schema.metaActivities.eventTime})`,
      })
      .from(schema.metaActivities)
      .where(
        and(
          eq(schema.metaActivities.eventType, "ad_account_update_status"),
          inArray(schema.metaActivities.accountId, disabledIds),
        ),
      )
      .groupBy(schema.metaActivities.accountId);
    for (const r of ev) if (r.at) disabledSince.set(r.accountId, String(r.at).slice(0, 10));
  }

  // "Last checked" = the most recent structure/insights sync for the account (null if never synced).
  const syncRows = await db
    .select({
      id: schema.syncState.accountId,
      s: schema.syncState.lastStructureSync,
      i: schema.syncState.lastInsightsSync,
    })
    .from(schema.syncState);
  const lastChecked = new Map<string, string>();
  for (const r of syncRows) {
    const ms = [r.s, r.i].filter(Boolean).map((d) => (d as Date).getTime());
    if (ms.length) lastChecked.set(r.id, new Date(Math.max(...ms)).toISOString());
  }

  return accounts.map((a) => {
    const t = totalsById.get(a.id);
    const totals: Totals = {
      spend: num(t?.spend),
      impressions: num(t?.impressions),
      clicks: num(t?.clicks),
      conversions: num(t?.conversions),
      revenue: num(t?.revenue),
      reach: num(t?.reach),
    };
    const k = deriveKpis(totals);
    return {
      id: a.id,
      name: a.name,
      currency: a.currency,
      status: accountStatus(a.status),
      ...k,
      spark: sparkById.get(a.id) ?? [],
      results: results.get(a.id)?.value ?? 0,
      resultLabel: results.get(a.id)?.label ?? "Results",
      disableReason:
        accountStatus(a.status) === "DISABLED" ? disableReasonLabel(a.disableReason) : null,
      disabledSince:
        accountStatus(a.status) === "DISABLED" ? (disabledSince.get(a.id) ?? null) : null,
      lastChecked: lastChecked.get(a.id) ?? null,
    };
  });
}

export async function fetchOverview(w: DateWindow): Promise<{
  kpis: Kpis;
  deltas: KpiDeltas;
  results: ScopeResult;
  topAccounts: AdAccount[];
  topCampaigns: Campaign[];
  trend: TrendPoint[];
}> {
  const accounts = await fetchAccounts(w);
  const totals: Totals = accounts.reduce(
    (s, a) => ({
      spend: s.spend + a.spend,
      impressions: s.impressions + a.impressions,
      clicks: s.clicks + a.clicks,
      conversions: s.conversions + a.conversions,
      revenue: s.revenue + a.revenue,
      reach: s.reach + a.reach,
    }),
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, reach: 0 },
  );
  const [trend, deltas, campaigns] = await Promise.all([
    fetchTrend(w),
    windowDeltas(w),
    fetchCampaigns(w),
  ]);
  const labelSpend = new Map<string, number>();
  for (const c of campaigns)
    labelSpend.set(c.resultLabel, (labelSpend.get(c.resultLabel) ?? 0) + c.spend);
  return {
    kpis: deriveKpis(totals),
    deltas,
    results: {
      value: campaigns.reduce((n, c) => n + c.results, 0),
      label: dominantLabel(labelSpend),
    },
    topAccounts: [...accounts].sort((a, b) => b.spend - a.spend).slice(0, 6),
    topCampaigns: [...campaigns].sort((a, b) => b.spend - a.spend).slice(0, 5),
    trend,
  };
}

/** All de-duplicated conversion/engagement events across every ad account (chat get_overview). */
export async function fetchOverviewEvents(w: DateWindow): Promise<ClientEvent[]> {
  const rows = await db
    .select({
      actions: schema.insightsDaily.actions,
      actionValues: schema.insightsDaily.actionValues,
    })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.level, "account"),
        gte(schema.insightsDaily.date, w.since),
        lte(schema.insightsDaily.date, w.until),
      ),
    );
  return canonicalEvents(rows);
}

export async function fetchCampaigns(w: DateWindow, accountIds?: string[]): Promise<Campaign[]> {
  // Optional account scope (used by the per-client view). Empty = no rows.
  const inAccts = accountIds ? inArray(schema.campaigns.accountId, accountIds) : undefined;
  const inAcctsSet = accountIds ? inArray(schema.adSets.accountId, accountIds) : undefined;
  const inAcctsAd = accountIds ? inArray(schema.ads.accountId, accountIds) : undefined;
  const [
    campaignRows,
    adsetRows,
    adRows,
    accountRows,
    creativeRows,
    campTotals,
    setTotals,
    adTotals,
    adActions,
  ] = await Promise.all([
    db.select().from(schema.campaigns).where(inAccts),
    db.select().from(schema.adSets).where(inAcctsSet),
    db.select().from(schema.ads).where(inAcctsAd),
    db.select().from(schema.accounts),
    db.select().from(schema.adCreatives),
    totalsByEntity("campaign", w),
    totalsByEntity("adset", w),
    totalsByEntity("ad", w),
    actionTotals("ad", w),
  ]);
  const accName = new Map(accountRows.map((a) => [a.id, a.name]));
  const creativeById = new Map(creativeRows.map((c) => [c.id, c]));
  const campT = new Map(campTotals.map((t) => [t.entityId, t]));
  const setT = new Map(setTotals.map((t) => [t.entityId, t]));
  const adT = new Map(adTotals.map((t) => [t.entityId, t]));

  const adsByAdset = new Map<string, typeof adRows>();
  for (const ad of adRows) {
    const arr = adsByAdset.get(ad.adSetId) ?? [];
    arr.push(ad);
    adsByAdset.set(ad.adSetId, arr);
  }
  const adsetsByCampaign = new Map<string, typeof adsetRows>();
  for (const s of adsetRows) {
    const arr = adsetsByCampaign.get(s.campaignId) ?? [];
    arr.push(s);
    adsetsByCampaign.set(s.campaignId, arr);
  }

  return campaignRows.map((c) => {
    const rs = resultSpec(c.objective);
    const t = campT.get(c.id);
    const k = deriveKpis({
      spend: num(t?.spend),
      impressions: num(t?.impressions),
      clicks: num(t?.clicks),
      conversions: num(t?.conversions),
      revenue: num(t?.revenue),
      reach: num(t?.reach),
    });
    const adSets = (adsetsByCampaign.get(c.id) ?? []).map((s) => {
      const ads = (adsByAdset.get(s.id) ?? []).map((ad) => {
        const at = adT.get(ad.id);
        const ak = deriveKpis({
          spend: num(at?.spend),
          impressions: num(at?.impressions),
          clicks: num(at?.clicks),
          conversions: num(at?.conversions),
          revenue: num(at?.revenue),
          reach: num(at?.reach),
        });
        const creative = ad.creativeId ? creativeById.get(ad.creativeId) : undefined;
        return {
          id: ad.id,
          name: ad.name,
          status: (ad.status ?? "ACTIVE") as Campaign["status"],
          spend: ak.spend,
          impressions: ak.impressions,
          ctr: ak.ctr,
          cpc: ak.cpc,
          roas: ak.roas,
          conversions: ak.conversions,
          results: rs.type === "reach" ? ak.reach : (adActions.get(`${ad.id}:${rs.type}`) ?? 0),
          resultLabel: rs.label,
          format: creativeFormat(creative?.raw),
          thumbHue: hueFromId(ad.id),
          thumbnailUrl: creativeImageUrl(creative?.raw, creative?.thumbnailUrl ?? null),
        };
      });
      const st = setT.get(s.id);
      const sk = deriveKpis({
        spend: num(st?.spend),
        impressions: num(st?.impressions),
        clicks: num(st?.clicks),
        conversions: num(st?.conversions),
        revenue: num(st?.revenue),
        reach: num(st?.reach),
      });
      return {
        id: s.id,
        name: s.name,
        status: (s.status ?? "ACTIVE") as Campaign["status"],
        spend: sk.spend,
        ctr: sk.ctr,
        roas: sk.roas,
        frequency: sk.impressions / Math.max(1, sk.reach),
        results: ads.reduce((n, a) => n + a.results, 0),
        resultLabel: rs.label,
        audience: summarizeTargeting(s.targeting) ?? s.name,
        ads,
      };
    });
    return {
      id: c.id,
      name: c.name,
      status: (c.status ?? "ACTIVE") as Campaign["status"],
      objective: (c.objective ?? "CONVERSIONS") as Campaign["objective"],
      accountId: c.accountId,
      accountName: accName.get(c.accountId) ?? c.accountId,
      spend: k.spend,
      impressions: k.impressions,
      conversions: k.conversions,
      ctr: k.ctr,
      cpc: k.cpc,
      cpm: k.cpm,
      roas: k.roas,
      frequency: k.impressions / Math.max(1, k.reach),
      results: adSets.reduce((n, s) => n + s.results, 0),
      resultLabel: rs.label,
      adSets,
    };
  });
}

export interface AccountMeta {
  amountSpent: number | null;
  balance: number | null;
  spendCap: number | null;
  timezoneName: string | null;
  disableReason: string | null;
  businessName: string | null;
  createdTime: string | null;
}

export async function fetchAccount(
  id: string,
  w: DateWindow,
): Promise<{
  account: AdAccount;
  deltas: KpiDeltas;
  campaigns: Campaign[];
  trend: TrendPoint[];
  meta: AccountMeta | null;
} | null> {
  const accounts = await fetchAccounts(w);
  const account = accounts.find((a) => a.id === id);
  if (!account) return null;
  const [allCampaigns, trend, deltas, metaRows] = await Promise.all([
    fetchCampaigns(w),
    fetchTrend(w, id),
    windowDeltas(w, id),
    db
      .select({
        amountSpent: schema.accounts.amountSpent,
        balance: schema.accounts.balance,
        spendCap: schema.accounts.spendCap,
        timezoneName: schema.accounts.timezoneName,
        disableReason: schema.accounts.disableReason,
        businessName: schema.accounts.businessName,
        createdTime: schema.accounts.createdTime,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, id)),
  ]);
  const m = metaRows[0];
  return {
    account,
    deltas,
    campaigns: allCampaigns.filter((c) => c.accountId === id),
    trend,
    meta: m
      ? {
          amountSpent: m.amountSpent,
          balance: m.balance,
          spendCap: m.spendCap,
          timezoneName: m.timezoneName,
          disableReason: disableReasonLabel(m.disableReason),
          businessName: m.businessName,
          createdTime: m.createdTime ? new Date(m.createdTime).toISOString().slice(0, 10) : null,
        }
      : null,
  };
}

export async function fetchCreatives(w: DateWindow): Promise<CreativeCard[]> {
  const campaigns = await fetchCampaigns(w);
  const cards: CreativeCard[] = [];
  for (const c of campaigns) {
    for (const s of c.adSets) {
      for (const ad of s.ads)
        cards.push({ ...ad, campaign: c.name, account: c.accountName, accountId: c.accountId });
    }
  }
  const top = cards.sort((a, b) => b.spend - a.spend).slice(0, 36);
  // Attach creative copy (ad → creative_id → ad_creatives) for the top cards only.
  const adIds = top.map((t) => t.id);
  if (adIds.length === 0) return top;
  const adRows = await db
    .select({ id: schema.ads.id, creativeId: schema.ads.creativeId })
    .from(schema.ads)
    .where(inArray(schema.ads.id, adIds));
  const creativeIdByAd = new Map(adRows.map((a) => [a.id, a.creativeId]));
  const creativeIds = [...new Set(adRows.map((a) => a.creativeId).filter(Boolean))] as string[];
  const copies = creativeIds.length
    ? await db
        .select({
          id: schema.adCreatives.id,
          title: schema.adCreatives.title,
          body: schema.adCreatives.body,
          callToActionType: schema.adCreatives.callToActionType,
        })
        .from(schema.adCreatives)
        .where(inArray(schema.adCreatives.id, creativeIds))
    : [];
  const copyByCreative = new Map(copies.map((c) => [c.id, c]));
  return top.map((t) => {
    const copy = copyByCreative.get(creativeIdByAd.get(t.id) ?? "");
    return {
      ...t,
      title: copy?.title ?? null,
      body: copy?.body ?? null,
      callToActionType: copy?.callToActionType ?? null,
    };
  });
}

type BreakdownDims = Record<
  | "age"
  | "gender"
  | "publisher_platform"
  | "device_platform"
  | "country"
  | "region"
  | "placement"
  | "hourly",
  BreakdownRow[]
>;

// Map verbose/combo breakdown_types to the dimension keys the UI renders.
const BREAKDOWN_KEY: Record<string, keyof BreakdownDims> = {
  "publisher_platform|platform_position|impression_device": "placement",
  hourly_stats_aggregated_by_advertiser_time_zone: "hourly",
};

// region/placement/hourly are only available at campaign level — aggregated up for the account view.
const SUPPLEMENT_DIMS = [
  "region",
  "publisher_platform|platform_position|impression_device",
  "hourly_stats_aggregated_by_advertiser_time_zone",
];

export async function fetchBreakdowns(
  w: DateWindow,
  scope?: { accountIds?: string[]; campaignId?: string },
): Promise<BreakdownDims> {
  const empty: Record<string, BreakdownRow[]> = {
    age: [],
    gender: [],
    publisher_platform: [],
    device_platform: [],
    country: [],
    region: [],
    placement: [],
    hourly: [],
  };
  const shaped = () => empty as BreakdownDims;
  if (!scope?.campaignId && scope?.accountIds && scope.accountIds.length === 0) return shaped();

  const pull = async (conds: SQL[]) => {
    const rows = await db
      .select({
        breakdownType: schema.insightsBreakdownDaily.breakdownType,
        breakdownValue: schema.insightsBreakdownDaily.breakdownValue,
        spend: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.spend}),0)`,
        conversions: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.conversions}),0)`,
        revenue: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.conversionValues}),0)`,
      })
      .from(schema.insightsBreakdownDaily)
      .where(and(...conds))
      .groupBy(
        schema.insightsBreakdownDaily.breakdownType,
        schema.insightsBreakdownDaily.breakdownValue,
      );
    for (const r of rows) {
      const key = BREAKDOWN_KEY[r.breakdownType] ?? (r.breakdownType as keyof BreakdownDims);
      if (!(key in empty)) continue;
      const label = key === "placement" ? r.breakdownValue.replace(/\|/g, " · ") : r.breakdownValue;
      empty[key].push({
        label,
        spend: num(r.spend),
        conversions: num(r.conversions),
        roas: num(r.revenue) / Math.max(1, num(r.spend)),
      });
    }
  };

  const window = [
    gte(schema.insightsBreakdownDaily.date, w.since),
    lte(schema.insightsBreakdownDaily.date, w.until),
  ];
  if (scope?.campaignId) {
    await pull([
      eq(schema.insightsBreakdownDaily.level, "campaign"),
      eq(schema.insightsBreakdownDaily.entityId, scope.campaignId),
      ...window,
    ]);
  } else {
    const acctFilter = scope?.accountIds
      ? [inArray(schema.insightsBreakdownDaily.accountId, scope.accountIds)]
      : [];
    await pull([eq(schema.insightsBreakdownDaily.level, "account"), ...window, ...acctFilter]);
    await pull([
      eq(schema.insightsBreakdownDaily.level, "campaign"),
      inArray(schema.insightsBreakdownDaily.breakdownType, SUPPLEMENT_DIMS),
      ...window,
      ...acctFilter,
    ]);
  }
  for (const k of Object.keys(empty)) empty[k].sort((a, b) => b.spend - a.spend);
  return shaped();
}

/** Lightweight {id,name} list of the given accounts' campaigns, for filter dropdowns. */
export async function fetchCampaignOptions(
  accountIds: string[],
): Promise<{ id: string; name: string | null }[]> {
  if (accountIds.length === 0) return [];
  return db
    .select({ id: schema.campaigns.id, name: schema.campaigns.name })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.accountId, accountIds))
    .orderBy(schema.campaigns.name);
}

export async function fetchBusinessSummary(): Promise<{
  businessId: string;
  accountCount: number;
  lastSyncAt: string | null;
  syncRunning: boolean;
}> {
  const [cred] = await db
    .select({ businessId: schema.metaCredentials.businessId })
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.id, "singleton"));
  const [counted] = await db.select({ count: sql<number>`count(*)` }).from(schema.accounts);
  const [sync] = await db
    .select({ last: sql<string | null>`max(${schema.syncState.lastInsightsSync})` })
    .from(schema.syncState);
  const last = sync?.last ? new Date(sync.last) : null;
  return {
    businessId: cred?.businessId ?? "",
    accountCount: num(counted?.count),
    lastSyncAt: last && !Number.isNaN(last.getTime()) ? last.toISOString() : null,
    syncRunning: isCycleRunning(),
  };
}

export async function fetchAccountOptions(): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .orderBy(schema.accounts.name);
}

export async function searchEntities(q: string): Promise<{
  clients: { id: string; name: string; status: string | null }[];
  accounts: { id: string; name: string }[];
  campaigns: { id: string; name: string; accountId: string }[];
}> {
  const term = q.trim();
  if (!term) return { clients: [], accounts: [], campaigns: [] };
  const like = `%${term}%`;
  const [clients, accounts, campaigns] = await Promise.all([
    db
      .select({ id: schema.clients.id, name: schema.clients.name, status: schema.clients.status })
      .from(schema.clients)
      .where(ilike(schema.clients.name, like))
      .limit(8),
    db
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .where(or(ilike(schema.accounts.name, like), ilike(schema.accounts.id, like)))
      .limit(8),
    db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        accountId: schema.campaigns.accountId,
      })
      .from(schema.campaigns)
      .where(ilike(schema.campaigns.name, like))
      .limit(8),
  ]);
  return { clients, accounts, campaigns };
}

export const CSV_KINDS = ["accounts", "campaigns", "creatives", "breakdowns"] as const;
export type CsvKind = (typeof CSV_KINDS)[number];

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

export async function exportCsv(kind: CsvKind, w: DateWindow): Promise<string> {
  if (kind === "campaigns") {
    const rows = await fetchCampaigns(w);
    return toCsv(
      [
        "id",
        "name",
        "account",
        "status",
        "objective",
        "spend",
        "impressions",
        "conversions",
        "ctr",
        "cpc",
        "roas",
      ],
      rows.map((x) => [
        x.id,
        x.name,
        x.accountName,
        x.status,
        x.objective,
        x.spend.toFixed(2),
        x.impressions,
        x.conversions,
        x.ctr.toFixed(2),
        x.cpc.toFixed(2),
        x.roas.toFixed(2),
      ]),
    );
  }
  if (kind === "creatives") {
    const rows = await fetchCreatives(w);
    return toCsv(
      ["id", "name", "account", "campaign", "format", "spend", "impressions", "ctr", "cpc", "roas"],
      rows.map((x) => [
        x.id,
        x.name,
        x.account,
        x.campaign,
        x.format,
        x.spend.toFixed(2),
        x.impressions,
        x.ctr.toFixed(2),
        x.cpc.toFixed(2),
        x.roas.toFixed(2),
      ]),
    );
  }
  if (kind === "breakdowns") {
    const b = await fetchBreakdowns(w);
    const rows: (string | number)[][] = [];
    for (const [dim, items] of Object.entries(b)) {
      for (const it of items)
        rows.push([dim, it.label, it.spend.toFixed(2), it.conversions, it.roas.toFixed(2)]);
    }
    return toCsv(["dimension", "value", "spend", "conversions", "roas"], rows);
  }
  const rows = await fetchAccounts(w);
  return toCsv(
    ["id", "name", "status", "spend", "impressions", "clicks", "conversions", "ctr", "cpc", "roas"],
    rows.map((x) => [
      x.id,
      x.name,
      x.status,
      x.spend.toFixed(2),
      x.impressions,
      x.clicks,
      x.conversions,
      x.ctr.toFixed(2),
      x.cpc.toFixed(2),
      x.roas.toFixed(2),
    ]),
  );
}
