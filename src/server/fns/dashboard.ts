import { and, eq, gte, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
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
import { brandTitles } from "@/notion/parse";
import {
  creativeFormat,
  creativeImageUrl,
  hueFromId,
  resultSpec,
  type CreativeFacts,
} from "@/server/creative";
import type {
  Ad,
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

/** One row of summed insight totals for an entity over a window. */
export interface EntityTotals {
  entityId: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  reach: number;
}

/** Summed insight totals grouped by entity, for a level over the window. */
function totalsByEntity(level: string, w: DateWindow, accountIds?: string[]) {
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
        accountIds ? inArray(schema.insightsDaily.accountId, accountIds) : undefined,
      ),
    )
    .groupBy(schema.insightsDaily.entityId);
}

/** Action sums keyed `${entityId}:${action_type}` at a level (actions live in jsonb). */
async function actionTotals(
  level: string,
  w: DateWindow,
  accountIds?: string[],
): Promise<Map<string, number>> {
  // Scoping by account matters: unfiltered, the ad-level lateral unnest walks every account's rows
  // (~1s) even when the caller only wants one client. The id list is bound as a single jsonb param —
  // drizzle's sql template expands a JS array into separate placeholders, which `any()` rejects.
  const acct = accountIds
    ? sql`and account_id in (select jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb))`
    : sql``;
  const rows = await db.execute(sql`
    select entity_id, elem->>'action_type' as type, sum((elem->>'value')::double precision) as val
    from insights_daily
    cross join lateral jsonb_array_elements(actions) elem
    where level = ${level} and date >= ${w.since} and date <= ${w.until} ${acct}
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

/** accountId → the date it most recently flipped to DISABLED, from the `ad_account_update_status`
 *  change-log (Meta exposes no explicit disable timestamp, so this is the best signal). Absent for
 *  ids with no synced status-change event. */
export async function disabledSinceMap(disabledIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (disabledIds.length === 0) return map;
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
  for (const r of ev) if (r.at) map.set(r.accountId, String(r.at).slice(0, 10));
  return map;
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
  const disabledSince = await disabledSinceMap(disabledIds);

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

export async function fetchCampaigns(
  w: DateWindow,
  accountIds?: string[],
  opts: { includeAds?: boolean } = {},
): Promise<Campaign[]> {
  // Optional account scope (used by the per-client view). Empty = no rows.
  const inAccts = accountIds ? inArray(schema.campaigns.accountId, accountIds) : undefined;
  const inAcctsSet = accountIds ? inArray(schema.adSets.accountId, accountIds) : undefined;
  const inAcctsAd = accountIds ? inArray(schema.ads.accountId, accountIds) : undefined;
  // Ads are the bulk of this payload (7.3k ads ≈ 3.7 MB) and are only needed on drill-down, so they
  // are opt-in; `adCount` still lets the UI show how many there are. Results come from Meta's own
  // ad-set/campaign action totals rather than summing ads, so they don't depend on ads being loaded.
  const withAds = opts.includeAds === true;
  const [
    campaignRows,
    adsetRows,
    adRows,
    adCounts,
    accountRows,
    creativeRows,
    campTotals,
    setTotals,
    adTotals,
    adActions,
    setActions,
    campActions,
  ] = await Promise.all([
    db.select().from(schema.campaigns).where(inAccts),
    db.select().from(schema.adSets).where(inAcctsSet),
    // Narrow column list: the full row pulls jsonb payloads this view never reads.
    withAds
      ? db
          .select({
            id: schema.ads.id,
            name: schema.ads.name,
            status: schema.ads.status,
            adSetId: schema.ads.adSetId,
            accountId: schema.ads.accountId,
            creativeId: schema.ads.creativeId,
          })
          .from(schema.ads)
          .where(inAcctsAd)
      : Promise.resolve(
          [] as {
            id: string;
            name: string;
            status: string | null;
            adSetId: string;
            accountId: string;
            creativeId: string | null;
          }[],
        ),
    // Cheap count so the UI can show "N ads" without shipping them.
    db
      .select({ adSetId: schema.ads.adSetId, n: sql<number>`count(*)` })
      .from(schema.ads)
      .where(inAcctsAd)
      .groupBy(schema.ads.adSetId),
    db
      .select({
        id: schema.accounts.id,
        name: schema.accounts.name,
        status: schema.accounts.status,
      })
      .from(schema.accounts),
    // Project ONLY the five creative fields the UI needs (selecting `raw` loaded ~134 MB), and only
    // when ads are actually being returned — creatives exist purely to decorate ads.
    withAds
      ? db
          .select({
            id: schema.adCreatives.id,
            thumbnailUrl: schema.adCreatives.thumbnailUrl,
            objectType: sql<string | null>`${schema.adCreatives.raw}->>'object_type'`,
            imageUrl: sql<string | null>`${schema.adCreatives.raw}->>'image_url'`,
            videoImageUrl: sql<
              string | null
            >`${schema.adCreatives.raw}->'object_story_spec'->'video_data'->>'image_url'`,
            linkPicture: sql<
              string | null
            >`${schema.adCreatives.raw}->'object_story_spec'->'link_data'->>'picture'`,
            childAttachments: sql<number>`coalesce(jsonb_array_length(${schema.adCreatives.raw}->'object_story_spec'->'link_data'->'child_attachments'), 0)`,
          })
          .from(schema.adCreatives)
          // Only creatives referenced by ads in scope — a client view needs a handful, not all 24k.
          .where(
            accountIds
              ? inArray(
                  schema.adCreatives.id,
                  db.select({ id: schema.ads.creativeId }).from(schema.ads).where(inAcctsAd),
                )
              : undefined,
          )
      : Promise.resolve([] as ({ id: string } & CreativeFacts)[]),
    totalsByEntity("campaign", w, accountIds),
    totalsByEntity("adset", w, accountIds),
    withAds ? totalsByEntity("ad", w, accountIds) : Promise.resolve([] as EntityTotals[]),
    withAds ? actionTotals("ad", w, accountIds) : Promise.resolve(new Map<string, number>()),
    actionTotals("adset", w, accountIds),
    actionTotals("campaign", w, accountIds),
  ]);
  const accName = new Map(accountRows.map((a) => [a.id, a.name]));
  // A disabled ad account stops delivery for EVERYTHING under it, but Meta leaves each campaign's
  // own `status` as ACTIVE (only the account is disabled). Surface PAUSED so the UI never implies a
  // dead account is still running.
  const disabledAccounts = new Set(
    accountRows.filter((a) => accountStatus(a.status) === "DISABLED").map((a) => a.id),
  );
  const displayStatus = (accountId: string, own: string | null): Campaign["status"] =>
    (disabledAccounts.has(accountId) ? "PAUSED" : (own ?? "ACTIVE")) as Campaign["status"];
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
  const adCountBySet = new Map(adCounts.map((r) => [r.adSetId, Number(r.n)]));

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
          status: displayStatus(ad.accountId, ad.status),
          spend: ak.spend,
          impressions: ak.impressions,
          ctr: ak.ctr,
          cpc: ak.cpc,
          roas: ak.roas,
          conversions: ak.conversions,
          results: rs.type === "reach" ? ak.reach : (adActions.get(`${ad.id}:${rs.type}`) ?? 0),
          resultLabel: rs.label,
          format: creativeFormat(creative),
          thumbHue: hueFromId(ad.id),
          thumbnailUrl: creativeImageUrl(creative),
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
        status: displayStatus(s.accountId, s.status),
        spend: sk.spend,
        ctr: sk.ctr,
        roas: sk.roas,
        frequency: sk.impressions / Math.max(1, sk.reach),
        // From the ad-set's OWN action totals, so it is correct whether or not ads were loaded.
        results: rs.type === "reach" ? sk.reach : (setActions.get(`${s.id}:${rs.type}`) ?? 0),
        resultLabel: rs.label,
        audience: summarizeTargeting(s.targeting) ?? s.name,
        adCount: adCountBySet.get(s.id) ?? 0,
        ads,
      };
    });
    return {
      id: c.id,
      name: c.name,
      status: displayStatus(c.accountId, c.status),
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
      // Campaign-level action totals — independent of whether ads/ad sets were loaded.
      results: rs.type === "reach" ? k.reach : (campActions.get(`${c.id}:${rs.type}`) ?? 0),
      resultLabel: rs.label,
      adSets,
    };
  });
}

/**
 * Ads for ONE ad set, loaded on drill-down. The campaign list deliberately omits ads (they were
 * ~3.7 MB of a 4 MB payload), so the table fetches them per ad set when a row is expanded.
 */
export async function fetchAdSetAds(adSetId: string, w: DateWindow): Promise<Ad[]> {
  const [set] = await db
    .select({ id: schema.adSets.id, campaignId: schema.adSets.campaignId })
    .from(schema.adSets)
    .where(eq(schema.adSets.id, adSetId));
  if (!set) return [];
  const [campaign] = await db
    .select({ objective: schema.campaigns.objective })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, set.campaignId));
  const rs = resultSpec(campaign?.objective);

  const adRows = await db
    .select({
      id: schema.ads.id,
      name: schema.ads.name,
      status: schema.ads.status,
      accountId: schema.ads.accountId,
      creativeId: schema.ads.creativeId,
    })
    .from(schema.ads)
    .where(eq(schema.ads.adSetId, adSetId));
  if (adRows.length === 0) return [];
  const adIds = adRows.map((a) => a.id);
  const creativeIds = adRows.map((a) => a.creativeId).filter((id): id is string => id !== null);

  const [totals, actions, creatives, accountRows] = await Promise.all([
    db
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
          eq(schema.insightsDaily.level, "ad"),
          inArray(schema.insightsDaily.entityId, adIds),
          gte(schema.insightsDaily.date, w.since),
          lte(schema.insightsDaily.date, w.until),
        ),
      )
      .groupBy(schema.insightsDaily.entityId),
    db.execute(sql`
      select entity_id, elem->>'action_type' as type, sum((elem->>'value')::double precision) as val
      from insights_daily
      cross join lateral jsonb_array_elements(actions) elem
      where level = 'ad' and date >= ${w.since} and date <= ${w.until}
        and entity_id in (select jsonb_array_elements_text(${JSON.stringify(adIds)}::jsonb))
      group by 1, 2
    `),
    creativeIds.length
      ? db
          .select({
            id: schema.adCreatives.id,
            thumbnailUrl: schema.adCreatives.thumbnailUrl,
            objectType: sql<string | null>`${schema.adCreatives.raw}->>'object_type'`,
            imageUrl: sql<string | null>`${schema.adCreatives.raw}->>'image_url'`,
            videoImageUrl: sql<
              string | null
            >`${schema.adCreatives.raw}->'object_story_spec'->'video_data'->>'image_url'`,
            linkPicture: sql<
              string | null
            >`${schema.adCreatives.raw}->'object_story_spec'->'link_data'->>'picture'`,
            childAttachments: sql<number>`coalesce(jsonb_array_length(${schema.adCreatives.raw}->'object_story_spec'->'link_data'->'child_attachments'), 0)`,
          })
          .from(schema.adCreatives)
          .where(inArray(schema.adCreatives.id, creativeIds))
      : Promise.resolve([] as ({ id: string } & CreativeFacts)[]),
    db
      .select({ id: schema.accounts.id, status: schema.accounts.status })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, [...new Set(adRows.map((a) => a.accountId))])),
  ]);

  const adT = new Map(totals.map((t) => [t.entityId, t]));
  const actionByKey = new Map<string, number>();
  for (const r of actions as unknown as { entity_id: string; type: string; val: number }[]) {
    actionByKey.set(`${r.entity_id}:${r.type}`, Number(r.val) || 0);
  }
  const creativeById = new Map(creatives.map((c) => [c.id, c]));
  const disabled = new Set(
    accountRows.filter((a) => accountStatus(a.status) === "DISABLED").map((a) => a.id),
  );

  return adRows.map((ad) => {
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
      // A disabled account stops delivery regardless of the ad's own status.
      status: (disabled.has(ad.accountId) ? "PAUSED" : (ad.status ?? "ACTIVE")) as Ad["status"],
      spend: ak.spend,
      impressions: ak.impressions,
      ctr: ak.ctr,
      cpc: ak.cpc,
      roas: ak.roas,
      conversions: ak.conversions,
      results: rs.type === "reach" ? ak.reach : (actionByKey.get(`${ad.id}:${rs.type}`) ?? 0),
      resultLabel: rs.label,
      format: creativeFormat(creative),
      thumbHue: hueFromId(ad.id),
      thumbnailUrl: creativeImageUrl(creative),
    };
  });
}

export interface AdEntityRow {
  name: string;
  /** Owning campaign (ad-set level) or owning ad set (ad level). */
  parent: string;
  account: string;
  status: string | null;
  spend: number;
  impressions: number;
  ctr: number;
  cpc: number;
  results: number;
  resultLabel: string;
  /** De-duplicated conversion/engagement events for this entity (purchases, leads, registrations…). */
  events: ClientEvent[];
  /** Number of entities summed into this row when grouped by name (absent/1 when ungrouped). */
  merged?: number;
}

/** A client's accounts, optionally narrowed to one campaign or to an allowed campaign set (used when
 *  an account is shared with another client and only some campaigns belong to this one). */
export interface AdScope {
  accountIds: string[];
  campaignId?: string;
  /** Whitelist of campaign ids; entities under any other campaign are excluded. */
  campaignIds?: string[];
}

/** True when a campaign passes the scope's single-campaign narrowing AND its whitelist (if any). */
const inCampaignScope = (scope: AdScope, campaignId: string | undefined): boolean => {
  if (campaignId === undefined) return false;
  if (scope.campaignId && campaignId !== scope.campaignId) return false;
  if (scope.campaignIds && !scope.campaignIds.includes(campaignId)) return false;
  return true;
};

/**
 * Ad-set-level (or ad-level) rows for a scope, each with media KPIs, the objective result, and the
 * full de-duplicated conversion breakdown for that entity. `groupByName` sums entities that share a
 * name — e.g. state-named ad sets spread across several campaigns collapse into one row per state.
 */
export async function fetchAdEntities(
  scope: AdScope,
  level: "adset" | "ad",
  w: DateWindow,
  opts: { groupByName?: boolean } = {},
): Promise<AdEntityRow[]> {
  const acctIds = scope.accountIds;
  if (acctIds.length === 0) return [];
  const [campaignRows, adsetRows, adRows, accountRows, insightRows] = await Promise.all([
    db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        objective: schema.campaigns.objective,
      })
      .from(schema.campaigns)
      .where(inArray(schema.campaigns.accountId, acctIds)),
    db
      .select({
        id: schema.adSets.id,
        name: schema.adSets.name,
        campaignId: schema.adSets.campaignId,
        accountId: schema.adSets.accountId,
        status: schema.adSets.status,
      })
      .from(schema.adSets)
      .where(inArray(schema.adSets.accountId, acctIds)),
    level === "ad"
      ? db
          .select({
            id: schema.ads.id,
            name: schema.ads.name,
            adSetId: schema.ads.adSetId,
            accountId: schema.ads.accountId,
            status: schema.ads.status,
          })
          .from(schema.ads)
          .where(inArray(schema.ads.accountId, acctIds))
      : Promise.resolve(
          [] as {
            id: string;
            name: string;
            adSetId: string;
            accountId: string;
            status: string | null;
          }[],
        ),
    db
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, acctIds)),
    db
      .select({
        entityId: schema.insightsDaily.entityId,
        spend: schema.insightsDaily.spend,
        impressions: schema.insightsDaily.impressions,
        clicks: schema.insightsDaily.clicks,
        reach: schema.insightsDaily.reach,
        conversions: schema.insightsDaily.conversions,
        revenue: schema.insightsDaily.conversionValues,
        actions: schema.insightsDaily.actions,
        actionValues: schema.insightsDaily.actionValues,
      })
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, level),
          gte(schema.insightsDaily.date, w.since),
          lte(schema.insightsDaily.date, w.until),
          inArray(schema.insightsDaily.accountId, acctIds),
        ),
      ),
  ]);
  const accName = new Map(accountRows.map((a) => [a.id, a.name]));
  const campById = new Map(campaignRows.map((c) => [c.id, c]));
  const adsetById = new Map(adsetRows.map((s) => [s.id, s]));

  // Entity metadata for the requested level, narrowed to the campaign when scoped.
  interface Meta {
    name: string;
    parent: string;
    accountId: string;
    status: string | null;
    objective: string | null;
  }
  const meta = new Map<string, Meta>();
  if (level === "adset") {
    for (const s of adsetRows) {
      if (!inCampaignScope(scope, s.campaignId)) continue;
      const c = campById.get(s.campaignId);
      meta.set(s.id, {
        name: s.name,
        parent: c?.name ?? s.campaignId,
        accountId: s.accountId,
        status: s.status,
        objective: c?.objective ?? null,
      });
    }
  } else {
    for (const a of adRows) {
      const s = adsetById.get(a.adSetId);
      if (!inCampaignScope(scope, s?.campaignId)) continue;
      const c = s ? campById.get(s.campaignId) : undefined;
      meta.set(a.id, {
        name: a.name,
        parent: s?.name ?? a.adSetId,
        accountId: a.accountId,
        status: a.status,
        objective: c?.objective ?? null,
      });
    }
  }

  // Bucket insight rows by entity (or by name when grouping), summing media + collecting raw
  // actions so canonicalEvents can de-dupe conversions the same way the client view does.
  interface Bucket {
    name: string;
    parents: Set<string>;
    accounts: Set<string>;
    status: string | null;
    spend: number;
    impressions: number;
    clicks: number;
    reach: number;
    conversions: number;
    revenue: number;
    rows: { actions: unknown; actionValues: unknown }[];
    actionSums: Map<string, number>;
    resTypeSpend: Map<string, number>;
    resTypeLabel: Map<string, string>;
    merged: number;
  }
  const buckets = new Map<string, Bucket>();
  const seen = new Set<string>();
  for (const r of insightRows) {
    const m = meta.get(r.entityId);
    if (!m) continue;
    const key = opts.groupByName ? m.name.toLowerCase() : r.entityId;
    let b = buckets.get(key);
    if (!b) {
      b = {
        name: m.name,
        parents: new Set(),
        accounts: new Set(),
        status: m.status,
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        conversions: 0,
        revenue: 0,
        rows: [],
        actionSums: new Map(),
        resTypeSpend: new Map(),
        resTypeLabel: new Map(),
        merged: 0,
      };
      buckets.set(key, b);
    }
    b.parents.add(m.parent);
    b.accounts.add(accName.get(m.accountId) ?? m.accountId);
    b.spend += num(r.spend);
    b.impressions += num(r.impressions);
    b.clicks += num(r.clicks);
    b.reach = Math.max(b.reach, num(r.reach));
    b.conversions += num(r.conversions);
    b.revenue += num(r.revenue);
    b.rows.push({ actions: r.actions, actionValues: r.actionValues });
    for (const el of (r.actions as { action_type: string; value: string }[] | null) ?? [])
      b.actionSums.set(
        el.action_type,
        (b.actionSums.get(el.action_type) ?? 0) + (Number(el.value) || 0),
      );
    // Attribute the entity's objective result to its label (dominant label wins when grouped).
    if (!seen.has(r.entityId)) {
      seen.add(r.entityId);
      b.merged += 1;
    }
    const rs = resultSpec(m.objective);
    b.resTypeSpend.set(rs.type, (b.resTypeSpend.get(rs.type) ?? 0) + num(r.spend));
    b.resTypeLabel.set(rs.type, rs.label);
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rows = [...buckets.values()].map((b) => {
    const k = deriveKpis({
      spend: b.spend,
      impressions: b.impressions,
      clicks: b.clicks,
      conversions: b.conversions,
      revenue: b.revenue,
      reach: b.reach,
    });
    // Objective result: the metric for the dominant-by-spend objective (reach for awareness).
    let domType = "omni_purchase";
    let bestSpend = -1;
    for (const [t, sp] of b.resTypeSpend)
      if (sp > bestSpend) {
        bestSpend = sp;
        domType = t;
      }
    const results = domType === "reach" ? b.reach : (b.actionSums.get(domType) ?? 0);
    const label = b.resTypeLabel.get(domType) ?? "Results";
    return {
      name: b.name,
      parent: b.parents.size === 1 ? [...b.parents][0] : `${b.parents.size} campaigns`,
      account: b.accounts.size === 1 ? [...b.accounts][0] : `${b.accounts.size} accounts`,
      status: b.merged === 1 ? b.status : null,
      spend: round2(k.spend),
      impressions: k.impressions,
      ctr: round2(k.ctr),
      cpc: round2(k.cpc),
      results: Math.round(results),
      resultLabel: label,
      events: canonicalEvents(b.rows),
      ...(b.merged > 1 ? { merged: b.merged } : {}),
    };
  });
  rows.sort((a, b) => b.spend - a.spend);
  return rows;
}

/**
 * Resolve a subject to an ad-set/ad scope by matching a CAMPAIGN then an ACCOUNT (client matching is
 * handled by the caller via resolveClient). Returns the scope, an ambiguity candidate list, or null.
 */
export async function resolveAdScopeSubject(
  subject: string,
): Promise<{ scope: AdScope; label: string } | { candidates: string[] } | null> {
  const s = subject.trim();
  if (!s) return null;
  const like = `%${s}%`;
  const camps = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      accountId: schema.campaigns.accountId,
    })
    .from(schema.campaigns)
    .where(or(eq(schema.campaigns.id, s), ilike(schema.campaigns.name, like)))
    .limit(6);
  if (camps.length === 1)
    return {
      scope: { accountIds: [camps[0].accountId], campaignId: camps[0].id },
      label: `campaign "${camps[0].name}"`,
    };
  if (camps.length > 1) return { candidates: camps.map((c) => c.name) };
  const accts = await db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .where(or(eq(schema.accounts.id, s), ilike(schema.accounts.name, like)))
    .limit(6);
  if (accts.length === 1)
    return { scope: { accountIds: [accts[0].id] }, label: `account "${accts[0].name}"` };
  if (accts.length > 1) return { candidates: accts.map((a) => a.name) };
  return null;
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
  brands: { brand: string; clientId: string; clientName: string }[];
}> {
  const term = q.trim();
  if (!term) return { clients: [], accounts: [], campaigns: [], brands: [] };
  const like = `%${term}%`;
  const lower = term.toLowerCase();
  const nlower = lower.replace(/[^a-z0-9]+/g, ""); // spacing/punct-insensitive ("LuckyRebel" ~ "Lucky Rebel")
  const [clients, accounts, campaigns, liveClients] = await Promise.all([
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
    db
      .select({ id: schema.clients.id, name: schema.clients.name, raw: schema.clients.raw })
      .from(schema.clients)
      .where(isNull(schema.clients.removedAt)),
  ]);
  // Brand (Notion campaign-row title) -> holding client, so a brand query ("Lucky Rebel") reaches
  // the agency client that groups it ("OneAgency"). Skip titles equal to the client's own name.
  const brands: { brand: string; clientId: string; clientName: string }[] = [];
  for (const c of liveClients) {
    for (const t of brandTitles(c.raw)) {
      const tl = t.toLowerCase();
      const matches =
        tl.includes(lower) || (nlower !== "" && tl.replace(/[^a-z0-9]+/g, "").includes(nlower));
      if (tl !== c.name.toLowerCase() && matches) {
        brands.push({ brand: t, clientId: c.id, clientName: c.name });
      }
    }
    if (brands.length >= 8) break;
  }
  return { clients, accounts, campaigns, brands: brands.slice(0, 8) };
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
