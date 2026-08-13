import { test, expect } from "bun:test";
import {
  CHECKIN_QUESTIONS,
  CHECKIN_STATUSES,
  questionFor,
  berlinNow,
  previousDate,
  dayLabel,
  CHECKIN_HOUR,
  ESCALATION_HOUR,
} from "./checkin";
import { MACHINE_STATUSES } from "./delivery-status";

test("every machine-owned status has a question", () => {
  // If a sixth delivery state is ever added to the ladder, this fails instead of silently
  // producing campaigns that are never asked about.
  for (const s of MACHINE_STATUSES) expect(questionFor(s)).toBeTruthy();
});

test("On Boarding is asked even though it is human-owned", () => {
  expect(questionFor("On Boarding")).toBe("What's still outstanding before launch?");
});

test("statuses outside the check-in set are not asked", () => {
  expect(questionFor("Full Budget Finished")).toBeNull();
  expect(questionFor("Not started")).toBeNull();
  expect(questionFor(null)).toBeNull();
  expect(questionFor("")).toBeNull();
});

test("inherited Object members are not mistaken for statuses", () => {
  // Record<string, string> index access walks the prototype chain: without an own-property check
  // these return functions, breaking the declared string | null contract.
  expect(questionFor("toString")).toBeNull();
  expect(questionFor("constructor")).toBeNull();
  expect(questionFor("hasOwnProperty")).toBeNull();
});

test("the status set is exactly the six agreed values", () => {
  expect([...CHECKIN_STATUSES].sort()).toEqual(
    [
      "Ad Account Blocked",
      "Ad Account Disabled",
      "All ads rejected",
      "Live",
      "On Boarding",
      "Paused",
    ].sort(),
  );
  expect(Object.keys(CHECKIN_QUESTIONS)).toHaveLength(6);
});

test("berlinNow converts UTC to Berlin wall clock in summer", () => {
  // 2026-08-13 15:30Z is 17:30 CEST.
  expect(berlinNow(new Date("2026-08-13T15:30:00Z"))).toEqual({
    date: "2026-08-13",
    hour: 17,
    minute: 30,
  });
});

test("berlinNow converts UTC to Berlin wall clock in winter", () => {
  // 2026-01-13 16:30Z is 17:30 CET — one hour of offset difference from the summer case.
  expect(berlinNow(new Date("2026-01-13T16:30:00Z"))).toEqual({
    date: "2026-01-13",
    hour: 17,
    minute: 30,
  });
});

test("berlinNow reports local midnight as hour 0 of the NEXT date", () => {
  // 22:00Z in summer is 00:00 Berlin on the following day. Some ICU builds render midnight as
  // "24", which would make an hour>=17 gate true all night.
  expect(berlinNow(new Date("2026-08-12T22:00:00Z"))).toEqual({
    date: "2026-08-13",
    hour: 0,
    minute: 0,
  });
});

test("previousDate steps back across a month boundary", () => {
  expect(previousDate("2026-08-01")).toBe("2026-07-31");
  expect(previousDate("2026-03-01")).toBe("2026-02-28");
});

test("dayLabel is stable regardless of the runner's timezone", () => {
  expect(dayLabel("2026-08-13")).toBe("Thu 13 Aug");
});

test("the gate hours are the agreed ones", () => {
  expect(CHECKIN_HOUR).toBe(17);
  expect(ESCALATION_HOUR).toBe(9);
});
