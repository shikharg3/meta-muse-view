import { test, expect } from "bun:test";
import {
  CHECKIN_QUESTIONS,
  questionFor,
  isCheckinStatus,
  CHECKIN_HOUR,
  ESCALATION_HOUR,
} from "./checkin";
import { MACHINE_STATUSES } from "./delivery-status";

test("every machine-owned status has a question", () => {
  // `satisfies` already enforces this at compile time; asserted at runtime too so loosening the
  // type does not silently produce campaigns nobody is ever asked about.
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
  // Statuses arrive as untrusted strings from Notion; a bare index read would hand back inherited
  // functions and break the declared string | null contract.
  expect(questionFor("toString")).toBeNull();
  expect(questionFor("constructor")).toBeNull();
  expect(questionFor("hasOwnProperty")).toBeNull();
});

test("isCheckinStatus recognises exactly the six in-scope statuses", () => {
  expect(Object.keys(CHECKIN_QUESTIONS).every(isCheckinStatus)).toBe(true);
  expect(Object.keys(CHECKIN_QUESTIONS)).toHaveLength(6);
  expect(isCheckinStatus("Live")).toBe(true);
  expect(isCheckinStatus("Not started")).toBe(false);
  expect(isCheckinStatus(null)).toBe(false);
});

test("the status set is exactly the six agreed values", () => {
  expect(Object.keys(CHECKIN_QUESTIONS).sort()).toEqual(
    [
      "Ad Account Blocked",
      "Ad Account Disabled",
      "All ads rejected",
      "Live",
      "On Boarding",
      "Paused",
    ].sort(),
  );
});

test("the gate hours are the agreed ones", () => {
  expect(CHECKIN_HOUR).toBe(17);
  expect(ESCALATION_HOUR).toBe(9);
});
