import { expect, test } from "bun:test";
import type { InsightRow } from "@/meta/types";
import type { TimeIncrement } from "@/lib/time-increment";
import { composeEntityReport, reportCsv, type EntityMeta } from "./scheduled-report";

const D1 = "2026-10-26";
const D2 = "2026-10-27";

const insight = (date: string, spend: number, extra: Partial<InsightRow> = {}): InsightRow => ({
  date_start: date,
  date_stop: date,
  spend: String(spend),
  impressions: "1000",
  clicks: "20",
  ...extra,
});

const meta = (name: string, campaignId: string, accountId = "act_1"): EntityMeta => ({
  name,
  accountId,
  accountName: `Account ${accountId}`,
  campaignId,
  campaignName: `Campaign ${campaignId}`,
  adSetName: "Set",
});

const spec = (
  columns: string[],
  timeIncrement: TimeIncrement = "1",
  since = D2,
  accountIds = ["act_1", "act_2"],
) => ({
  accountIds,
  since,
  until: D2,
  columns,
  timeIncrement,
  objectiveByCampaign: {},
});

test("ad sets sharing a name stay separate rows, keyed by id, with their context", async () => {
  // OneAgency repeats "Georgia - Static" across 31 ad sets; a name key would fold them together.
  const r = await composeEntityReport({
    level: "adset",
    subject: "OneAgency",
    spec: spec([
      "spend",
      "impressions",
      "clicks",
      "cpc",
      "cpm",
      "ctr",
      "registrations",
      "purchases",
    ]),
    rows: [
      { accountId: "act_1", entityId: "s1", row: insight(D2, 100) },
      { accountId: "act_2", entityId: "s2", row: insight(D2, 300) },
    ],
    meta: new Map([
      ["s1", meta("Georgia - Static", "c1", "act_1")],
      ["s2", meta("Georgia - Static", "c2", "act_2")],
    ]),
    whitelist: null,
    brandOf: null,
  });
  expect(r.columns.map((c) => c.label)).toEqual([
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
  expect(r.rows.map((row) => row.slice(0, 5))).toEqual([
    [D2, "Account act_2", "Campaign c2", "Georgia - Static", "s2"],
    [D2, "Account act_1", "Campaign c1", "Georgia - Static", "s1"],
  ]);
  expect(r.totals?.slice(0, 6)).toEqual(["Total", "", "", "", "", 400]);
});

test("costs and rates derive from the row's sums; conversions count once per event", async () => {
  const r = await composeEntityReport({
    level: "adset",
    subject: "OneAgency",
    spec: spec(["spend", "cpc", "cpm", "ctr", "registrations", "purchases"]),
    rows: [
      {
        accountId: "act_1",
        entityId: "s1",
        row: insight(D2, 50, {
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
    whitelist: null,
    brandOf: null,
  });
  const at = (label: string) => r.rows[0][r.columns.findIndex((c) => c.label === label)];
  expect(at("CPC")).toBeCloseTo(1.25, 6); // 50 / 40
  expect(at("CPM")).toBeCloseTo(25, 6); // 50 / 2000 * 1000
  expect(at("CTR")).toBeCloseTo(2, 6); // 40 / 2000, as a percentage
  expect(at("Registrations")).toBe(7);
  expect(at("Purchases")).toBe(2);
});

test("the whitelist drops other campaigns and unplaced rows; Brand comes from the campaign", async () => {
  const r = await composeEntityReport({
    level: "ad",
    subject: "OneAgency",
    spec: spec(["spend"], "all_days"),
    rows: [
      { accountId: "act_1", entityId: "a1", row: insight(D2, 10) },
      { accountId: "act_1", entityId: "a2", row: insight(D2, 99) },
      { accountId: "act_1", entityId: "orphan", row: insight(D2, 5) },
    ],
    meta: new Map([
      ["a1", meta("Ad one", "c_mine")],
      ["a2", meta("Ad two", "c_other")],
    ]),
    whitelist: new Set(["c_mine"]),
    brandOf: new Map([["c_mine", "Lucky Rebel"]]),
  });
  expect(r.columns.slice(0, 6).map((c) => c.label)).toEqual([
    "Brand",
    "Account",
    "Campaign",
    "Ad set",
    "Ad",
    "Ad ID",
  ]);
  expect(r.rows).toEqual([
    ["Lucky Rebel", "Account act_1", "Campaign c_mine", "Set", "Ad one", "a1", 10],
  ]);
});

test("daily rows run in date order, biggest spend first within a day", async () => {
  const r = await composeEntityReport({
    level: "campaign",
    subject: "OneAgency",
    spec: spec(["spend"], "1", D1, ["act_1"]),
    rows: [
      { accountId: "act_1", entityId: "c1", row: insight(D2, 5) },
      { accountId: "act_1", entityId: "c2", row: insight(D2, 50) },
      { accountId: "act_1", entityId: "c1", row: insight(D1, 7) },
    ],
    meta: new Map([
      ["c1", meta("One", "c1")],
      ["c2", meta("Two", "c2")],
    ]),
    whitelist: null,
    brandOf: null,
  });
  expect(r.rows.map((row) => [row[0], row[3], row[4]])).toEqual([
    [D1, "c1", 7],
    [D2, "c2", 50],
    [D2, "c1", 5],
  ]);
});

test("the CSV quotes names with commas and starts with a UTF-8 BOM for Excel", async () => {
  const r = await composeEntityReport({
    level: "adset",
    subject: "OneAgency",
    spec: spec(["spend", "impressions", "clicks", "cpc"], "1", D2, ["act_1"]),
    rows: [{ accountId: "act_1", entityId: "s1", row: insight(D2, 12.5) }],
    meta: new Map([["s1", meta('US, "Static"', "c1")]]),
    whitelist: null,
    brandOf: null,
  });
  const lines = reportCsv(r).split("\n");
  expect(lines[0]).toBe(
    "\uFEFFDate,Account,Campaign,Ad set,Ad set ID,Spend,Impressions,Clicks,CPC",
  );
  expect(lines[1]).toBe(`${D2},Account act_1,Campaign c1,"US, ""Static""",s1,12.50,1000,20,0.63`);
  expect(lines[2]).toBe("Total,,,,,12.50,1000,20,0.63");
});
