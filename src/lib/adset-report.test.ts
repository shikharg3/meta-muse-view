import { expect, test } from "bun:test";
import { isAdsetReportDue, reportedDay, type ScheduleState } from "./adset-report";
import { MAX_ATTEMPTS } from "./daily-report";

const DAY = "2026-10-27";
const at = (hour: number, minute = 0) => ({ date: "2026-10-28", hour, minute });
const schedule = (over: Partial<ScheduleState> = {}): ScheduleState => ({
  active: true,
  hour: 10,
  minute: 30,
  runDate: "2026-10-26",
  sentAt: new Date(),
  attempts: 1,
  ...over,
});

test("a new day is due from the schedule's minute on, and late rather than never", () => {
  expect(isAdsetReportDue(schedule(), at(10, 29), DAY)).toBe(false);
  expect(isAdsetReportDue(schedule(), at(10, 30), DAY)).toBe(true);
  // A worker that was down at 10:30 still sends when it comes back.
  expect(isAdsetReportDue(schedule(), at(18, 5), DAY)).toBe(true);
  expect(
    isAdsetReportDue(schedule({ runDate: null, sentAt: null, attempts: 0 }), at(11), DAY),
  ).toBe(true);
});

test("a sent day is never sent again, and a failed one retries only up to MAX_ATTEMPTS", () => {
  expect(isAdsetReportDue(schedule({ runDate: DAY }), at(12), DAY)).toBe(false);
  expect(isAdsetReportDue(schedule({ runDate: DAY, sentAt: null, attempts: 1 }), at(12), DAY)).toBe(
    true,
  );
  expect(
    isAdsetReportDue(schedule({ runDate: DAY, sentAt: null, attempts: MAX_ATTEMPTS }), at(12), DAY),
  ).toBe(false);
});

test("a paused schedule is never due", () => {
  expect(isAdsetReportDue(schedule({ active: false }), at(12), DAY)).toBe(false);
});

test("the reported day is the Berlin day before, across a month boundary", () => {
  expect(reportedDay({ date: "2026-11-01", hour: 10, minute: 0 })).toBe("2026-10-31");
});
