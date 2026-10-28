import { expect, test } from "bun:test";
import { MAX_ATTEMPTS } from "./daily-report";
import { isScheduleDue, type ScheduleState } from "./scheduled-report";

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
