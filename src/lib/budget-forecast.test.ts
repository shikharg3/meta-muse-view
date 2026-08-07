import { test, expect } from "bun:test";
import {
  forecastBudgetEnd,
  paceWindow,
  MAX_PROJECTION_DAYS,
  MIN_PACE_DAYS,
  PACE_DAYS,
} from "./budget-forecast";

const TODAY = "2026-07-31";

test("projects the burn-out date from the daily pace", () => {
  // $4000 left at $200/day = 20 days.
  expect(forecastBudgetEnd({ total: 10_000, spent: 6_000, dailyPace: 200, today: TODAY })).toEqual({
    projectedEndDate: "2026-08-20",
    dailyPace: 200,
    daysRemaining: 20,
    reason: null,
  });
});

test("rounds a partial day up so the date covers the whole remainder", () => {
  const f = forecastBudgetEnd({ total: 1_000, spent: 0, dailyPace: 300, today: TODAY });
  expect(f.daysRemaining).toBe(4); // 3.33 -> 4
  expect(f.projectedEndDate).toBe("2026-08-04");
});

test("an exhausted (or overspent) budget ends today", () => {
  for (const spent of [10_000, 12_500]) {
    expect(forecastBudgetEnd({ total: 10_000, spent, dailyPace: 200, today: TODAY })).toEqual({
      projectedEndDate: TODAY,
      dailyPace: 200,
      daysRemaining: 0,
      reason: "budget exhausted",
    });
  }
});

test("zero (or negative) pace cannot be projected", () => {
  for (const dailyPace of [0, -5]) {
    expect(forecastBudgetEnd({ total: 10_000, spent: 1_000, dailyPace, today: TODAY })).toEqual({
      projectedEndDate: null,
      dailyPace,
      daysRemaining: null,
      reason: "no recent spend",
    });
  }
});

test("an untracked budget yields no forecast", () => {
  expect(forecastBudgetEnd({ total: null, spent: 4_200, dailyPace: 200, today: TODAY })).toEqual({
    projectedEndDate: null,
    dailyPace: 200,
    daysRemaining: null,
    reason: "no budget set",
  });
});

test("a trickle pace is rejected instead of producing an absurd date", () => {
  // $50k left at 5c/day = a million days.
  const f = forecastBudgetEnd({ total: 50_000, spent: 0, dailyPace: 0.05, today: TODAY });
  expect(f.projectedEndDate).toBeNull();
  expect(f.reason).toBe("pace too low to project");
  expect(f.daysRemaining).toBe(1_000_000); // still reported, just not turned into a date
});

test("the projection cap is inclusive at ~2 years", () => {
  const at = forecastBudgetEnd({
    total: MAX_PROJECTION_DAYS,
    spent: 0,
    dailyPace: 1,
    today: TODAY,
  });
  expect(at.daysRemaining).toBe(MAX_PROJECTION_DAYS);
  expect(at.projectedEndDate).toBe("2028-07-30"); // 730 days on, through leap-day 2028-02-29
  expect(at.reason).toBeNull();

  const beyond = forecastBudgetEnd({
    total: MAX_PROJECTION_DAYS + 1,
    spent: 0,
    dailyPace: 1,
    today: TODAY,
  });
  expect(beyond.projectedEndDate).toBeNull();
  expect(beyond.reason).toBe("pace too low to project");
});

test("date arithmetic crosses month, year and leap-day boundaries", () => {
  // Month end (31-day month).
  expect(
    forecastBudgetEnd({ total: 300, spent: 0, dailyPace: 100, today: "2026-01-30" })
      .projectedEndDate,
  ).toBe("2026-02-02");
  // Year end.
  expect(
    forecastBudgetEnd({ total: 500, spent: 0, dailyPace: 100, today: "2026-12-28" })
      .projectedEndDate,
  ).toBe("2027-01-02");
  // Leap year: 2028-02 has 29 days.
  expect(
    forecastBudgetEnd({ total: 200, spent: 0, dailyPace: 100, today: "2028-02-28" })
      .projectedEndDate,
  ).toBe("2028-03-01");
  // Non-leap year: 2027-02 has 28 days.
  expect(
    forecastBudgetEnd({ total: 200, spent: 0, dailyPace: 100, today: "2027-02-27" })
      .projectedEndDate,
  ).toBe("2027-03-01");
});

test("pace is echoed unchanged so callers can display it", () => {
  expect(
    forecastBudgetEnd({ total: 1_000, spent: 100, dailyPace: 12.34, today: TODAY }).dailyPace,
  ).toBe(12.34);
});

test("paceWindow uses the full trailing window for an engagement that predates it", () => {
  const w = paceWindow({ startDate: "2026-01-01", until: "2026-07-31" });
  expect(w).toEqual({ from: "2026-07-18", days: PACE_DAYS }); // 18th..31st inclusive = 14 days
});

test("paceWindow clamps to the engagement start so a recycled account's history cannot leak in", () => {
  // The failure this prevents: an ad account moved onto a new engagement still carries the previous
  // client's spend, which would give a brand-new engagement a fully-formed burn rate.
  expect(paceWindow({ startDate: "2026-07-26", until: "2026-07-31" })).toEqual({
    from: "2026-07-26",
    days: 6,
  });
  // Exactly at the window edge it is the whole window, not a clamp.
  expect(paceWindow({ startDate: "2026-07-18", until: "2026-07-31" })?.days).toBe(PACE_DAYS);
});

test("paceWindow refuses to average an engagement younger than the minimum", () => {
  expect(paceWindow({ startDate: "2026-07-31", until: "2026-07-31" })).toBeNull(); // 1 day
  expect(paceWindow({ startDate: "2026-07-30", until: "2026-07-31" })).toBeNull(); // 2 days
  expect(paceWindow({ startDate: "2026-07-29", until: "2026-07-31" })?.days).toBe(MIN_PACE_DAYS);
});

test("paceWindow falls back to the trailing window when there is no start date", () => {
  expect(paceWindow({ startDate: null, until: "2026-07-31" })).toEqual({
    from: "2026-07-18",
    days: PACE_DAYS,
  });
});

test("paceWindow day counts are unaffected by month and year boundaries", () => {
  expect(paceWindow({ startDate: "2026-02-26", until: "2026-03-02" })?.days).toBe(5);
  expect(paceWindow({ startDate: "2026-12-30", until: "2027-01-02" })?.days).toBe(4);
  // 2028 is a leap year: Feb 27, 28, 29 then Mar 1.
  expect(paceWindow({ startDate: "2028-02-27", until: "2028-03-01" })?.days).toBe(4);
});
