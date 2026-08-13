import { test, expect } from "bun:test";
import { berlinNow } from "./berlin-time";

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
  // Bites only because berlinNow builds its formatter per call: an import-time formatter cannot
  // observe this flip, and a dropped `timeZone: "Europe/Berlin"` would survive the mutation.
  const hostile = withTZ("Pacific/Kiritimati", () => berlinNow(new Date("2026-08-13T15:30:00Z")));
  expect(hostile).toEqual({ date: "2026-08-13", hour: 17 });
});
