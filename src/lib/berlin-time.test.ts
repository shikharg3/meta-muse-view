import { test, expect } from "bun:test";
import { berlinNow, dayLabel } from "./berlin-time";

/** Run `fn` as if the process were in `tz`, then restore. Bun applies a mid-run TZ change at once. */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

test("converts UTC to Berlin wall clock in summer", () => {
  // 2026-08-13 15:30Z is 17:30 CEST.
  expect(berlinNow(new Date("2026-08-13T15:30:00Z"))).toEqual({ date: "2026-08-13", hour: 17 });
});

test("converts UTC to Berlin wall clock in winter", () => {
  // 2026-01-13 16:30Z is 17:30 CET — an hour of offset difference from the summer case, so a
  // hard-coded +2 cannot satisfy both tests.
  expect(berlinNow(new Date("2026-01-13T16:30:00Z"))).toEqual({ date: "2026-01-13", hour: 17 });
});

test("reports Berlin midnight as hour 0 of the NEXT date", () => {
  // 22:00Z in summer is 00:00 Berlin the following day. An h24 hour cycle would say "24" here and
  // leave every `hour >= CHECKIN_HOUR` gate true all night.
  expect(berlinNow(new Date("2026-08-12T22:00:00Z"))).toEqual({ date: "2026-08-13", hour: 0 });
});

test("does not reach the prompt hour one minute early", () => {
  // 14:59Z summer is 16:59 Berlin: the 17:00 gate must still be shut.
  expect(berlinNow(new Date("2026-08-13T14:59:00Z")).hour).toBe(16);
});

test("berlinNow ignores the process timezone", () => {
  // Fails if the formatter's `timeZone: "Europe/Berlin"` is ever dropped — the sync worker's host
  // timezone must not decide when the prompt fires.
  const hostile = withTZ("Pacific/Kiritimati", () => berlinNow(new Date("2026-08-13T15:30:00Z")));
  expect(hostile).toEqual({ date: "2026-08-13", hour: 17 });
});

test("dayLabel formats a date as 'Thu 13 Aug'", () => {
  expect(dayLabel("2026-08-13")).toBe("Thu 13 Aug");
  expect(dayLabel("2026-08-03")).toBe("Mon 03 Aug");
  expect(dayLabel("2026-01-01")).toBe("Thu 01 Jan");
});

test("dayLabel ignores the process timezone", () => {
  // A UTC+14 runner must not shift the label onto the next day.
  expect(withTZ("Pacific/Kiritimati", () => dayLabel("2026-08-13"))).toBe("Thu 13 Aug");
  expect(withTZ("Pacific/Midway", () => dayLabel("2026-08-13"))).toBe("Thu 13 Aug");
});
