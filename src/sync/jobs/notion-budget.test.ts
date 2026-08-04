import { test, expect } from "bun:test";
import {
  sumDailyBudget,
  planRow,
  planSpendRow,
  canDeliver,
  avgDailySpend,
  AUTO_BUDGET_COLUMN,
  AUTO_SPEND_COLUMN,
  SPEND_WINDOW_DAYS,
  type AttributedCampaign,
  type ActiveAdSet,
} from "./notion-budget";

const camp = (id: string, over: Partial<AttributedCampaign> = {}): AttributedCampaign => ({
  id,
  accountId: "act_1",
  name: id,
  dailyBudget: null,
  lifetimeBudget: null,
  active: true,
  deliverable: true,
  ...over,
});
const cbo = (id: string, cents: number, over: Partial<AttributedCampaign> = {}) =>
  camp(id, { dailyBudget: cents, ...over });
const set = (campaignId: string, cents: number | null): ActiveAdSet => ({
  campaignId,
  dailyBudget: cents,
});

test("canDeliver rejects disabled accounts and exhausted prepaid caps", () => {
  // The real failure this guards: a rented account is disabled or has burnt its cap, yet every
  // campaign on it still reports effective_status ACTIVE.
  expect(canDeliver({ status: "1", spendCap: 500000, amountSpent: 100000 })).toBe(true);
  expect(canDeliver({ status: "1", spendCap: null, amountSpent: 999999 })).toBe(true); // uncapped
  expect(canDeliver({ status: "1", spendCap: 0, amountSpent: 999999 })).toBe(true); // 0 = uncapped

  // Disabled (Meta account_status 2), and other non-active codes.
  expect(canDeliver({ status: "2", spendCap: 500000, amountSpent: 0 })).toBe(false);
  expect(canDeliver({ status: "101", spendCap: 500000, amountSpent: 0 })).toBe(false);
  expect(canDeliver({ status: "7", spendCap: 500000, amountSpent: 0 })).toBe(false);

  // Cap spent to the cent — the state every idle Slots.lv account was in.
  expect(canDeliver({ status: "1", spendCap: 428501, amountSpent: 428501 })).toBe(false);
  // Meta reports a 1-cent cap on blocked accounts; a bare `> 0` test would let those through.
  expect(canDeliver({ status: "1", spendCap: 1, amountSpent: 0 })).toBe(false);
  // Under a dollar of headroom is not worth reporting as budget.
  expect(canDeliver({ status: "1", spendCap: 100050, amountSpent: 100000 })).toBe(false);
  expect(canDeliver({ status: "1", spendCap: 100200, amountSpent: 100000 })).toBe(true);
});

test("sumDailyBudget adds campaign-level budgets across accounts, in major units", () => {
  const s = sumDailyBudget(
    [
      cbo("c1", 51154),
      cbo("c2", 30000, { accountId: "act_2" }),
      cbo("c3", 10000, { accountId: "act_2" }),
    ],
    [],
  );
  expect(s.dollars).toBe(911.54);
  expect(s.campaigns).toBe(3);
  expect(s.lifetimeOnly).toBe(0);
  expect(s.blocked).toBe(0);
});

test("sumDailyBudget excludes campaigns whose account cannot spend", () => {
  // Exactly the Slots.lv shape: most accounts disabled or out of funding, campaigns still ACTIVE.
  const s = sumDailyBudget(
    [
      cbo("live", 160000),
      cbo("dead", 160000, { deliverable: false }),
      cbo("broke", 200000, { deliverable: false }),
      cbo("paused", 160000, { active: false }),
    ],
    [],
  );
  expect(s.dollars).toBe(1600);
  expect(s.campaigns).toBe(1);
  expect(s.blocked).toBe(2); // a paused campaign is not "blocked", it is simply off
});

test("sumDailyBudget ignores ad sets under blocked or non-active campaigns", () => {
  const s = sumDailyBudget(
    [
      camp("abo_live"),
      camp("abo_dead", { deliverable: false }),
      camp("abo_off", { active: false }),
    ],
    [set("abo_live", 40000), set("abo_dead", 40000), set("abo_off", 40000)],
  );
  expect(s.dollars).toBe(400);
  expect(s.campaigns).toBe(1);
});

test("sumDailyBudget takes ad-set budgets only for campaigns that hold none (no double count)", () => {
  const s = sumDailyBudget(
    [cbo("cbo1", 50000), camp("abo1")],
    [
      set("abo1", 20000),
      set("abo1", 20000),
      set("cbo1", 99999), // ignored: the campaign already carries the budget
      set("other", 12345), // not this row's campaign
      set("abo1", null),
    ],
  );
  expect(s.dollars).toBe(900);
  expect(s.campaigns).toBe(2); // the ABO campaign counts once, however many ad sets contributed
});

test("sumDailyBudget reports lifetime-budget campaigns separately from a true zero", () => {
  const running = sumDailyBudget([camp("lt", { lifetimeBudget: 500000 })], []);
  expect(running.dollars).toBe(0);
  expect(running.lifetimeOnly).toBe(1);
  expect(running.campaigns).toBe(0);

  expect(sumDailyBudget([], [])).toEqual({
    dollars: 0,
    campaigns: 0,
    lifetimeOnly: 0,
    blocked: 0,
  });
});

test("avgDailySpend averages over the window and rounds to cents", () => {
  expect(avgDailySpend(5005.29, 7)).toBe(715.04);
  expect(avgDailySpend(0)).toBe(0);
  expect(SPEND_WINDOW_DAYS).toBe(7);
});

test("planRow writes a changed figure and never rewrites an unchanged one", () => {
  const sum = { dollars: 511.54, campaigns: 1, lifetimeOnly: 0, blocked: 0 };
  expect(planRow({ status: "Live", current: 476, sum })).toEqual({ dollars: 511.54, skip: null });
  expect(planRow({ status: "Live", current: 511.54, sum }).skip).toBe("unchanged");
  expect(planRow({ status: "Live", current: 511.541, sum }).skip).toBe("unchanged");
  expect(planRow({ status: "Live", current: null, sum }).dollars).toBe(511.54);
});

test("planRow zeroes a live row that stopped, but never touches a non-live engagement", () => {
  const zero = { dollars: 0, campaigns: 0, lifetimeOnly: 0, blocked: 0 };
  // Contract live, nothing able to deliver: 0 is the truth and a top-up signal.
  expect(planRow({ status: "Live", current: 476, sum: zero }).dollars).toBe(0);
  expect(planRow({ status: "Budget Finished - Top Up", current: 476, sum: zero }).dollars).toBe(0);
  expect(planRow({ status: "On Boarding", current: 476, sum: zero }).dollars).toBe(0);
  // Finished/paused/unstarted engagements keep what the team recorded: their old accounts get
  // recycled onto the next client, so what runs there today is not this engagement's budget.
  const running = { dollars: 7500, campaigns: 6, lifetimeOnly: 0, blocked: 0 };
  for (const status of ["Full Budget Finished", "Paused", "Not started", null]) {
    for (const sum of [zero, running]) {
      const plan = planRow({ status, current: 250, sum });
      expect(plan.dollars).toBeNull();
      expect(plan.skip).toBe("not a live engagement; keeping the recorded value");
    }
  }
  expect(planRow({ status: "Live", current: 0, sum: zero }).skip).toBe("unchanged");
});

test("planRow refuses to write a misleading zero for lifetime-only or unmapped rows", () => {
  expect(
    planRow({
      status: "Live",
      current: 476,
      sum: { dollars: 0, campaigns: 0, lifetimeOnly: 2, blocked: 0 },
    }),
  ).toEqual({
    dollars: null,
    skip: "2 active campaign(s) on a lifetime budget — no daily figure",
  });
  expect(planRow({ status: "Live", current: 476, sum: null })).toEqual({
    dollars: null,
    skip: "no synced ad accounts on this row",
  });
});

test("planSpendRow follows the same live-only rule and skips unchanged values", () => {
  expect(planSpendRow({ status: "Live", current: null, spend: 715.04 }).dollars).toBe(715.04);
  expect(planSpendRow({ status: "Live", current: 715.04, spend: 715.04 }).skip).toBe("unchanged");
  // Zero spend on a live row IS written — it says delivery stopped.
  expect(planSpendRow({ status: "Live", current: 500, spend: 0 }).dollars).toBe(0);
  expect(planSpendRow({ status: "Paused", current: 500, spend: 900 }).skip).toBe(
    "not a live engagement; keeping the recorded value",
  );
  expect(planSpendRow({ status: "Live", current: 500, spend: null }).skip).toBe(
    "no synced ad accounts on this row",
  );
});

test("both auto-updated columns carry the marker the plain lookup still resolves", () => {
  expect(AUTO_BUDGET_COLUMN).toBe("🤖 Daily Budget ($)");
  expect(AUTO_SPEND_COLUMN).toBe("🤖 Avg Daily Spend 7d ($)");
});
