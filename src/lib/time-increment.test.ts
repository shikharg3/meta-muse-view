import { test, expect } from "bun:test";
import {
  DEFAULT_TIME_INCREMENT,
  bucketFor,
  bucketLabel,
  isTimeIncrement,
  resolveTimeIncrement,
} from "./time-increment";

// Every boundary below was read off the Graph API, not derived from the docs. The account was
// act_2071939290396302 and the calls are recorded in the module docblock.

test("a day count anchors at `since`, not at the calendar week", () => {
  // since=2026-08-02 → 08-02..08-08, 08-09..08-15, 08-16..08-22, 08-23..08-26(clipped)
  const w = (date: string) => bucketLabel(bucketFor(date, "2026-08-02", "2026-08-26", "7"));
  expect(w("2026-08-02")).toBe("2026-08-02 → 2026-08-08");
  expect(w("2026-08-08")).toBe("2026-08-02 → 2026-08-08");
  expect(w("2026-08-09")).toBe("2026-08-09 → 2026-08-15");
  expect(w("2026-08-22")).toBe("2026-08-16 → 2026-08-22");

  // Shift the anchor by three days and every boundary moves with it. This is the whole reason a
  // weekly de-duplicated figure cannot be precomputed: the buckets depend on the query.
  const v = (date: string) => bucketLabel(bucketFor(date, "2026-08-05", "2026-08-26", "7"));
  expect(v("2026-08-05")).toBe("2026-08-05 → 2026-08-11");
  expect(v("2026-08-12")).toBe("2026-08-12 → 2026-08-18");
});

test("the last bucket is clipped by `until`, never overrun", () => {
  expect(bucketFor("2026-08-24", "2026-08-02", "2026-08-26", "7")).toEqual({
    start: "2026-08-23",
    end: "2026-08-26",
  });
  // A one-day tail is a bucket of its own, and reads as a bare date rather than a range.
  expect(bucketLabel(bucketFor("2026-08-30", "2026-08-02", "2026-08-30", "7"))).toBe("2026-08-30");
});

test("`monthly` is calendar months clipped at both ends of the range", () => {
  expect(bucketFor("2026-08-15", "2026-08-10", "2026-08-26", "monthly")).toEqual({
    start: "2026-08-10", // not 08-01: the range starts later
    end: "2026-08-26", // not 08-31: the range ends earlier
  });
  // A range spanning a boundary yields one bucket per month, each clipped to the range.
  expect(bucketFor("2026-07-20", "2026-07-15", "2026-09-05", "monthly")).toEqual({
    start: "2026-07-15",
    end: "2026-07-31",
  });
  expect(bucketFor("2026-08-20", "2026-07-15", "2026-09-05", "monthly")).toEqual({
    start: "2026-08-01",
    end: "2026-08-31", // a full month in the middle is not clipped
  });
  expect(bucketFor("2026-09-02", "2026-07-15", "2026-09-05", "monthly")).toEqual({
    start: "2026-09-01",
    end: "2026-09-05",
  });
  // February, so the month length is read from the calendar rather than a table.
  expect(bucketFor("2028-02-10", "2028-01-01", "2028-12-31", "monthly")).toEqual({
    start: "2028-02-01",
    end: "2028-02-29",
  });
});

test("`1` gives one bucket per day and `all_days` exactly one for the range", () => {
  expect(bucketFor("2026-08-14", "2026-08-01", "2026-08-31", "1")).toEqual({
    start: "2026-08-14",
    end: "2026-08-14",
  });
  expect(bucketLabel(bucketFor("2026-08-14", "2026-08-01", "2026-08-31", "1"))).toBe("2026-08-14");
  expect(bucketFor("2026-08-14", "2026-08-01", "2026-08-31", "all_days")).toEqual({
    start: "2026-08-01",
    end: "2026-08-31",
  });
});

test("bucketing is UTC, so a month boundary never moves with the server's timezone", () => {
  // 00:00 and 23:59 local on the 1st must land in the same bucket wherever the process runs; the
  // arithmetic never constructs a local-time Date, so the boundary is fixed by the date string.
  expect(bucketFor("2026-03-01", "2026-01-01", "2026-12-31", "monthly").start).toBe("2026-03-01");
  expect(bucketFor("2026-02-28", "2026-01-01", "2026-12-31", "monthly").end).toBe("2026-02-28");
});

test("only Meta's own values are accepted as a granularity", () => {
  expect(isTimeIncrement("all_days")).toBe(true);
  expect(isTimeIncrement("7")).toBe(true);
  expect(isTimeIncrement("monthly")).toBe(true);
  // Meta accepts any 1..90 day count; we offer the four in the picker and reject the rest rather
  // than let a stored template resolve to a granularity no control can display.
  expect(isTimeIncrement("3")).toBe(false);
  expect(isTimeIncrement("weekly")).toBe(false);
  expect(isTimeIncrement(7)).toBe(false);
});

test("legacy and free-text inputs resolve without inventing a granularity", () => {
  // The boolean this replaced, as still stored in old templates and frozen run params.
  expect(resolveTimeIncrement(undefined, true)).toBe("1");
  expect(resolveTimeIncrement(undefined, false)).toBe("all_days");
  expect(resolveTimeIncrement(true)).toBe("1");
  expect(resolveTimeIncrement(false)).toBe("all_days");
  // Chat phrasings.
  expect(resolveTimeIncrement("daily")).toBe("1");
  expect(resolveTimeIncrement("weekly")).toBe("7");
  expect(resolveTimeIncrement("month")).toBe("monthly");
  expect(resolveTimeIncrement(7)).toBe("7");
  // Meta's own default when there is nothing to go on — never a guessed axis.
  expect(resolveTimeIncrement(undefined)).toBe(DEFAULT_TIME_INCREMENT);
  expect(resolveTimeIncrement("nonsense")).toBe(DEFAULT_TIME_INCREMENT);
  expect(DEFAULT_TIME_INCREMENT).toBe("all_days");
});
