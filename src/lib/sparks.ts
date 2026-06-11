import type { TrendPoint } from "./types";

const div = (a: number, b: number): number => (b > 0 ? a / b : 0);

/** Per-KPI daily series derived from an account-level trend, for KPI card sparklines. */
export function kpiSparks(
  trend: TrendPoint[],
): Record<
  "spend" | "revenue" | "roas" | "ctr" | "conversions" | "impressions" | "cpc" | "cpm" | "reach",
  number[]
> {
  return {
    spend: trend.map((t) => t.spend),
    revenue: trend.map((t) => t.revenue),
    roas: trend.map((t) => div(t.revenue, t.spend)),
    ctr: trend.map((t) => div(t.clicks, t.impressions) * 100),
    conversions: trend.map((t) => t.conversions),
    impressions: trend.map((t) => t.impressions),
    cpc: trend.map((t) => div(t.spend, t.clicks)),
    cpm: trend.map((t) => div(t.spend, t.impressions) * 1000),
    reach: trend.map((t) => t.reach),
  };
}
