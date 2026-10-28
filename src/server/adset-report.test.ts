import { expect, test } from "bun:test";
import type { InsightRow } from "@/meta/types";
import { adsetReportCsv, composeAdsetReport, type AdsetMeta } from "./adset-report";

const DAY = "2026-10-27";

const insight = (spend: number, extra: Partial<InsightRow> = {}): InsightRow => ({
  date_start: DAY,
  date_stop: DAY,
  spend: String(spend),
  impressions: "1000",
  clicks: "20",
  ...extra,
});

const meta = (name: string, campaignId: string, accountId = "act_1"): AdsetMeta => ({
  name,
  campaignId,
  campaignName: `Campaign ${campaignId}`,
  accountId,
  accountName: `Account ${accountId}`,
});

test("ad sets sharing a name stay separate rows, keyed by id and ordered by spend", async () => {
  // OneAgency's real shape: "Georgia - Static" repeats across campaigns and accounts. The Report
  // Builder's name-keyed breakdown would fold these into one row.
  const r = await composeAdsetReport({
    clientName: "OneAgency",
    date: DAY,
    accountIds: ["act_1", "act_2"],
    rows: [
      { accountId: "act_1", adSetId: "s1", row: insight(100) },
      { accountId: "act_2", adSetId: "s2", row: insight(300) },
    ],
    meta: new Map([
      ["s1", meta("Georgia - Static", "c1", "act_1")],
      ["s2", meta("Georgia - Static", "c2", "act_2")],
    ]),
    owned: null,
  });

  expect(r.doc.columns.map((c) => c.label)).toEqual([
    "Date",
    "Account",
    "Campaign",
    "Ad set",
    "Ad set ID",
    "Spend",
    "Impressions",
    "Clicks",
    "CPC",
    "CPM",
    "CTR",
    "Registrations",
    "Purchases",
  ]);
  expect(r.doc.rows.map((row) => row.slice(0, 5))).toEqual([
    [DAY, "Account act_2", "Campaign c2", "Georgia - Static", "s2"],
    [DAY, "Account act_1", "Campaign c1", "Georgia - Static", "s1"],
  ]);
  expect(r.totals.spend).toBe(400);
  expect(r.doc.totals?.[0]).toBe("Total");
});

test("costs and rates derive from the row's sums; conversions count once per event", async () => {
  const r = await composeAdsetReport({
    clientName: "OneAgency",
    date: DAY,
    accountIds: ["act_1"],
    rows: [
      {
        accountId: "act_1",
        adSetId: "s1",
        row: insight(50, {
          impressions: "2000",
          clicks: "40",
          // Meta reports one registration under several action types, and one purchase likewise.
          actions: [
            { action_type: "complete_registration", value: "7" },
            { action_type: "omni_complete_registration", value: "7" },
            { action_type: "offsite_conversion.fb_pixel_complete_registration", value: "7" },
            { action_type: "omni_purchase", value: "2" },
            { action_type: "purchase", value: "2" },
          ],
        }),
      },
    ],
    meta: new Map([["s1", meta("Broad", "c1")]]),
    owned: null,
  });

  const [row] = r.doc.rows;
  const at = (label: string) => row[r.doc.columns.findIndex((c) => c.label === label)];
  expect(at("Spend")).toBe(50);
  expect(at("CPC")).toBeCloseTo(1.25, 6); // 50 / 40
  expect(at("CPM")).toBeCloseTo(25, 6); // 50 / 2000 * 1000
  expect(at("CTR")).toBeCloseTo(2, 6); // 40 / 2000, as a percentage
  expect(at("Registrations")).toBe(7);
  expect(at("Purchases")).toBe(2);
});

test("on shared accounts only the client's own campaigns are reported", async () => {
  const r = await composeAdsetReport({
    clientName: "OneAgency",
    date: DAY,
    accountIds: ["act_1"],
    rows: [
      { accountId: "act_1", adSetId: "mine", row: insight(10) },
      { accountId: "act_1", adSetId: "theirs", row: insight(99) },
      // No structure row: its campaign is unknown, so a scope cannot vouch for it.
      { accountId: "act_1", adSetId: "orphan", row: insight(5) },
    ],
    meta: new Map([
      ["mine", meta("A", "c_mine")],
      ["theirs", meta("B", "c_other_client")],
    ]),
    owned: ["c_mine"],
  });

  expect(r.doc.rows.map((row) => row[4])).toEqual(["mine"]);
  expect(r.totals.spend).toBe(10);
});

test("a day with no delivery yields no rows and no totals line", async () => {
  const r = await composeAdsetReport({
    clientName: "OneAgency",
    date: DAY,
    accountIds: ["act_1"],
    rows: [
      {
        accountId: "act_1",
        adSetId: "s1",
        row: insight(0, { impressions: "0", clicks: "0" }),
      },
    ],
    meta: new Map([["s1", meta("Paused", "c1")]]),
    owned: null,
  });
  expect(r.doc.rows).toEqual([]);
  expect(r.doc.totals).toBeNull();
});

test("the CSV quotes names with commas and starts with a UTF-8 BOM for Excel", async () => {
  const r = await composeAdsetReport({
    clientName: "OneAgency",
    date: DAY,
    accountIds: ["act_1"],
    rows: [{ accountId: "act_1", adSetId: "s1", row: insight(12.5) }],
    meta: new Map([["s1", meta('US, "Static"', "c1")]]),
    owned: null,
  });
  const lines = adsetReportCsv(r).split("\n");
  expect(lines[0]).toStartWith("\uFEFFDate,Account,Campaign,Ad set,Ad set ID,Spend");
  expect(lines[1]).toBe(
    `${DAY},Account act_1,Campaign c1,"US, ""Static""",s1,12.50,1000,20,0.63,12.50,2.00,0,0`,
  );
  expect(lines[2]).toStartWith("Total,,,,,12.50");
});
