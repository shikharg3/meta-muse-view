import { expect, test } from "bun:test";
import { MAX_ATTEMPTS } from "./daily-report";
import {
  defaultIdentityColumns,
  isScheduleDue,
  reportFilename,
  type ScheduleState,
} from "./scheduled-report";

// 2026-10-28 is a Wednesday; 2026-11-01 a Sunday.
const at = (date: string, hour: number, minute = 0) => ({ date, hour, minute });
const WED = "2026-10-28";
const schedule = (over: Partial<ScheduleState> = {}): ScheduleState => ({
  active: true,
  cadence: "daily",
  weekday: null,
  monthDay: null,
  hour: 10,
  minute: 30,
  runDate: "2026-10-27",
  sentAt: new Date(),
  attempts: 1,
  ...over,
});

test("a day is due from the schedule's minute on, and late rather than never", () => {
  expect(isScheduleDue(schedule(), at(WED, 10, 29))).toBe(false);
  expect(isScheduleDue(schedule(), at(WED, 10, 30))).toBe(true);
  // A worker that was down at 10:30 still sends when it comes back.
  expect(isScheduleDue(schedule(), at(WED, 18, 5))).toBe(true);
  expect(isScheduleDue(schedule({ runDate: null, sentAt: null, attempts: 0 }), at(WED, 11))).toBe(
    true,
  );
});

test("a sent day is never sent again; a failed one retries only up to MAX_ATTEMPTS", () => {
  expect(isScheduleDue(schedule({ runDate: WED }), at(WED, 12))).toBe(false);
  expect(isScheduleDue(schedule({ runDate: WED, sentAt: null, attempts: 1 }), at(WED, 12))).toBe(
    true,
  );
  expect(
    isScheduleDue(schedule({ runDate: WED, sentAt: null, attempts: MAX_ATTEMPTS }), at(WED, 12)),
  ).toBe(false);
});

test("cadences pick their days: weekdays skip weekends, weekly its weekday, monthly its date", () => {
  expect(isScheduleDue(schedule({ cadence: "weekdays" }), at("2026-11-01", 12))).toBe(false);
  expect(isScheduleDue(schedule({ cadence: "weekdays" }), at(WED, 12))).toBe(true);
  expect(isScheduleDue(schedule({ cadence: "weekly", weekday: 3 }), at(WED, 12))).toBe(true);
  expect(isScheduleDue(schedule({ cadence: "weekly", weekday: 1 }), at(WED, 12))).toBe(false);
  expect(isScheduleDue(schedule({ cadence: "weekly", weekday: 7 }), at("2026-11-01", 12))).toBe(
    true,
  );
  expect(isScheduleDue(schedule({ cadence: "monthly", monthDay: 1 }), at("2026-11-01", 12))).toBe(
    true,
  );
  expect(isScheduleDue(schedule({ cadence: "monthly", monthDay: 1 }), at(WED, 12))).toBe(false);
});

test("a paused schedule is never due", () => {
  expect(isScheduleDue(schedule({ active: false }), at(WED, 12))).toBe(false);
});

const ctx = { since: "2026-10-27", until: "2026-10-27", today: "2026-10-28", modeled: false };

test("a schedule's file name fills its date tokens and drops characters a file system rejects", () => {
  expect(reportFilename("OneAgency {since}..{until} / sent {today}.csv", "gen", ctx)).toBe(
    "OneAgency 2026-10-27..2026-10-27  sent 2026-10-28",
  );
  expect(reportFilename("  ", "oneagency_2026-10-27_by_adset", ctx)).toBe(
    "oneagency_2026-10-27_by_adset",
  );
  expect(reportFilename(null, "gen", ctx)).toBe("gen");
});

test("a modeled report's file name always says modeled, but never twice", () => {
  const modeled = { ...ctx, modeled: true };
  expect(reportFilename("OneAgency daily", "gen", modeled)).toBe("OneAgency daily_modeled");
  expect(reportFilename("OneAgency MODELED estimate", "gen", modeled)).toBe(
    "OneAgency MODELED estimate",
  );
  expect(reportFilename(null, "gen_modeled", modeled)).toBe("gen_modeled");
});

test("default report columns name the row without the Account columns", () => {
  expect(defaultIdentityColumns("adset", "1", true)).toEqual([
    "dim:period",
    "dim:brand",
    "dim:campaign",
    "dim:adset",
    "dim:adset_id",
  ]);
  expect(defaultIdentityColumns("country", "all_days", true)).toEqual(["dim:value"]);
});
