import { test, expect } from "bun:test";
import {
  planEngagements,
  claimOn,
  clipClaim,
  impliedUntil,
  type EngagementRow,
} from "./engagements";

// Shaped on the live board: betonline.ag books one brand monthly on reused accounts, and ran a
// separate one-off engagement on accounts of its own.
const rows: EngagementRow[] = [
  {
    pageId: "may",
    title: "betonline.ag (May 2026)",
    status: "Full Budget Finished",
    accountIds: ["act_old"],
    startDate: "2026-05-04",
  },
  {
    pageId: "jul",
    title: "betonline.ag (July/August 2026)",
    status: "Full Budget Finished",
    accountIds: ["act_shared"],
    startDate: "2026-07-14",
  },
  {
    pageId: "aug",
    title: "betonline.ag (August/September)",
    status: "Full Budget Finished",
    accountIds: ["act_shared"],
    startDate: "2026-08-27",
  },
  {
    pageId: "sep",
    title: "betonline.ag (September/October)",
    status: "Live",
    accountIds: ["act_14"],
    startDate: "2026-09-24",
  },
  {
    pageId: "html5",
    title: "BOL HTML5 Casino Ad Campaign",
    status: "Full Budget Finished",
    accountIds: ["act_9"],
    startDate: "2026-09-25",
  },
];

const days = ["2026-07-01", "2026-07-14", "2026-08-26", "2026-08-27", "2026-10-08"];

test("a reused account's days go to the engagement that had started, and only to it", () => {
  const claims = planEngagements(rows, [
    { id: "c1", name: "BOL - Website - Betting", accountId: "act_shared" },
  ]);
  // Each day lands in exactly one claim: summing a campaign's claims never double-counts it.
  for (const day of days) {
    expect(claims.filter((c) => claimOn([c], day))).toHaveLength(1);
  }
  expect(claimOn(claims, "2026-07-01")).toMatchObject({ pageId: null, reason: "before_start" });
  expect(claimOn(claims, "2026-07-14")?.pageId).toBe("jul");
  expect(claimOn(claims, "2026-08-26")?.pageId).toBe("jul");
  expect(claimOn(claims, "2026-08-27")?.pageId).toBe("aug");
  // No later engagement lists the account, so the last one runs on: a planned end cuts nothing off.
  expect(claimOn(claims, "2026-10-08")?.pageId).toBe("aug");
});

test("the account outranks the name: a BOL-named campaign on the live row's account is that row's", () => {
  // "BOL" reads as the HTML5 engagement by name, but only the September/October row lists act_14.
  const [c] = planEngagements(rows, [
    { id: "c2", name: "BOL - Website - Betting", accountId: "act_14" },
  ]).filter((x) => x.pageId);
  expect(c).toMatchObject({ pageId: "sep", placedBy: "account", since: "2026-09-24", until: null });
});

test("a campaign whose name carries no brand is placed by its account alone", () => {
  const claims = planEngagements(rows, [
    { id: "c3", name: "DIGITAL CONVERSION CAMPAIGN", accountId: "act_9" },
  ]);
  expect(claimOn(claims, "2026-10-01")).toMatchObject({ pageId: "html5", placedBy: "account" });
});

test("several brands on one account are split by name, and a name naming neither is nobody's", () => {
  const agency: EngagementRow[] = [
    { pageId: "slv", title: "Slots.lv", status: "Live", accountIds: ["act_a"], startDate: null },
    { pageId: "lr", title: "Lucky Rebel", status: "Live", accountIds: ["act_a"], startDate: null },
  ];
  const claims = planEngagements(agency, [
    { id: "x", name: "SLV Prospecting TOF - Broad", accountId: "act_a" },
    { id: "y", name: "LR Prospecting TOF - Interests", accountId: "act_a" },
    { id: "z", name: "Retargeting - Broad", accountId: "act_a" },
  ]);
  expect(claims.find((c) => c.campaignId === "x")).toMatchObject({
    pageId: "slv",
    placedBy: "name",
  });
  expect(claims.find((c) => c.campaignId === "y")).toMatchObject({
    pageId: "lr",
    placedBy: "name",
  });
  expect(claims.find((c) => c.campaignId === "z")).toMatchObject({
    pageId: null,
    reason: "no_brand",
  });
});

test("a hand placement takes every day, whatever the account says", () => {
  const claims = planEngagements(
    rows,
    [{ id: "c4", name: "BOL - Website - Betting", accountId: "act_shared" }],
    new Map([["c4", "html5"]]),
  );
  expect(claims).toEqual([
    { campaignId: "c4", pageId: "html5", since: null, until: null, placedBy: "hand", reason: null },
  ]);
});

test("a hand placement naming a row the client no longer has is ignored", () => {
  const claims = planEngagements(
    rows,
    [{ id: "c5", name: "x", accountId: "act_14" }],
    new Map([["c5", "gone"]]),
  );
  expect(claimOn(claims, "2026-10-01")?.pageId).toBe("sep");
});

test("undated rows sharing an account fall to the live one", () => {
  const undated: EngagementRow[] = [
    {
      pageId: "old",
      title: "acme.com",
      status: "Full Budget Finished",
      accountIds: ["act_u"],
      startDate: null,
    },
    {
      pageId: "now",
      title: "acme.com (Renewal)",
      status: "Live",
      accountIds: ["act_u"],
      startDate: null,
    },
  ];
  expect(planEngagements(undated, [{ id: "c", name: "Acme", accountId: "act_u" }])).toEqual([
    { campaignId: "c", pageId: "now", since: null, until: null, placedBy: "account", reason: null },
  ]);
});

test("clipClaim narrows to the range and rejects a claim outside it", () => {
  const c = {
    campaignId: "c",
    pageId: "aug",
    since: "2026-08-27",
    until: "2026-09-23",
    placedBy: "account" as const,
    reason: null,
  };
  expect(clipClaim(c, "2026-09-01", "2026-10-08")).toEqual({
    since: "2026-09-01",
    until: "2026-09-23",
  });
  expect(clipClaim(c, "2026-10-01", "2026-10-08")).toBeNull();
});

test("an engagement's implied end is the day before the next one on a shared account starts", () => {
  expect(impliedUntil(rows[1], rows)).toBe("2026-08-26");
  // The live row has no successor; the May row shares no account with any later row.
  expect(impliedUntil(rows[3], rows)).toBeNull();
  expect(impliedUntil(rows[0], rows)).toBeNull();
});
