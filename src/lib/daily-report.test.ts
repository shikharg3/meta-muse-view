import { test, expect } from "bun:test";
import {
  aggregateEngagements,
  collapseResults,
  includeCampaign,
  worstAccountStatus,
  type ReportAccount,
  type ReportCampaign,
} from "./daily-report";

const account = (id: string, over: Partial<ReportAccount> = {}): ReportAccount => ({
  id,
  currency: "USD",
  status: "ACTIVE",
  disableReason: null,
  ...over,
});

const campaign = (over: Partial<ReportCampaign> = {}): ReportCampaign => ({
  id: "c1",
  accountId: "act_1",
  clientId: "cl1",
  clientName: "Wildcasino",
  spend: 100,
  results: 10,
  resultLabel: "Purchases",
  active: true,
  ...over,
});

const accountsOf = (...rows: ReportAccount[]): Map<string, ReportAccount> =>
  new Map(rows.map((a) => [a.id, a]));

test("membership is the union of spent-yesterday and currently-active", () => {
  // Spent but since paused: its money is still yesterday's money.
  expect(includeCampaign(campaign({ spend: 50, active: false }))).toBe(true);
  // Live but silent: the line worth seeing, as 0.00.
  expect(includeCampaign(campaign({ spend: 0, active: true }))).toBe(true);
  // Neither — long-finished campaign.
  expect(includeCampaign(campaign({ spend: 0, active: false }))).toBe(false);
});

test("a paused campaign that spent yesterday still reaches the report", () => {
  const rows = aggregateEngagements(
    [campaign({ id: "c1", spend: 250, active: false })],
    accountsOf(account("act_1")),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.spend).toEqual([{ currency: "USD", amount: 250 }]);
});

test("unowned campaigns are dropped, not folded into a neighbour", () => {
  const rows = aggregateEngagements(
    [
      campaign({ id: "c1", clientId: "cl1", clientName: "Wildcasino", spend: 100 }),
      campaign({ id: "c2", clientId: null, clientName: null, spend: 900 }),
    ],
    accountsOf(account("act_1")),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.name).toBe("Wildcasino");
  expect(rows[0]!.sortSpend).toBe(100);
});

test("a shared account's campaigns are attributed per campaign, never duplicated", () => {
  // Both campaigns live on ONE account but belong to different engagements. Summing account-level
  // spend per claimant would give each of them the full 300; campaign-level attribution must not.
  const rows = aggregateEngagements(
    [
      campaign({ id: "c1", accountId: "act_shared", clientId: "cl1", clientName: "A", spend: 100 }),
      campaign({ id: "c2", accountId: "act_shared", clientId: "cl2", clientName: "B", spend: 200 }),
    ],
    accountsOf(account("act_shared")),
  );
  expect(rows.map((r) => [r.name, r.sortSpend])).toEqual([
    ["B", 200],
    ["A", 100],
  ]);
});

test("results sum under one label when objectives agree", () => {
  expect(
    collapseResults([
      campaign({ results: 55, resultLabel: "Purchases" }),
      campaign({ results: 28, resultLabel: "Purchases" }),
    ]),
  ).toEqual([{ label: "Purchases", count: 83 }]);
});

test("mixed objectives break down instead of adding leads to purchases", () => {
  expect(
    collapseResults([
      campaign({ results: 4, resultLabel: "Purchases" }),
      campaign({ results: 27, resultLabel: "Leads" }),
    ]),
  ).toEqual([
    { label: "Leads", count: 27 },
    { label: "Purchases", count: 4 },
  ]);
});

test("a scoreless day keeps the highest-spending campaign's label", () => {
  expect(
    collapseResults([
      campaign({ results: 0, resultLabel: "Leads", spend: 10 }),
      campaign({ results: 0, resultLabel: "Purchases", spend: 90 }),
    ]),
  ).toEqual([{ label: "Purchases", count: 0 }]);
});

test("worst account status wins over a healthy majority", () => {
  const h = worstAccountStatus(
    ["act_1", "act_2", "act_3"],
    accountsOf(
      account("act_1"),
      account("act_2"),
      account("act_3", { status: "DISABLED", disableReason: "payment failed" }),
    ),
  );
  expect(h.worst).toBe("DISABLED");
  expect(h.total).toBe(3);
  expect(h.affected).toBe(1);
  expect(h.reason).toBe("payment failed");
});

test("severity orders DISABLED over PENDING over PAUSED", () => {
  const worstOf = (...statuses: ReportAccount["status"][]) =>
    worstAccountStatus(
      statuses.map((_, i) => `act_${i}`),
      accountsOf(...statuses.map((status, i) => account(`act_${i}`, { status }))),
    ).worst;
  expect(worstOf("ACTIVE", "PAUSED")).toBe("PAUSED");
  expect(worstOf("PAUSED", "PENDING")).toBe("PENDING");
  expect(worstOf("PENDING", "DISABLED")).toBe("DISABLED");
});

test("an account with no row is unknown, not assumed healthy", () => {
  // A campaign pointing at an account that was never enumerated is a real gap; reporting it as
  // ACTIVE would hide it.
  expect(worstAccountStatus(["act_missing"], accountsOf()).worst).toBe("PENDING");
});

test("uniform status reports affected === total so the renderer omits the fraction", () => {
  const h = worstAccountStatus(
    ["act_1", "act_2"],
    accountsOf(
      account("act_1", { status: "DISABLED", disableReason: "spend cap reached" }),
      account("act_2", { status: "DISABLED", disableReason: "spend cap reached" }),
    ),
  );
  expect(h.affected).toBe(2);
  expect(h.total).toBe(2);
});

test("unlike currencies are kept apart, never summed", () => {
  const rows = aggregateEngagements(
    [
      campaign({ id: "c1", accountId: "act_usd", spend: 800 }),
      campaign({ id: "c2", accountId: "act_eur", spend: 300 }),
    ],
    accountsOf(account("act_usd"), account("act_eur", { currency: "EUR" })),
  );
  expect(rows[0]!.spend).toEqual([
    { currency: "USD", amount: 800 },
    { currency: "EUR", amount: 300 },
  ]);
});

test("engagements sort by spend, ties broken by name", () => {
  const rows = aggregateEngagements(
    [
      campaign({ id: "c1", clientId: "b", clientName: "Bravo", spend: 0, active: true }),
      campaign({ id: "c2", clientId: "a", clientName: "Alpha", spend: 0, active: true }),
      campaign({ id: "c3", clientId: "z", clientName: "Zulu", spend: 500 }),
    ],
    accountsOf(account("act_1")),
  );
  expect(rows.map((r) => r.name)).toEqual(["Zulu", "Alpha", "Bravo"]);
});
