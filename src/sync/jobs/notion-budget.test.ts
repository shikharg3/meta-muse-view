import { test, expect } from "bun:test";
import {
  sumDailyBudget,
  planRow,
  AUTO_BUDGET_COLUMN,
  type ActiveCampaign,
  type ActiveAdSet,
} from "./notion-budget";

const cbo = (id: string, cents: number, accountId = "act_1"): ActiveCampaign => ({
  id,
  accountId,
  name: id,
  dailyBudget: cents,
  lifetimeBudget: null,
});
const abo = (id: string, accountId = "act_1"): ActiveCampaign => ({
  id,
  accountId,
  name: id,
  dailyBudget: null,
  lifetimeBudget: null,
});
const lifetime = (id: string, cents: number, accountId = "act_1"): ActiveCampaign => ({
  id,
  accountId,
  name: id,
  dailyBudget: null,
  lifetimeBudget: cents,
});
const set = (campaignId: string, cents: number | null): ActiveAdSet => ({
  campaignId,
  dailyBudget: cents,
});

test("sumDailyBudget adds campaign-level budgets across accounts, in major units", () => {
  // The live board case: one client, two accounts, three running campaigns.
  const s = sumDailyBudget(
    [cbo("c1", 51154), cbo("c2", 30000, "act_2"), cbo("c3", 10000, "act_2")],
    [],
  );
  expect(s.dollars).toBe(911.54);
  expect(s.campaigns).toBe(3);
  expect(s.lifetimeOnly).toBe(0);
});

test("sumDailyBudget takes ad-set budgets only for campaigns that hold none (no double count)", () => {
  const s = sumDailyBudget(
    [cbo("cbo1", 50000), abo("abo1")],
    [
      set("abo1", 20000),
      set("abo1", 20000),
      set("cbo1", 99999), // must be ignored: the campaign already carries the budget
      set("other", 12345), // not this row's campaign
      set("abo1", null), // no budget set
    ],
  );
  expect(s.dollars).toBe(900);
  // The ABO campaign counts once, however many of its ad sets contributed.
  expect(s.campaigns).toBe(2);
});

test("sumDailyBudget reports lifetime-budget campaigns separately from a true zero", () => {
  const running = sumDailyBudget([lifetime("lt", 500000)], []);
  expect(running.dollars).toBe(0);
  expect(running.lifetimeOnly).toBe(1);
  expect(running.campaigns).toBe(0);

  const nothing = sumDailyBudget([], []);
  expect(nothing).toEqual({ dollars: 0, campaigns: 0, lifetimeOnly: 0 });
});

test("planRow writes a changed figure and never rewrites an unchanged one", () => {
  const sum = { dollars: 511.54, campaigns: 1, lifetimeOnly: 0 };
  expect(planRow({ status: "Live", current: 476, sum })).toEqual({ dollars: 511.54, skip: null });
  // Never touched when equal — `Last edited time` must keep meaning "a human edited this row".
  expect(planRow({ status: "Live", current: 511.54, sum }).skip).toBe("unchanged");
  expect(planRow({ status: "Live", current: 511.541, sum }).skip).toBe("unchanged");
  // A blank cell is still a change.
  expect(planRow({ status: "Live", current: null, sum }).dollars).toBe(511.54);
});

test("planRow zeroes a live row that stopped, but never touches a non-live engagement", () => {
  const zero = { dollars: 0, campaigns: 0, lifetimeOnly: 0 };
  // Contract live, nothing delivering: 0 is the truth and worth surfacing.
  expect(planRow({ status: "Live", current: 476, sum: zero }).dollars).toBe(0);
  expect(planRow({ status: "Budget Finished - Top Up", current: 476, sum: zero }).dollars).toBe(0);
  expect(planRow({ status: "On Boarding", current: 476, sum: zero }).dollars).toBe(0);
  // Finished/paused/unstarted engagements keep what the team recorded. Their old ad accounts get
  // recycled onto the next client, so anything running there today is NOT this engagement's budget —
  // and that recorded figure is the only record of what was contracted.
  const running = { dollars: 7500, campaigns: 6, lifetimeOnly: 0 };
  for (const status of ["Full Budget Finished", "Paused", "Not started", null]) {
    for (const sum of [zero, running]) {
      const plan = planRow({ status, current: 250, sum });
      expect(plan.dollars).toBeNull();
      expect(plan.skip).toBe("not a live engagement; keeping the recorded value");
    }
  }
  // A live row already at 0 is left alone rather than rewritten.
  expect(planRow({ status: "Live", current: 0, sum: zero }).skip).toBe("unchanged");
});

test("planRow refuses to write a misleading zero for lifetime-only or unmapped rows", () => {
  const ltOnly = { dollars: 0, campaigns: 0, lifetimeOnly: 2 };
  expect(planRow({ status: "Live", current: 476, sum: ltOnly })).toEqual({
    dollars: null,
    skip: "2 active campaign(s) on a lifetime budget — no daily figure",
  });
  expect(planRow({ status: "Live", current: 476, sum: null })).toEqual({
    dollars: null,
    skip: "no synced ad accounts on this row",
  });
});

test("the auto-updated column name carries a marker the plain lookup still resolves", () => {
  expect(AUTO_BUDGET_COLUMN).toBe("🤖 Daily Budget ($)");
});
