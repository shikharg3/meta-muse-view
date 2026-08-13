import { test, expect } from "bun:test";
import {
  CHECKIN_QUESTIONS,
  questionFor,
  isCheckinStatus,
  CHECKIN_HOUR,
  ESCALATION_HOUR,
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

test("the gate hours are the agreed ones", () => {
  expect(CHECKIN_HOUR).toBe(17);
  expect(ESCALATION_HOUR).toBe(9);
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
