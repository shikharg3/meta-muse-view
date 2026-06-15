import { test, expect } from "bun:test";
import { fmtCurrency, fmtNumber, fmtCompact, fmtPct, fmtRelTime } from "./format";

test("formatters match the previous mock-data behavior", () => {
  expect(fmtCurrency(1500)).toBe("$1,500");
  expect(fmtCurrency(513.82)).toBe("$514"); // 0 DP — no cents, so widths stay consistent
  expect(fmtCurrency(1007.4)).toBe("$1,007");
  expect(fmtNumber(12345)).toBe("12,345");
  expect(fmtCompact(1500000)).toBe("1.5M");
  expect(fmtPct(3.14159)).toBe("3.14%");
});

test("fmtRelTime buckets ages and never goes negative", () => {
  const now = new Date("2026-06-09T12:00:00Z");
  expect(fmtRelTime("2026-06-09T11:59:40Z", now)).toBe("just now");
  expect(fmtRelTime("2026-06-09T11:48:00Z", now)).toBe("12m ago");
  expect(fmtRelTime("2026-06-09T09:00:00Z", now)).toBe("3h ago");
  expect(fmtRelTime("2026-06-07T12:00:00Z", now)).toBe("2d ago");
  expect(fmtRelTime("2026-06-09T12:05:00Z", now)).toBe("just now"); // clock skew
});
