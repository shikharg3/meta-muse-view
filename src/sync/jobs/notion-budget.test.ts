import { test, expect } from "bun:test";
import { forecastBudgetEnd } from "@/lib/budget-forecast";
import {
  sumDailyBudget,
  planRow,
  planSpendRow,
  planEndDate,
  targetDailyBudget,
  TARGET_BUDGET_DAYS,
  destinationCell,
  planDestinations,
  AUTO_DESTINATION_COLUMN,
  canDeliver,
  avgDailySpend,
  AUTO_BUDGET_COLUMN,
  AUTO_SPEND_COLUMN,
  AUTO_PROJECTED_END_COLUMN,
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

test("the target daily budget is the contracted budget spread over a month", () => {
  expect(TARGET_BUDGET_DAYS).toBe(30);
  expect(targetDailyBudget(10800)).toBe(360);
  expect(targetDailyBudget(6427)).toBe(214.23); // rounded to cents
  // No contract, no target — and a zero or negative budget is not a target either.
  expect(targetDailyBudget(null)).toBeNull();
  expect(targetDailyBudget(0)).toBeNull();
  expect(targetDailyBudget(-500)).toBeNull();
});

test("planRow writes a changed target and never rewrites an unchanged one", () => {
  expect(planRow({ status: "Live", current: 476, target: 511.54 })).toEqual({
    dollars: 511.54,
    skip: null,
  });
  expect(planRow({ status: "Live", current: 511.54, target: 511.54 }).skip).toBe("unchanged");
  expect(planRow({ status: "Live", current: 511.541, target: 511.54 }).skip).toBe("unchanged");
  expect(planRow({ status: "Live", current: null, target: 511.54 }).dollars).toBe(511.54);
});

test("planRow says so when a live row has no contracted budget to spread", () => {
  const plan = planRow({ status: "Live", current: 476, target: null });
  expect(plan.dollars).toBeNull();
  expect(plan.skip).toContain("no Budget ($)");
});

test("planRow never touches a non-live engagement", () => {
  // A closed period's contracted budget is the only account of it; its accounts get recycled onto the
  // next client, so nothing about today applies.
  for (const status of ["Full Budget Finished", "Paused", "Not started", null]) {
    for (const target of [null, 250, 7500]) {
      const plan = planRow({ status, current: 250, target });
      expect(plan.dollars).toBeNull();
      expect(plan.skip).toBe("not a live engagement; keeping the recorded value");
    }
  }
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

test("planEndDate writes a projection only for live rows, and never rewrites the same date", () => {
  const live = { status: "Live", current: null, projected: "2026-09-14", reason: null };
  expect(planEndDate(live)).toEqual({ date: "2026-09-14", clear: false, skip: null });
  // Replacing an earlier projection is a normal update.
  expect(planEndDate({ ...live, current: "2026-09-01" }).date).toBe("2026-09-14");
  // Same date: no write, so `Last edited time` keeps meaning a human touched the row.
  expect(planEndDate({ ...live, current: "2026-09-14" })).toEqual({
    date: null,
    clear: false,
    skip: "unchanged",
  });
  // A finished engagement's accounts get recycled, so its dates are none of our business.
  for (const status of ["Full Budget Finished", "Paused", "Not started", null]) {
    expect(planEndDate({ ...live, status })).toEqual({
      date: null,
      clear: false,
      skip: "not a live engagement",
    });
  }
});

test("a live row that can no longer be projected has its stale date blanked", () => {
  // The basis changed under these rows once already: a date nothing stands behind any more is worse
  // than an empty cell, so it is cleared rather than left to be believed.
  const gone = { status: "Live", projected: null, reason: "no recent spend" };
  expect(planEndDate({ ...gone, current: "2026-09-14" })).toEqual({
    date: null,
    clear: true,
    skip: "no recent spend",
  });
  // Nothing there to clear, so nothing is written.
  expect(planEndDate({ ...gone, current: null }).clear).toBe(false);
  // A non-live row is never touched, stale date or not.
  expect(planEndDate({ ...gone, status: "Paused", current: "2026-09-14" }).clear).toBe(false);
});

test("planEndDate surfaces the forecaster's reason instead of writing a blank", () => {
  // The real cases on this board: no budget on the row, an engagement that started but has not spent
  // yet, and a pace so low the date would be meaningless.
  for (const reason of ["no budget set", "no recent spend", "pace too low to project"]) {
    expect(planEndDate({ status: "Live", current: null, projected: null, reason })).toEqual({
      date: null,
      clear: false,
      skip: reason,
    });
  }
  expect(
    planEndDate({ status: "Live", current: "2026-09-01", projected: null, reason: null }).skip,
  ).toBe("not forecastable");
});

test("an exhausted budget projects today, and that date is written", () => {
  // forecastBudgetEnd returns today with reason "budget exhausted"; the row should still be updated,
  // because "the money is gone" is exactly what the column needs to say.
  expect(
    planEndDate({ status: "Live", current: "2026-12-01", projected: "2026-08-06", reason: null })
      .date,
  ).toBe("2026-08-06");
});

test("the projected-end column carries the machine-written marker", () => {
  expect(AUTO_PROJECTED_END_COLUMN).toBe("🤖 Projected End Date");
});

test("the end date divides remaining funds by the target daily budget", () => {
  // betonline.ag: a $10,800 contract targets $360/day, and $5,692.65 of funded money lasts 16 days.
  const target = targetDailyBudget(10800);
  if (target === null) throw new Error("expected a target");
  const f = forecastBudgetEnd({ total: 5692.65, spent: 0, dailyPace: target, today: "2026-08-10" });
  expect(target).toBe(360);
  expect(f.daysRemaining).toBe(16);
  expect(f.projectedEndDate).toBe("2026-08-26");

  // The old basis was trailing ACTUAL spend, which for this row was $0/day on a freshly rotated-on
  // account and produced no date at all.
  expect(
    forecastBudgetEnd({ total: 6678.01, spent: 0, dailyPace: 0, today: "2026-08-06" })
      .projectedEndDate,
  ).toBeNull();
});

test("the destination cell lists one page per line, most-spending first", () => {
  expect(destinationCell(["https://a.example/1", "https://b.example/2"])).toBe(
    "https://a.example/1\nhttps://b.example/2",
  );
  expect(destinationCell([])).toBe("");
});

test("an over-long destination list is truncated with a count, never mid-URL", () => {
  const many = Array.from({ length: 60 }, (_, i) => `https://example.com/${"p".repeat(40)}/${i}`);
  const cell = destinationCell(many);
  expect(cell.length).toBeLessThanOrEqual(2000);
  expect(cell).toContain("more");
  // Every line except the trailing note is a whole URL.
  for (const line of cell.split("\n").slice(0, -1)) expect(many).toContain(line);
});

test("destinations are written for live rows and cleared when nothing is running", () => {
  const live = { status: "Live", current: "" };
  expect(planDestinations({ ...live, urls: ["https://a.example/x"] })).toEqual({
    text: "https://a.example/x",
    skip: null,
  });
  // Already correct: no write, so the hourly pass is idempotent.
  expect(
    planDestinations({
      status: "Live",
      current: "https://a.example/x",
      urls: ["https://a.example/x"],
    }),
  ).toEqual({ text: null, skip: "unchanged" });
  // Live row, nothing running: a stale page reads as "traffic goes here", so it is cleared.
  expect(planDestinations({ status: "Live", current: "https://old.example/y", urls: [] })).toEqual({
    text: "",
    skip: null,
  });
  // Nothing running and nothing recorded: leave it alone.
  expect(planDestinations({ ...live, urls: [] })).toEqual({
    text: null,
    skip: "no live ads with a link",
  });
});

test("a finished engagement's destinations are never touched", () => {
  for (const status of ["Full Budget Finished", "Paused", "Not started"])
    expect(
      planDestinations({ status, current: "https://a.example/x", urls: ["https://b.example/z"] }),
    ).toEqual({ text: null, skip: "not a live engagement" });
});

test("the destination column carries the machine-written marker", () => {
  expect(AUTO_DESTINATION_COLUMN).toBe("🤖 Destination URL");
});
