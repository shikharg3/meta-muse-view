import { and, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { accountStatus, deriveKpis, pctDelta, windowStart, type Totals } from "@/server/agg";
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

const num = (v: unknown): number => Number(v ?? 0);

/** Summed insight totals grouped by entity, for a level over the window. */
function totalsByEntity(level: string, since: string) {
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
    .where(and(eq(schema.insightsDaily.level, level), gte(schema.insightsDaily.date, since)))
    .groupBy(schema.insightsDaily.entityId);
}

/** Action sums keyed `${entityId}:${action_type}` at a level (actions live in jsonb). */
async function actionTotals(level: string, since: string): Promise<Map<string, number>> {
  const rows = await db.execute(sql`
    select entity_id, elem->>'action_type' as type, sum((elem->>'value')::double precision) as val
    from insights_daily
    cross join lateral jsonb_array_elements(actions) elem
    where level = ${level} and date >= ${since}
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
export async function objectiveResults(since: string): Promise<{
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
    actionTotals("campaign", since),
    totalsByEntity("campaign", since),
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
export async function windowDeltas(days: number, entityId?: string): Promise<KpiDeltas> {
  const since = windowStart(days);
  const prevSince = windowStart(days * 2);
  const [cur, prev] = await Promise.all([
    sumWindow(since, undefined, entityId),
    sumWindow(prevSince, since, entityId),
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
async function fetchTrend(since: string, entityId?: string): Promise<TrendPoint[]> {
  const conds = [eq(schema.insightsDaily.level, "account"), gte(schema.insightsDaily.date, since)];
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

export async function fetchAccounts(days: number): Promise<AdAccount[]> {
  const since = windowStart(days);
  const accounts = await db.select().from(schema.accounts);
  const totals = await totalsByEntity("account", since);
  const totalsById = new Map(totals.map((t) => [t.entityId, t]));
  const results = (await objectiveResults(since)).account;

  // daily spend per account for sparklines
  const sparkSince = windowStart(days);
  const sparkRows = await db
    .select({
      entityId: schema.insightsDaily.entityId,
      date: schema.insightsDaily.date,
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
    })
    .from(schema.insightsDaily)
    .where(
      and(eq(schema.insightsDaily.level, "account"), gte(schema.insightsDaily.date, sparkSince)),
    )
    .groupBy(schema.insightsDaily.entityId, schema.insightsDaily.date)
    .orderBy(schema.insightsDaily.date);
  const sparkById = new Map<string, number[]>();
  for (const r of sparkRows) {
    const arr = sparkById.get(r.entityId) ?? [];
    arr.push(Math.round(num(r.spend)));
    sparkById.set(r.entityId, arr);
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
    };
  });
}

export async function fetchOverview(days: number): Promise<{
  kpis: Kpis;
  deltas: KpiDeltas;
  results: ScopeResult;
  topAccounts: AdAccount[];
  topCampaigns: Campaign[];
  trend: TrendPoint[];
}> {
  const since = windowStart(days);
  const accounts = await fetchAccounts(days);
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
    fetchTrend(since),
    windowDeltas(days),
    fetchCampaigns(days),
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

export async function fetchCampaigns(days: number, accountIds?: string[]): Promise<Campaign[]> {
  const since = windowStart(days);
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
    totalsByEntity("campaign", since),
    totalsByEntity("adset", since),
    totalsByEntity("ad", since),
    actionTotals("ad", since),
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
        results: ads.reduce((n, a) => n + a.results, 0),
        resultLabel: rs.label,
        audience: s.name,
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
      results: adSets.reduce((n, s) => n + s.results, 0),
      resultLabel: rs.label,
      adSets,
    };
  });
}

export async function fetchAccount(
  id: string,
  days: number,
): Promise<{
  account: AdAccount;
  deltas: KpiDeltas;
  campaigns: Campaign[];
  trend: TrendPoint[];
} | null> {
  const accounts = await fetchAccounts(days);
  const account = accounts.find((a) => a.id === id);
  if (!account) return null;
  const since = windowStart(days);
  const [allCampaigns, trend, deltas] = await Promise.all([
    fetchCampaigns(days),
    fetchTrend(since, id),
    windowDeltas(days, id),
  ]);
  return {
    account,
    deltas,
    campaigns: allCampaigns.filter((c) => c.accountId === id),
    trend,
  };
}

export async function fetchCreatives(days: number): Promise<CreativeCard[]> {
  const campaigns = await fetchCampaigns(days);
  const out: CreativeCard[] = [];
  for (const c of campaigns) {
    for (const s of c.adSets) {
      for (const ad of s.ads) out.push({ ...ad, campaign: c.name, account: c.accountName });
    }
  }
  return out.sort((a, b) => b.spend - a.spend).slice(0, 36);
}

export async function fetchBreakdowns(
  days: number,
): Promise<
  Record<"age" | "gender" | "publisher_platform" | "device_platform" | "country", BreakdownRow[]>
> {
  const since = windowStart(days);
  const rows = await db
    .select({
      breakdownType: schema.insightsBreakdownDaily.breakdownType,
      breakdownValue: schema.insightsBreakdownDaily.breakdownValue,
      spend: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.spend}),0)`,
      conversions: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.conversions}),0)`,
      revenue: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.conversionValues}),0)`,
    })
    .from(schema.insightsBreakdownDaily)
    .where(gte(schema.insightsBreakdownDaily.date, since))
    .groupBy(
      schema.insightsBreakdownDaily.breakdownType,
      schema.insightsBreakdownDaily.breakdownValue,
    );
  const empty = {
    age: [],
    gender: [],
    publisher_platform: [],
    device_platform: [],
    country: [],
  } as Record<string, BreakdownRow[]>;
  for (const r of rows) {
    (empty[r.breakdownType] ??= []).push({
      label: r.breakdownValue,
      spend: num(r.spend),
      conversions: num(r.conversions),
      roas: num(r.revenue) / Math.max(1, num(r.spend)),
    });
  }
  for (const k of Object.keys(empty)) empty[k].sort((a, b) => b.spend - a.spend);
  return empty as Record<
    "age" | "gender" | "publisher_platform" | "device_platform" | "country",
    BreakdownRow[]
  >;
}

export async function fetchBusinessSummary(): Promise<{
  businessId: string;
  accountCount: number;
  lastSyncAt: string | null;
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

export async function exportCsv(kind: CsvKind, days: number): Promise<string> {
  if (kind === "campaigns") {
    const rows = await fetchCampaigns(days);
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
    const rows = await fetchCreatives(days);
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
    const b = await fetchBreakdowns(days);
    const rows: (string | number)[][] = [];
    for (const [dim, items] of Object.entries(b)) {
      for (const it of items)
        rows.push([dim, it.label, it.spend.toFixed(2), it.conversions, it.roas.toFixed(2)]);
    }
    return toCsv(["dimension", "value", "spend", "conversions", "roas"], rows);
  }
  const rows = await fetchAccounts(days);
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
