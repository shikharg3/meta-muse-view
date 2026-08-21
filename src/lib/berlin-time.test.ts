import { test, expect } from "bun:test";
import { atOrAfter, berlinNow } from "./berlin-time";

/**
 * Run `fn` as if the process were in `tz`, then restore.
 *
 * Restores a CONCRETE zone name. `process.env.TZ` is unset by default under `bun test`, and
 * assigning `undefined` to a `process.env` key stores the literal string `"undefined"` instead of
 * deleting it, which leaves ICU pinned to the hostile zone for the rest of the process — measured
 * leaking across test files. `delete process.env.TZ` clears the key but also leaves ICU hostile.
 *
 * Only objects constructed AFTER the flip observe it, so the function under test must build its own
 * `Date`/`Intl` internally for a probe like this to mean anything.
 */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

test("converts UTC to Berlin wall clock in summer", () => {
  // 2026-08-13 11:30Z is 13:30 CEST — the first notification's mark.
  expect(berlinNow(new Date("2026-08-13T11:30:00Z"))).toEqual({
    date: "2026-08-13",
    hour: 13,
    minute: 30,
  });
});

test("converts UTC to Berlin wall clock in winter", () => {
  // 2026-01-13 12:30Z is also 13:30, an hour of offset difference from the summer case, so a
  // hard-coded +2 cannot satisfy both tests.
  expect(berlinNow(new Date("2026-01-13T12:30:00Z"))).toEqual({
    date: "2026-01-13",
    hour: 13,
    minute: 30,
  });
});

test("reports Berlin midnight as hour 0 of the NEXT date", () => {
  // 22:00Z in summer is 00:00 Berlin the following day. An h24 hour cycle would say "24" here and
  // leave every gate true all night.
  expect(berlinNow(new Date("2026-08-12T22:00:00Z"))).toEqual({
    date: "2026-08-13",
    hour: 0,
    minute: 0,
  });
});

test("berlinNow ignores the process timezone", () => {
  // Bites only because berlinNow builds its formatter per call: an import-time formatter cannot
  // observe this flip, and a dropped `timeZone: "Europe/Berlin"` would survive the mutation.
  const hostile = withTZ("Pacific/Kiritimati", () => berlinNow(new Date("2026-08-13T11:30:00Z")));
  expect(hostile).toEqual({ date: "2026-08-13", hour: 13, minute: 30 });
});

test("atOrAfter is shut one minute before a half-past mark and open on it", () => {
  // The regression this exists to catch: an hour-only comparison would open the 13:30 gate at 13:00.
  const mark = { hour: 13, minute: 30 };
  expect(atOrAfter({ date: "2026-08-13", hour: 13, minute: 29 }, mark)).toBe(false);
  expect(atOrAfter({ date: "2026-08-13", hour: 13, minute: 30 }, mark)).toBe(true);
  expect(atOrAfter({ date: "2026-08-13", hour: 13, minute: 31 }, mark)).toBe(true);
  // A whole hour earlier must also be shut, or "13:00 counts as 13:30" slips through.
  expect(atOrAfter({ date: "2026-08-13", hour: 13, minute: 0 }, mark)).toBe(false);
});

test("atOrAfter stays shut before an on-the-hour mark and open all day after", () => {
  const mark = { hour: 8, minute: 0 };
  expect(atOrAfter({ date: "2026-08-13", hour: 7, minute: 59 }, mark)).toBe(false);
  expect(atOrAfter({ date: "2026-08-13", hour: 8, minute: 0 }, mark)).toBe(true);
  expect(atOrAfter({ date: "2026-08-13", hour: 23, minute: 59 }, mark)).toBe(true);
  // Midnight is BEFORE an 08:00 mark, not after it — the h23 cycle is what makes this hold.
  expect(atOrAfter({ date: "2026-08-13", hour: 0, minute: 0 }, mark)).toBe(false);
});

test("berlinNow reads the real minute, not a zero placeholder", () => {
  // A dropped `minute: "2-digit"` option would make every half-past mark unreachable, and a
  // hard-coded 0 would make it reachable an hour early. Both survive an equality-free assertion.
  expect(berlinNow(new Date("2026-08-13T15:47:00Z")).minute).toBe(47);
  expect(berlinNow(new Date("2026-08-13T15:00:00Z")).minute).toBe(0);
});
