export interface Usage {
  callCount: number;
  totalCputime: number;
  totalTime: number;
  appIdUtilPct: number;
  accIdUtilPct: number;
  estimatedTimeToRegainAccess: number; // minutes
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
  for (const e of entries) {
    callCount = Math.max(callCount, num(e?.call_count));
    totalCputime = Math.max(totalCputime, num(e?.total_cputime));
    totalTime = Math.max(totalTime, num(e?.total_time));
    regain = Math.max(regain, num(e?.estimated_time_to_regain_access));
  }
  return {
    callCount,
    totalCputime,
    totalTime,
    estimatedTimeToRegainAccess: regain,
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
