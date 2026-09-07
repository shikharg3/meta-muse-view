import { test, expect } from "bun:test";
import {
  CHECKIN_QUESTIONS,
  questionFor,
  isCheckinStatus,
  isPromptDay,
  FIRST_PROMPT_AT,
  REMINDER_AT,
  FINAL_NOTICE_AT,
  ESCALATION_DELAY_MS,
  planPrompts,
  type CheckinBoardRow,
  type CheckinBuyer,
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

test("isCheckinStatus accepts an in-scope status and rejects everything else", () => {
  // `Object.keys(X).every(isCheckinStatus)` would be tautological — isCheckinStatus IS hasOwn over
  // that same object — and the six-value assertion lives in the next test.
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

test("the three notification marks are the agreed ones", () => {
  expect(FIRST_PROMPT_AT).toEqual({ hour: 13, minute: 30 });
  expect(REMINDER_AT).toEqual({ hour: 17, minute: 30 });
  expect(FINAL_NOTICE_AT).toEqual({ hour: 8, minute: 0 });
});

test("the reminder follows the first prompt on the same day, and the final notice cannot", () => {
  // Ordering, not just values: a reminder at or before the prompt would fire on the same loop pass
  // and re-send a list nobody has had a chance to answer.
  const mins = (m: { hour: number; minute: number }) => m.hour * 60 + m.minute;
  expect(mins(REMINDER_AT)).toBeGreaterThan(mins(FIRST_PROMPT_AT));
  // The final notice is BEFORE the first prompt on the clock, which is what makes it belong to the
  // next calendar day rather than to a third slot on the same evening.
  expect(mins(FINAL_NOTICE_AT)).toBeLessThan(mins(FIRST_PROMPT_AT));
});

test("the escalation trails the final notice and still lands before the next day's prompt", () => {
  // A zero delay is the defect this constant exists to prevent: the channel post used to go out in
  // the same pass as the FINAL DM, so nothing the buyer did in response could change the outcome.
  expect(ESCALATION_DELAY_MS).toBeGreaterThan(0);
  // It cannot grow past the next prompt either. An escalation that lands after 13:30 reports a day
  // nobody is looking at any more, from behind the fresh list sitting in the same chat.
  const escalationMins =
    FINAL_NOTICE_AT.hour * 60 + FINAL_NOTICE_AT.minute + ESCALATION_DELAY_MS / 60_000;
  expect(escalationMins).toBeLessThan(FIRST_PROMPT_AT.hour * 60 + FIRST_PROMPT_AT.minute);
});

const VLAD = "2cbd872b-594c-8119-9649-0002845d8d9c";
const SHIKHAR = "254d872b-594c-8154-9479-000271904e5b";
const SOFIA = "28cd872b-594c-81ff-af89-0002cb38d0f7";

const buyers: CheckinBuyer[] = [
  { personId: SHIKHAR, displayName: "Shikhar Gupta", chatId: "111", active: true },
  { personId: VLAD, displayName: "Vladyslav Istrati", chatId: "222", active: true },
];

const row = (o: Partial<CheckinBoardRow> = {}): CheckinBoardRow => ({
  pageId: o.pageId ?? "p1",
  title: o.title ?? "Slots.lv",
  // `o.status ?? "Live"` would turn an explicit `status: null` back into "Live" and make the
  // out-of-scope test assert nothing. Only an absent key takes the default.
  status: "status" in o ? (o.status ?? null) : "Live",
  ownerIds: o.ownerIds ?? [SHIKHAR],
});

test("a live row owned by a buyer produces one prompt", () => {
  const plans = planPrompts([row()], buyers);
  expect(plans).toHaveLength(1);
  expect(plans[0]).toEqual({
    notionPageId: "p1",
    campaignTitle: "Slots.lv",
    status: "Live",
    buyerPersonId: SHIKHAR,
    chatId: "111",
    question: "Any changes today — budget, creatives, targeting?",
  });
});

test("out-of-scope statuses produce nothing", () => {
  expect(planPrompts([row({ status: "Full Budget Finished" })], buyers)).toEqual([]);
  expect(planPrompts([row({ status: null })], buyers)).toEqual([]);
});

test("non-buyer owners are ignored", () => {
  // Sofia, Nick, Abel and Elad own rows but are not media buyers.
  expect(planPrompts([row({ ownerIds: [SOFIA] })], buyers)).toEqual([]);
});

test("a row with no owners produces nothing", () => {
  expect(planPrompts([row({ ownerIds: [] })], buyers)).toEqual([]);
});

test("a row owned by both buyers prompts both", () => {
  const plans = planPrompts([row({ ownerIds: [SHIKHAR, VLAD] })], buyers);
  expect(plans.map((p) => p.buyerPersonId).sort()).toEqual([SHIKHAR, VLAD].sort());
});

test("an inactive buyer is skipped", () => {
  const inactive = [{ ...buyers[0], active: false }, buyers[1]];
  expect(planPrompts([row({ ownerIds: [SHIKHAR] })], inactive)).toEqual([]);
});

test("a buyer with no bound chat is still planned, with a null chat", () => {
  // Planned rather than dropped so the 09:00 escalation can name the binding gap.
  const unbound = [{ ...buyers[0], chatId: null }];
  const plans = planPrompts([row()], unbound);
  expect(plans).toHaveLength(1);
  expect(plans[0].chatId).toBeNull();
});

test("the same page listed twice yields one prompt per buyer", () => {
  // A page can appear under more than one client snapshot; a duplicate prompt would double-comment.
  // Two owners, so this also pins the `:${ownerId}` half of the key: a dedupe keyed on page id
  // alone would collapse the two buyers into one prompt and silently drop a buyer's question.
  const dupe = { pageId: "p1", ownerIds: [SHIKHAR, VLAD] };
  const plans = planPrompts([row(dupe), row(dupe)], buyers);
  expect(plans).toHaveLength(2);
  expect(plans.map((p) => p.buyerPersonId).sort()).toEqual([SHIKHAR, VLAD].sort());
});

test("prompts are ordered by campaign title so the message is stable", () => {
  const plans = planPrompts(
    [
      row({ pageId: "p2", title: "Zebra", ownerIds: [SHIKHAR] }),
      row({ pageId: "p3", title: "Alpha", ownerIds: [SHIKHAR] }),
    ],
    buyers,
  );
  expect(plans.map((p) => p.campaignTitle)).toEqual(["Alpha", "Zebra"]);
});

test("prompts fire Monday to Friday and never at the weekend", () => {
  // 2026-08-10 is a Monday, so this walks one full week.
  const week = [
    ["2026-08-10", true], // Mon
    ["2026-08-11", true], // Tue
    ["2026-08-12", true], // Wed
    ["2026-08-13", true], // Thu
    ["2026-08-14", true], // Fri
    ["2026-08-15", false], // Sat
    ["2026-08-16", false], // Sun
  ] as const;
  for (const [date, expected] of week) expect(isPromptDay(date)).toBe(expected);
});

test("the weekday answer does not depend on the process timezone", () => {
  // A UTC-11 host reading a Date object would see Friday's midnight as Thursday. Reading the date
  // STRING with UTC getters is what makes this immune.
  for (const tz of ["Pacific/Kiritimati", "Pacific/Midway", "Europe/Berlin"]) {
    const prev = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = tz;
    try {
      expect(isPromptDay("2026-08-15")).toBe(false); // Sat
      expect(isPromptDay("2026-08-17")).toBe(true); // Mon
    } finally {
      process.env.TZ = prev;
    }
  }
});
