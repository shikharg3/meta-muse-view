import { test, expect } from "bun:test";
import {
  windowFromDays,
  windowFromDates,
  resolveWindow,
  rangeLabel,
  isYmd,
  addDays,
} from "./range";

const TODAY = new Date("2026-06-16T12:00:00Z");

test("windowFromDays builds an inclusive trailing window + equal-length previous window", () => {
  const w = windowFromDays(30, TODAY);
  expect(w).toEqual({
    since: "2026-05-18", // today - 29
    until: "2026-06-16",
    prevSince: "2026-04-18", // today - 59
    days: 30,
  });
});

test("windowFromDays clamps non-positive day counts to the default", () => {
  expect(windowFromDays(0, TODAY).days).toBe(30);
  expect(windowFromDays(-5, TODAY).days).toBe(30);
});

test("windowFromDates is inclusive and sets the previous window immediately before", () => {
  const w = windowFromDates("2026-01-01", "2026-01-10");
  expect(w).toEqual({
    since: "2026-01-01",
    until: "2026-01-10",
    prevSince: "2025-12-22", // since - 10 days (inclusive length)
    days: 10,
  });
});

test("windowFromDates normalizes a reversed range", () => {
  const w = windowFromDates("2026-01-10", "2026-01-01");
  expect(w.since).toBe("2026-01-01");
  expect(w.until).toBe("2026-01-10");
});

test("resolveWindow uses custom dates when both are valid, else the preset", () => {
  const custom = resolveWindow({ days: 30, from: "2026-02-01", to: "2026-02-28" }, TODAY);
  expect(custom.since).toBe("2026-02-01");
  expect(custom.until).toBe("2026-02-28");

  // invalid date → fall back to the preset window
  const fallback = resolveWindow({ days: 7, from: "2026-13-99", to: "2026-02-28" }, TODAY);
  expect(fallback.days).toBe(7);
  expect(fallback.until).toBe("2026-06-16");
});

test("isYmd rejects malformed and impossible dates", () => {
  expect(isYmd("2026-06-16")).toBe(true);
  expect(isYmd("2026-6-16")).toBe(false); // not zero-padded
  expect(isYmd("2026-02-30")).toBe(false); // not a real day
  expect(isYmd("nope")).toBe(false);
  expect(isYmd(30)).toBe(false);
});

test("addDays crosses month boundaries (UTC)", () => {
  expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
});

test("rangeLabel shows the custom span or the preset label", () => {
  expect(rangeLabel({ from: "2026-01-01", to: "2026-01-31" })).toBe("2026-01-01 → 2026-01-31");
  expect(rangeLabel({ range: 7 })).toBe("Last 7 days");
  expect(rangeLabel({})).toBe("Last 30 days"); // default
});
