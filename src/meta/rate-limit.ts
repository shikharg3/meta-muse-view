export interface Usage {
  callCount: number;
  totalCputime: number;
  totalTime: number;
  appIdUtilPct: number;
  accIdUtilPct: number;
  estimatedTimeToRegainAccess: number; // minutes
  tier: string | null; // ads_api_access_tier: "standard_access" | "development_access" | null
}

const THRESHOLD = 85;

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export function parseUsage(headers: Headers, accountId: string): Usage {
  const buc = safeJson(headers.get("x-business-use-case-usage"));
  const throttle = safeJson(headers.get("x-fb-ads-insights-throttle"));
  // An account can carry several BUC buckets (ads_management + ads_insights, …); take the worst
  // dimension across all of them so we back off on whichever bucket is closest to its limit.
  const list = buc?.[accountId];
  const entries = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  let callCount = 0;
  let totalCputime = 0;
  let totalTime = 0;
  let regain = 0;
  let tier: string | null = null;
  for (const e of entries) {
    callCount = Math.max(callCount, num(e?.call_count));
    totalCputime = Math.max(totalCputime, num(e?.total_cputime));
    totalTime = Math.max(totalTime, num(e?.total_time));
    regain = Math.max(regain, num(e?.estimated_time_to_regain_access));
    if (!tier && typeof e?.ads_api_access_tier === "string") tier = e.ads_api_access_tier;
  }
  return {
    callCount,
    totalCputime,
    totalTime,
    estimatedTimeToRegainAccess: regain,
    tier,
    appIdUtilPct: num(throttle?.app_id_util_pct),
    accIdUtilPct: num(throttle?.acc_id_util_pct),
  };
}

/** Worst utilization dimension (0-100), used to decide and report proactive backoff. */
export function peakPressure(u: Usage): number {
  return Math.max(u.callCount, u.totalCputime, u.totalTime, u.appIdUtilPct, u.accIdUtilPct);
}

export function shouldBackoff(u: Usage): boolean {
  return peakPressure(u) >= THRESHOLD;
}

function safeJson(s: string | null): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try {
    const parsed: unknown = JSON.parse(s);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Marketing API access tier (the rate-limit tier). `null` = not yet observed this app. */
export type AccessTier = "standard" | "development";

/** Map Meta's raw `ads_api_access_tier` header value to our tier, or null when absent/unknown. */
export function normalizeTier(raw: string | null | undefined): AccessTier | null {
  if (raw === "standard_access") return "standard";
  if (raw === "development_access") return "development";
  return null;
}

export interface Pacing {
  refresh: { concurrency: number; intervalMs: number };
  backfill: { concurrency: number; intervalMs: number };
}

/**
 * Concurrency + pacing for the sync, sized to the app's access tier. Standard tier has ~300x the
 * per-account insights budget (190k vs 600) plus a 9,000 app-level score, so it fans out widely;
 * development tier — and `null` (unknown, e.g. right after swapping to a fresh app) — stays throttled
 * to the 600-point ceiling. The tier is read from live headers and persisted, so a downgrade (app
 * banned → new dev-tier app) automatically pulls pacing back down with no code change.
 */
export function pacingFor(tier: AccessTier | null): Pacing {
  if (tier === "standard")
    return {
      refresh: { concurrency: 6, intervalMs: 60 },
      backfill: { concurrency: 8, intervalMs: 80 },
    };
  return {
    refresh: { concurrency: 1, intervalMs: 250 },
    backfill: { concurrency: 3, intervalMs: 150 },
  };
}
