import { test, expect } from "bun:test";
import { forecastBudgetEnd, PACE_DAYS } from "@/lib/budget-forecast";
import type { GeoSpend } from "@/lib/geo-cell";
import {
  sumDailyBudget,
  planRow,
  planSpendRow,
  planEndDate,
  targetDailyBudget,
  budgetRemaining,
  planBudgetRemainingRow,
  AUTO_BUDGET_REMAINING_COLUMN,
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
  statusForRow,
  AUTO_ACCOUNT_STATUS_COLUMN,
  GEO_COLUMN,
  AUTO_GEO_COLUMN,
  geoSkipReason,
  planGeo,
  AUTO_FUNDS_COLUMN,
  FUNDS_COLUMN,
  BUDGET_REMAINING_COLUMN,
} from "./notion-budget";
import { ACCOUNT_STATUS_COLUMN, resolvePropertyKey } from "@/notion/parse";

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
  for (const status of ["Full Budget Finished", "Not started", null]) {
    for (const target of [null, 250, 7500]) {
      const plan = planRow({ status, current: 250, target });
      expect(plan.dollars).toBeNull();
      expect(plan.skip).toBe("not a live engagement; keeping the recorded value");
    }
  }
});

test("planRow DOES maintain a paused engagement", () => {
  // Paused became machine-owned when the sync started deriving Account Status: it means "current
  // engagement, delivery stopped", not "closed". Its pacing columns are still wanted, because it is
  // the row that is about to restart.
  expect(planRow({ status: "Paused", current: 250, target: 7500 }).dollars).toBe(7500);
});

test("planSpendRow follows the same live-only rule and skips unchanged values", () => {
  expect(planSpendRow({ status: "Live", current: null, spend: 715.04 }).dollars).toBe(715.04);
  expect(planSpendRow({ status: "Live", current: 715.04, spend: 715.04 }).skip).toBe("unchanged");
  // Zero spend on a live row IS written — it says delivery stopped.
  expect(planSpendRow({ status: "Live", current: 500, spend: 0 }).dollars).toBe(0);
  expect(planSpendRow({ status: "Full Budget Finished", current: 500, spend: 900 }).skip).toBe(
    "not a live engagement; keeping the recorded value",
  );
  expect(planSpendRow({ status: "Live", current: 500, spend: null }).skip).toBe(
    "no synced ad accounts on this row",
  );
});

test("every auto-updated column name matches what is actually on the board", () => {
  // These are not decoration. `ensureColumn` resolves by shape and CREATES when it finds nothing, so
  // a constant that has drifted from the board silently stops maintaining the real column and grows
  // a duplicate beside it. That is exactly what happened to the funds column when the team renamed
  // it, which is why its name is spelled out here rather than assumed.
  expect(AUTO_BUDGET_COLUMN).toBe("🤖 Daily Budget ($)");
  expect(AUTO_SPEND_COLUMN).toBe("🤖 Avg Daily Spend 7d ($)");
  expect(AUTO_FUNDS_COLUMN).toBe("🤖 Ad Account Funds Remaining ($)");
  expect(AUTO_BUDGET_REMAINING_COLUMN).toBe("🤖 Budget Remaining ($)");
  expect(AUTO_PROJECTED_END_COLUMN).toBe("🤖 Projected End Date");
  expect(AUTO_DESTINATION_COLUMN).toBe("🤖 Destination URL");
  // The two remaining-money columns must stay distinguishable by shape, or one would resolve to the
  // other's column and the job would write the contract figure into the ad-account balance.
  expect(resolvePropertyKey([AUTO_FUNDS_COLUMN], BUDGET_REMAINING_COLUMN)).toBeNull();
  expect(resolvePropertyKey([AUTO_BUDGET_REMAINING_COLUMN], FUNDS_COLUMN)).toBeNull();
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
  for (const status of ["Full Budget Finished", "Not started", null]) {
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
  // A non-live row is never touched, stale date or not. Paused no longer qualifies — it is a current
  // engagement whose delivery stopped, so its stale date is still cleared.
  expect(
    planEndDate({ ...gone, status: "Full Budget Finished", current: "2026-09-14" }).clear,
  ).toBe(false);
  // The claim in that comment, actually asserted rather than only stated.
  expect(planEndDate({ ...gone, status: "Paused", current: "2026-09-14" }).clear).toBe(true);
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
  for (const status of ["Full Budget Finished", "Not started"])
    expect(
      planDestinations({ status, current: "https://a.example/x", urls: ["https://b.example/z"] }),
    ).toEqual({ text: null, skip: "not a live engagement" });
});

test("the destination column carries the machine-written marker", () => {
  expect(AUTO_DESTINATION_COLUMN).toBe("🤖 Destination URL");
});

// One healthy row's worth of ladder input: a live account, an active campaign, an active ad set and a
// running ad. Each test perturbs one piece.
const liveRow = {
  accounts: [{ disabled: false, deliverable: true }],
  campaigns: [{ id: "c1", active: true }],
  adSets: [{ id: "s1", campaignId: "c1", active: true }],
  ads: [{ adSetId: "s1", disapproved: false }],
};

test("statusForRow writes nothing when the row supports no verdict", () => {
  expect(
    statusForRow({ ...liveRow, accounts: [], campaigns: [], current: "Live", override: null }),
  ).toBeNull();
});

test("statusForRow never overwrites a human-owned value, even with an override set", () => {
  // The one rule with no exceptions: a commercial status is the team's record, and Meta cannot know
  // whether an exhausted budget means "contract over" or "awaiting a top-up".
  expect(
    statusForRow({ ...liveRow, current: "Full Budget Finished", override: "Paused" }),
  ).toBeNull();
  expect(statusForRow({ ...liveRow, current: "On Boarding", override: null })).toBeNull();
});

test("statusForRow prefers a pinned override over the derived value", () => {
  expect(
    statusForRow({
      ...liveRow,
      ads: [{ adSetId: "s1", disapproved: true }],
      current: "All ads rejected",
      override: "Live",
    }),
  ).toBe("Live");
});

test("statusForRow ignores an override that is not a machine-owned value", () => {
  // The server fn rejects these, but a row predating a rename could still hold one.
  expect(statusForRow({ ...liveRow, current: "Paused", override: "Full Budget Finished" })).toBe(
    "Live",
  );
});

// Pins the function's contract, but note the job cannot reach this input: an empty status is `notLive`,
// and non-live rows are excluded from account→row attribution, so they arrive with no campaigns. The
// sync maintains a status, it does not bootstrap one.
test("statusForRow fills an empty cell", () => {
  expect(statusForRow({ ...liveRow, current: null, override: null })).toBe("Live");
});

test("statusForRow returns null when the derived value already matches the cell", () => {
  // An unchanged cell is never rewritten, so `Last edited time` keeps meaning "a human edited this".
  expect(statusForRow({ ...liveRow, current: "Live", override: null })).toBeNull();
});

test("the Account Status column carries the machine-written marker too", () => {
  expect(AUTO_ACCOUNT_STATUS_COLUMN).toBe("🤖 Account Status");
  // And the read side must still find it under that name, or every row reads as non-live.
  expect(resolvePropertyKey([AUTO_ACCOUNT_STATUS_COLUMN], ACCOUNT_STATUS_COLUMN)).toBe(
    AUTO_ACCOUNT_STATUS_COLUMN,
  );
});

test("budget remaining is the contract minus spend since the engagement started", () => {
  expect(budgetRemaining(10800, 5145.86)).toBe(5654.14);
  // Overspent contracts are reported as negative, not clamped: betonline.ag has delivered $10,891.78
  // against a $10,800 contract, and that overrun is the whole point of the column.
  expect(budgetRemaining(10800, 10891.78)).toBe(-91.78);
  // Either side missing makes the figure unknowable, which is not the same as zero.
  expect(budgetRemaining(null, 500)).toBeNull();
  expect(budgetRemaining(10800, null)).toBeNull();
});

test("planBudgetRemainingRow writes live rows, skips unchanged, and never touches finished ones", () => {
  expect(planBudgetRemainingRow({ status: "Live", current: null, remaining: 5654.14 })).toEqual({
    dollars: 5654.14,
    skip: null,
  });
  expect(
    planBudgetRemainingRow({ status: "Live", current: 5654.14, remaining: 5654.14 }).skip,
  ).toBe("unchanged");
  // A negative figure is still written.
  expect(planBudgetRemainingRow({ status: "Live", current: 0, remaining: -2246.24 }).dollars).toBe(
    -2246.24,
  );
  expect(planBudgetRemainingRow({ status: "Live", current: 100, remaining: null })).toEqual({
    dollars: null,
    skip: "budget remaining not determinable",
  });
  // A machine-written `Paused` row is still the client's current engagement, so it keeps its pacing
  // columns; only a closed or unstarted period is left alone.
  for (const status of ["Full Budget Finished", "Not started", null])
    expect(planBudgetRemainingRow({ status, current: 100, remaining: 5654.14 }).skip).toBe(
      "not a live engagement; keeping the recorded value",
    );
  expect(
    planBudgetRemainingRow({ status: "Paused", current: 100, remaining: 5654.14 }).dollars,
  ).toBe(5654.14);
});

test("the budget-remaining column carries the machine-written marker", () => {
  expect(AUTO_BUDGET_REMAINING_COLUMN).toBe("🤖 Budget Remaining ($)");
});

test("the geo column cannot collide with the human `Geo's` brief", () => {
  // ensureColumn resolves by keyShape and RENAMES what it finds. keyShape strips punctuation and the
  // emoji, so keyShape("Geo's") === keyShape("🤖 Geo's") — passing "Geo's" would rename the team's
  // brief column and begin overwriting 79 rows of prose that no code can regenerate.
  expect(resolvePropertyKey(["Geo's", "Campaign"], GEO_COLUMN)).toBeNull();
  expect(resolvePropertyKey(["Geo's", "Campaign"], AUTO_GEO_COLUMN)).toBeNull();
  // It must still find its own column once the marker has been stamped on it.
  expect(resolvePropertyKey([AUTO_GEO_COLUMN], GEO_COLUMN)).toBe(AUTO_GEO_COLUMN);
  // Pinned as a literal like every other machine column: once the board carries this column, a
  // rename that still avoids the collision would silently orphan it. The `14d` is not decoration —
  // it names the window `paceWindow()` measures, so the two must move together.
  expect(AUTO_GEO_COLUMN).toBe("🤖 Geo Delivered 14d");
  expect(GEO_COLUMN).toContain(String(PACE_DAYS));
});

test("geo skips what it cannot attribute, but never for currency", () => {
  const ok = { ambiguous: false, accountIds: ["act_1"], syncedAccountIds: ["act_1"] };
  expect(geoSkipReason(ok)).toBeNull();
  expect(geoSkipReason({ ...ok, ambiguous: true })).toBe(
    "campaigns on a shared account could not be split by name",
  );
  expect(geoSkipReason({ ambiguous: false, accountIds: [], syncedAccountIds: [] })).toBe(
    "no ad accounts on this row",
  );
  expect(geoSkipReason({ ...ok, syncedAccountIds: [] })).toBe(
    "row's ad accounts are not visible to the Meta token",
  );
  // The dollar columns refuse a non-USD row because they sum money across accounts. This cascade
  // takes no currency argument at all: a share needs no FX rate, so a EUR row still gets a geo cell.
});

const usOnly: GeoSpend[] = [{ type: "country", value: "US", spend: 1000 }];

test("the geo cell is written for live rows and cleared when nothing delivered", () => {
  expect(
    planGeo({ status: "Live", current: "", rows: usOnly, windowSpend: 1000, skip: null }),
  ).toEqual({
    text: "US 100%",
    skip: null,
  });
  expect(
    planGeo({ status: "Live", current: "US 100%", rows: usOnly, windowSpend: 1000, skip: null }),
  ).toEqual({ text: null, skip: "unchanged" });
  // Live, nothing delivered, a stale value on the board: clear it. A leftover geo reads as "we are
  // running here" when nothing is.
  expect(
    planGeo({ status: "Live", current: "AR 100%", rows: [], windowSpend: 0, skip: null }),
  ).toEqual({
    text: "",
    skip: null,
  });
  // Nothing delivered and nothing recorded: leave it alone.
  expect(planGeo({ status: "Live", current: "", rows: [], windowSpend: 0, skip: null })).toEqual({
    text: null,
    skip: "nothing delivered in the window",
  });
});

test("spend with no breakdown rows behind it is a data gap, and must never blank the cell", () => {
  // Breakdowns refresh on the daily `full` pass (`sync/cycle.ts`); insights_daily refreshes hourly.
  // A row that spent but has no country rows yet is mid-lag, not geo-less. Clearing here would
  // report a sync fault as a geo fact on a row delivering perfectly well.
  expect(
    planGeo({ status: "Live", current: "US 100%", rows: [], windowSpend: 420, skip: null }),
  ).toEqual({ text: null, skip: "breakdown data not caught up" });
});

test("a row too new for a pace window is skipped, not cleared", () => {
  // `rows: usOnly`, not an empty set: with no rows this passes even if the guard is moved below the
  // geoCell call, because the empty-cell path reaches the same place. Breakdown rows present is the
  // case only this guard answers — a two-day-old engagement must not get a cell labelled `14d`.
  expect(
    planGeo({ status: "Live", current: "US 100%", rows: usOnly, windowSpend: null, skip: null }),
  ).toEqual({ text: null, skip: "engagement too new to measure" });
  // The caller's reason outranks the missing window, so these two guards cannot be swapped.
  expect(
    planGeo({
      status: "Live",
      current: "US 100%",
      rows: usOnly,
      windowSpend: null,
      skip: "no ad accounts on this row",
    }),
  ).toEqual({ text: null, skip: "no ad accounts on this row" });
});

test("liveness outranks every other geo skip reason", () => {
  const caller = "no ad accounts on this row";
  expect(
    planGeo({ status: "Live", current: "", rows: usOnly, windowSpend: 1000, skip: caller }),
  ).toEqual({ text: null, skip: caller });
  for (const status of ["Full Budget Finished", "Not started", null])
    expect(
      planGeo({ status, current: "AR 100%", rows: usOnly, windowSpend: 1000, skip: caller }),
    ).toEqual({ text: null, skip: "not a live engagement" });
});
