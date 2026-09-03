import { test, expect } from "bun:test";
import {
  aggregateEngagements,
  collapseResults,
  engagementDelivery,
  includeCampaign,
  isReportable,
  FINISHED_STATUS,
  type EngagementContext,
  type EngagementRow,
  type ReportAccount,
  type ReportCampaign,
} from "./daily-report";

const account = (id: string, over: Partial<ReportAccount> = {}): ReportAccount => ({
  id,
  currency: "USD",
  status: "ACTIVE",
  deliverable: true,
  disableReason: null,
  ...over,
});

/** A banned account: not deliverable, and its status says why. */
const disabled = (id: string, reason = "Ads integrity policy"): ReportAccount =>
  account(id, { status: "DISABLED", deliverable: false, disableReason: reason });

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

/**
 * A context that keeps every engagement reportable, so each test can isolate one rule instead of
 * tripping over the trailing-spend gate while asserting something else.
 */
const passAll = (campaigns: ReportCampaign[]): EngagementContext => ({
  trailingSpend: new Map(
    campaigns.filter((c) => c.clientId).map((c) => [c.clientId as string, 1000]),
  ),
  notionStatus: new Map(),
});

const aggregate = (
  campaigns: ReportCampaign[],
  accounts: Map<string, ReportAccount>,
  context: EngagementContext = passAll(campaigns),
): EngagementRow[] => aggregateEngagements(campaigns, accounts, context);

test("membership is the union of spent-yesterday and currently-active", () => {
  // Spent but since paused: its money is still yesterday's money.
  expect(includeCampaign(campaign({ spend: 50, active: false }))).toBe(true);
  // Live but silent: the line worth seeing, as 0.00.
  expect(includeCampaign(campaign({ spend: 0, active: true }))).toBe(true);
  // Neither — long-finished campaign.
  expect(includeCampaign(campaign({ spend: 0, active: false }))).toBe(false);
});

test("a paused campaign that spent yesterday still reaches the report", () => {
  const rows = aggregate(
    [campaign({ id: "c1", spend: 250, active: false })],
    accountsOf(account("act_1")),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.spend).toEqual([{ currency: "USD", amount: 250 }]);
});

test("unowned campaigns are dropped, not folded into a neighbour", () => {
  const rows = aggregate(
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
  const rows = aggregate(
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

test("one deliverable account makes the whole engagement active", () => {
  // 11 of 12 banned is still a client that can spend, which is all the line has to report.
  const ids = ["act_live", ...Array.from({ length: 11 }, (_, i) => `act_dead${i}`)];
  const h = engagementDelivery(
    ids,
    accountsOf(
      account("act_live"),
      ...Array.from({ length: 11 }, (_, i) => disabled(`act_dead${i}`)),
    ),
  );
  expect(h.status).toBe("ACTIVE");
  expect(h.reason).toBeNull();
});

test("a live account found last still wins", () => {
  // Order must not decide the answer: the dead account is seen first.
  const h = engagementDelivery(
    ["act_dead", "act_live"],
    accountsOf(disabled("act_dead"), account("act_live")),
  );
  expect(h.status).toBe("ACTIVE");
});

test("every account dead reports the worst state and its reason", () => {
  const h = engagementDelivery(
    ["act_1", "act_2"],
    accountsOf(
      disabled("act_1", "Ads integrity policy"),
      account("act_2", { status: "PAUSED", deliverable: false }),
    ),
  );
  expect(h.status).toBe("DISABLED");
  expect(h.reason).toBe("Ads integrity policy");
});

test("an ACTIVE account that cannot deliver is out of budget, not disabled", () => {
  // Meta leaves an exhausted prepaid account reporting ACTIVE. Calling it DISABLED would send
  // someone to appeal a ban that does not exist; the fix is a top-up.
  const h = engagementDelivery(
    ["act_capped"],
    accountsOf(account("act_capped", { status: "ACTIVE", deliverable: false })),
  );
  expect(h.status).toBe("OUT_OF_BUDGET");
});

test("a spent-out account does NOT make an engagement look healthy", () => {
  const h = engagementDelivery(
    ["act_capped", "act_dead"],
    accountsOf(
      account("act_capped", { status: "ACTIVE", deliverable: false }),
      disabled("act_dead"),
    ),
  );
  expect(h.status).not.toBe("ACTIVE");
});

test("severity orders DISABLED over PENDING over PAUSED when nothing delivers", () => {
  const worstOf = (...statuses: ReportAccount["status"][]) =>
    engagementDelivery(
      statuses.map((_, i) => `act_${i}`),
      accountsOf(
        ...statuses.map((status, i) => account(`act_${i}`, { status, deliverable: false })),
      ),
    ).status;
  expect(worstOf("PAUSED", "PENDING")).toBe("PENDING");
  expect(worstOf("PENDING", "DISABLED")).toBe("DISABLED");
});

test("an account with no row is unknown, never deliverable", () => {
  // A campaign pointing at an account that was never enumerated is a real gap; letting an unknown
  // mark the engagement live would hide it.
  expect(engagementDelivery(["act_missing"], accountsOf()).status).toBe("PENDING");
});

test("unlike currencies are kept apart, never summed", () => {
  const rows = aggregate(
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
  const rows = aggregate(
    [
      campaign({ id: "c1", clientId: "b", clientName: "Bravo", spend: 0, active: true }),
      campaign({ id: "c2", clientId: "a", clientName: "Alpha", spend: 0, active: true }),
      campaign({ id: "c3", clientId: "z", clientName: "Zulu", spend: 500 }),
    ],
    accountsOf(account("act_1")),
  );
  expect(rows.map((r) => r.name)).toEqual(["Zulu", "Alpha", "Bravo"]);
});

const row = (over: Partial<EngagementRow> = {}): EngagementRow => ({
  clientId: "cl1",
  name: "Client",
  spend: [{ currency: "USD", amount: 10 }],
  sortSpend: 10,
  results: [{ label: "Purchases", count: 1 }],
  health: { status: "ACTIVE", reason: null },
  campaignCount: 1,
  trailingSpend: 500,
  notionStatus: "Live",
  ...over,
});

test("an engagement is reported only when it is still spending AND not finished", () => {
  expect(isReportable(row())).toBe(true);
  // Dust: "more than $1", so exactly $1 is not enough.
  expect(isReportable(row({ trailingSpend: 1 }))).toBe(false);
  expect(isReportable(row({ trailingSpend: 1.01 }))).toBe(true);
  expect(isReportable(row({ trailingSpend: 0 }))).toBe(false);
});

test("a finished engagement is excluded even while it is still spending", () => {
  // bspin.io: $513 over three days, marked Full Budget Finished. Spend alone would have kept it.
  expect(isReportable(row({ trailingSpend: 513.84, notionStatus: FINISHED_STATUS }))).toBe(false);
});

test("every other Notion status is reportable, including the unhealthy ones", () => {
  // Only "finished" is excluded. A blocked or disabled account is exactly what the team must see.
  for (const s of [
    "Live",
    "Paused",
    "Ad Account Disabled",
    "Ad Account Blocked",
    "All ads rejected",
    "Budget Finished - Top Up",
    "On Boarding",
    "Not started",
    null,
  ])
    expect(isReportable(row({ notionStatus: s })), `status ${s}`).toBe(true);
});

test("yesterday's spend does not decide membership — a dark day keeps a running engagement", () => {
  const campaigns = [
    campaign({ id: "c1", clientId: "cl1", clientName: "Quiet", spend: 0, active: true }),
  ];
  const rows = aggregate(campaigns, accountsOf(account("act_1")), {
    trailingSpend: new Map([["cl1", 400]]),
    notionStatus: new Map([["cl1", "Live"]]),
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.spend).toEqual([{ currency: "USD", amount: 0 }]);
  expect(rows[0]!.trailingSpend).toBe(400);
});

test("the filter drops the row entirely rather than zeroing it", () => {
  const campaigns = [
    campaign({ id: "c1", clientId: "live", clientName: "Live One", spend: 100 }),
    campaign({ id: "c2", clientId: "done", clientName: "Done One", spend: 90 }),
  ];
  const rows = aggregate(campaigns, accountsOf(account("act_1")), {
    trailingSpend: new Map([
      ["live", 300],
      ["done", 300],
    ]),
    notionStatus: new Map([
      ["live", "Live"],
      ["done", FINISHED_STATUS],
    ]),
  });
  expect(rows.map((r) => r.name)).toEqual(["Live One"]);
});
