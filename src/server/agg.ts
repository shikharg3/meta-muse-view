import type { Kpis } from "@/lib/types";

export interface Totals {
  spend: number; impressions: number; clicks: number;
  conversions: number; revenue: number; reach: number;
}

const div = (a: number, b: number): number => (b > 0 ? a / b : 0);
export const deriveRoas = (revenue: number, spend: number): number => div(revenue, spend);

export function deriveKpis(t: Totals): Kpis {
  return {
    ...t,
    ctr: div(t.clicks, t.impressions) * 100,
    cpc: div(t.spend, t.clicks),
    cpm: div(t.spend, t.impressions) * 1000,
    roas: div(t.revenue, t.spend),
    frequency: div(t.impressions, t.reach),
  };
}

/** Window start as YYYY-MM-DD, `days` before `today` (inclusive). */
export function windowStart(days: number, today = new Date()): string {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}
