import { test, expect } from "bun:test";
import { parseUsage, shouldBackoff } from "./rate-limit";

test("parses business-use-case usage and insights throttle headers", () => {
  const headers = new Headers({
    "x-business-use-case-usage": JSON.stringify({
      "act_1": [{ type: "ads_insights", total_cputime: 80, total_time: 20, estimated_time_to_regain_access: 0 }],
    }),
    "x-fb-ads-insights-throttle": JSON.stringify({ app_id_util_pct: 12, acc_id_util_pct: 95 }),
  });
  const usage = parseUsage(headers, "act_1");
  expect(usage.totalCputime).toBe(80);
  expect(usage.accIdUtilPct).toBe(95);
});

test("recommends backoff when any utilization crosses the threshold", () => {
  expect(shouldBackoff({ totalCputime: 90, totalTime: 10, appIdUtilPct: 0, accIdUtilPct: 0, estimatedTimeToRegainAccess: 0 })).toBe(true);
  expect(shouldBackoff({ totalCputime: 10, totalTime: 10, appIdUtilPct: 0, accIdUtilPct: 99, estimatedTimeToRegainAccess: 0 })).toBe(true);
  expect(shouldBackoff({ totalCputime: 10, totalTime: 10, appIdUtilPct: 0, accIdUtilPct: 0, estimatedTimeToRegainAccess: 0 })).toBe(false);
});
