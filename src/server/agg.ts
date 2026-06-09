import type { AccountStatus, Kpis } from "@/lib/types";

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

// Meta's numeric account_status codes -> our AccountStatus union.
const ACCOUNT_STATUS_CODES: Record<string, AccountStatus> = {
  "1": "ACTIVE",
  "2": "DISABLED",
  "3": "PENDING",
  "7": "PENDING",
  "8": "PENDING",
  "9": "PENDING",
  "100": "DISABLED",
  "101": "DISABLED",
};

/** Normalize a stored account status (Meta numeric code or already-mapped label). */
export function accountStatus(raw: string | null | undefined): AccountStatus {
  if (!raw) return "ACTIVE";
  const up = raw.toUpperCase();
  if (up === "ACTIVE" || up === "PAUSED" || up === "DISABLED" || up === "PENDING") {
    return up as AccountStatus;
  }
  return ACCOUNT_STATUS_CODES[raw] ?? "PENDING";
}
