import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { deriveKpis, windowStart, type Totals } from "@/server/agg";
import type { AdAccount, BreakdownRow, Campaign, CreativeCard, Kpis, TrendPoint } from "@/lib/types";

const WINDOW_DAYS = 30;
const SPARK_DAYS = 14;

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

export async function fetchAccounts(): Promise<AdAccount[]> {
  const since = windowStart(WINDOW_DAYS);
  const accounts = await db.select().from(schema.accounts);
  const totals = await totalsByEntity("account", since);
  const totalsById = new Map(totals.map((t) => [t.entityId, t]));

  // daily spend per account for sparklines
  const sparkSince = windowStart(SPARK_DAYS);
  const sparkRows = await db
    .select({
      entityId: schema.insightsDaily.entityId,
      date: schema.insightsDaily.date,
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
    })
    .from(schema.insightsDaily)
    .where(and(eq(schema.insightsDaily.level, "account"), gte(schema.insightsDaily.date, sparkSince)))
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
      spend: num(t?.spend), impressions: num(t?.impressions), clicks: num(t?.clicks),
      conversions: num(t?.conversions), revenue: num(t?.revenue), reach: num(t?.reach),
    };
    const k = deriveKpis(totals);
    return {
      id: a.id, name: a.name, currency: a.currency,
      status: (a.status ?? "ACTIVE") as AdAccount["status"],
      ...k, spark: sparkById.get(a.id) ?? [],
    };
  });
}

export async function fetchOverview(): Promise<{ kpis: Kpis; topAccounts: AdAccount[]; topCampaigns: Campaign[]; trend: TrendPoint[] }> {
  const since = windowStart(WINDOW_DAYS);
  const accounts = await fetchAccounts();
  const totals: Totals = accounts.reduce(
    (s, a) => ({
      spend: s.spend + a.spend, impressions: s.impressions + a.impressions, clicks: s.clicks + a.clicks,
      conversions: s.conversions + a.conversions, revenue: s.revenue + a.revenue, reach: s.reach + a.reach,
    }),
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, reach: 0 },
  );
  const trendRows = await db
    .select({
      date: schema.insightsDaily.date,
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
      conversions: sql<number>`coalesce(sum(${schema.insightsDaily.conversions}),0)`,
      revenue: sql<number>`coalesce(sum(${schema.insightsDaily.conversionValues}),0)`,
    })
    .from(schema.insightsDaily)
    .where(and(eq(schema.insightsDaily.level, "account"), gte(schema.insightsDaily.date, since)))
    .groupBy(schema.insightsDaily.date)
    .orderBy(schema.insightsDaily.date);
  const campaigns = await fetchCampaigns();
  return {
    kpis: deriveKpis(totals),
    topAccounts: [...accounts].sort((a, b) => b.spend - a.spend).slice(0, 6),
    topCampaigns: [...campaigns].sort((a, b) => b.roas - a.roas).slice(0, 5),
    trend: trendRows.map((r) => ({ date: r.date, spend: num(r.spend), conversions: num(r.conversions), revenue: num(r.revenue) })),
  };
}

export async function fetchCampaigns(): Promise<Campaign[]> {
  const since = windowStart(WINDOW_DAYS);
  const [campaignRows, adsetRows, adRows, accountRows, campTotals, adTotals] = await Promise.all([
    db.select().from(schema.campaigns),
    db.select().from(schema.adSets),
    db.select().from(schema.ads),
    db.select().from(schema.accounts),
    totalsByEntity("campaign", since),
    totalsByEntity("ad", since),
  ]);
  const accName = new Map(accountRows.map((a) => [a.id, a.name]));
  const campT = new Map(campTotals.map((t) => [t.entityId, t]));
  const adT = new Map(adTotals.map((t) => [t.entityId, t]));

  const adsByAdset = new Map<string, typeof adRows>();
  for (const ad of adRows) {
    const arr = adsByAdset.get(ad.adSetId) ?? [];
    arr.push(ad); adsByAdset.set(ad.adSetId, arr);
  }
  const adsetsByCampaign = new Map<string, typeof adsetRows>();
  for (const s of adsetRows) {
    const arr = adsetsByCampaign.get(s.campaignId) ?? [];
    arr.push(s); adsetsByCampaign.set(s.campaignId, arr);
  }

  return campaignRows.map((c) => {
    const t = campT.get(c.id);
    const k = deriveKpis({
      spend: num(t?.spend), impressions: num(t?.impressions), clicks: num(t?.clicks),
      conversions: num(t?.conversions), revenue: num(t?.revenue), reach: num(t?.reach),
    });
    const adSets = (adsetsByCampaign.get(c.id) ?? []).map((s) => {
      const ads = (adsByAdset.get(s.id) ?? []).map((ad) => {
        const at = adT.get(ad.id);
        const ak = deriveKpis({
          spend: num(at?.spend), impressions: num(at?.impressions), clicks: num(at?.clicks),
          conversions: num(at?.conversions), revenue: num(at?.revenue), reach: num(at?.reach),
        });
        return {
          id: ad.id, name: ad.name, status: (ad.status ?? "ACTIVE") as Campaign["status"],
          spend: ak.spend, impressions: ak.impressions, ctr: ak.ctr, cpc: ak.cpc, roas: ak.roas,
          conversions: ak.conversions, format: "Image" as const, thumbHue: 210, thumbnailUrl: null,
        };
      });
      return {
        id: s.id, name: s.name, status: (s.status ?? "ACTIVE") as Campaign["status"],
        spend: ads.reduce((x, a) => x + a.spend, 0),
        ctr: ads.length ? ads.reduce((x, a) => x + a.ctr, 0) / ads.length : 0,
        roas: ads.length ? ads.reduce((x, a) => x + a.roas, 0) / ads.length : 0,
        audience: s.name, ads,
      };
    });
    return {
      id: c.id, name: c.name, status: (c.status ?? "ACTIVE") as Campaign["status"],
      objective: (c.objective ?? "CONVERSIONS") as Campaign["objective"],
      accountId: c.accountId, accountName: accName.get(c.accountId) ?? c.accountId,
      spend: k.spend, impressions: k.impressions, conversions: k.conversions,
      ctr: k.ctr, cpc: k.cpc, cpm: k.cpm, roas: k.roas, adSets,
    };
  });
}

export async function fetchAccount(id: string): Promise<{ account: AdAccount; campaigns: Campaign[]; trend: TrendPoint[] } | null> {
  const accounts = await fetchAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return null;
  const since = windowStart(WINDOW_DAYS);
  const allCampaigns = await fetchCampaigns();
  const trendRows = await db
    .select({
      date: schema.insightsDaily.date,
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
      conversions: sql<number>`coalesce(sum(${schema.insightsDaily.conversions}),0)`,
      revenue: sql<number>`coalesce(sum(${schema.insightsDaily.conversionValues}),0)`,
    })
    .from(schema.insightsDaily)
    .where(and(eq(schema.insightsDaily.level, "account"), eq(schema.insightsDaily.entityId, id), gte(schema.insightsDaily.date, since)))
    .groupBy(schema.insightsDaily.date)
    .orderBy(schema.insightsDaily.date);
  return {
    account,
    campaigns: allCampaigns.filter((c) => c.accountId === id),
    trend: trendRows.map((r) => ({ date: r.date, spend: num(r.spend), conversions: num(r.conversions), revenue: num(r.revenue) })),
  };
}

export async function fetchCreatives(): Promise<CreativeCard[]> {
  const campaigns = await fetchCampaigns();
  const out: CreativeCard[] = [];
  for (const c of campaigns) {
    for (const s of c.adSets) {
      for (const ad of s.ads) out.push({ ...ad, campaign: c.name, account: c.accountName });
    }
  }
  return out.sort((a, b) => b.spend - a.spend).slice(0, 36);
}

export async function fetchBreakdowns(): Promise<Record<"age" | "gender" | "publisher_platform" | "device_platform" | "country", BreakdownRow[]>> {
  const since = windowStart(WINDOW_DAYS);
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
    .groupBy(schema.insightsBreakdownDaily.breakdownType, schema.insightsBreakdownDaily.breakdownValue);
  const empty = { age: [], gender: [], publisher_platform: [], device_platform: [], country: [] } as Record<string, BreakdownRow[]>;
  for (const r of rows) {
    (empty[r.breakdownType] ??= []).push({
      label: r.breakdownValue, spend: num(r.spend), conversions: num(r.conversions),
      roas: num(r.revenue) / Math.max(1, num(r.spend)),
    });
  }
  for (const k of Object.keys(empty)) empty[k].sort((a, b) => b.spend - a.spend);
  return empty as Record<"age" | "gender" | "publisher_platform" | "device_platform" | "country", BreakdownRow[]>;
}

export async function fetchBusinessSummary(): Promise<{ businessId: string; accountCount: number }> {
  const [cred] = await db
    .select({ businessId: schema.metaCredentials.businessId })
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.id, "singleton"));
  const [counted] = await db.select({ count: sql<number>`count(*)` }).from(schema.accounts);
  return { businessId: cred?.businessId ?? "", accountCount: num(counted?.count) };
}
