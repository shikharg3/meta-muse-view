export interface Usage {
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
  const list = buc?.[accountId];
  const entry = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
  return {
    totalCputime: num(entry?.total_cputime),
    totalTime: num(entry?.total_time),
    estimatedTimeToRegainAccess: num(entry?.estimated_time_to_regain_access),
    appIdUtilPct: num(throttle?.app_id_util_pct),
    accIdUtilPct: num(throttle?.acc_id_util_pct),
  };
}

export function shouldBackoff(u: Usage): boolean {
  return (
    u.totalCputime >= THRESHOLD ||
    u.totalTime >= THRESHOLD ||
    u.appIdUtilPct >= THRESHOLD ||
    u.accIdUtilPct >= THRESHOLD
  );
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
