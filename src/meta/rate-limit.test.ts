import { test, expect } from "bun:test";
import { parseUsage, shouldBackoff, pacingFor, normalizeTier } from "./rate-limit";

test("parses business-use-case usage (worst across buckets) and the insights throttle header", () => {
  const headers = new Headers({
    "x-business-use-case-usage": JSON.stringify({
      act_1: [
        { type: "ads_management", call_count: 40, total_cputime: 10, total_time: 5 },
        {
          type: "ads_insights",
          call_count: 20,
          total_cputime: 80,
          total_time: 20,
          estimated_time_to_regain_access: 7,
          ads_api_access_tier: "standard_access",
        },
      ],
    }),
    "x-fb-ads-insights-throttle": JSON.stringify({ app_id_util_pct: 12, acc_id_util_pct: 95 }),
  });
  const usage = parseUsage(headers, "act_1");
  expect(usage.callCount).toBe(40); // worst bucket wins
  expect(usage.totalCputime).toBe(80);
  expect(usage.estimatedTimeToRegainAccess).toBe(7);
  expect(usage.accIdUtilPct).toBe(95);
  expect(usage.tier).toBe("standard_access");
});

test("recommends backoff when any utilization (incl. call_count) crosses the threshold", () => {
  const base = {
    callCount: 0,
    totalCputime: 0,
    totalTime: 0,
    appIdUtilPct: 0,
    accIdUtilPct: 0,
    estimatedTimeToRegainAccess: 0,
    tier: null,
  };
  expect(shouldBackoff({ ...base, totalCputime: 90 })).toBe(true);
  expect(shouldBackoff({ ...base, callCount: 88 })).toBe(true); // call_count alone triggers
  expect(shouldBackoff({ ...base, accIdUtilPct: 99 })).toBe(true);
  expect(shouldBackoff(base)).toBe(false);
});

test("normalizeTier maps Meta's raw header values", () => {
  expect(normalizeTier("standard_access")).toBe("standard");
  expect(normalizeTier("development_access")).toBe("development");
  expect(normalizeTier(null)).toBeNull();
  expect(normalizeTier("something_else")).toBeNull();
});

test("pacingFor: standard fans out wider than dev; unknown stays conservative", () => {
  const std = pacingFor("standard");
  const dev = pacingFor("development");
  const unknown = pacingFor(null);
  expect(std.refresh.concurrency).toBeGreaterThan(dev.refresh.concurrency);
  expect(std.backfill.concurrency).toBeGreaterThan(dev.backfill.concurrency);
  // null (unknown, e.g. a fresh app after a ban) must match dev — never assume standard.
  expect(unknown).toEqual(dev);
});
