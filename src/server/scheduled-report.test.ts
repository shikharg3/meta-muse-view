import { expect, test } from "bun:test";
import type { InsightRow } from "@/meta/types";
import type { TimeIncrement } from "@/lib/time-increment";
import {
  annotateModeled,
  composeEntityReport,
  projectColumns,
  renameEntities,
  reportCsv,
  wholeNumbers,
  type EntityMeta,
} from "./scheduled-report";

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
  adSetId: "set_1",
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
    "Account ID",
    "Campaign",
    "Campaign ID",
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
  expect(r.rows.map((row) => [row[0], row[3], row[5], row[6]])).toEqual([
    [D2, "Campaign c2", "Georgia - Static", "s2"],
    [D2, "Campaign c1", "Georgia - Static", "s1"],
  ]);
  expect(r.totals?.slice(0, 8)).toEqual(["Total", "", "", "", "", "", "", 400]);
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
  expect(r.columns.slice(0, 9).map((c) => c.label)).toEqual([
    "Brand",
    "Account",
    "Account ID",
    "Campaign",
    "Campaign ID",
    "Ad set",
    "Ad set ID",
    "Ad",
    "Ad ID",
  ]);
  expect(r.rows).toEqual([
    [
      "Lucky Rebel",
      "Account act_1",
      "act_1",
      "Campaign c_mine",
      "c_mine",
      "Set",
      "set_1",
      "Ad one",
      "a1",
      10,
    ],
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
  // Date, Account, Account ID, Campaign, Campaign ID, Spend.
  expect(r.rows.map((row) => [row[0], row[4], row[5]])).toEqual([
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
  const file = projectColumns(r, [
    "dim:period",
    "dim:campaign",
    "dim:adset",
    "dim:adset_id",
    "spend",
    "impressions",
    "clicks",
    "cpc",
  ]);
  const lines = reportCsv(file).split("\n");
  expect(lines[0]).toBe("\uFEFFDate,Campaign,Ad set,Ad set ID,Spend,Impressions,Clicks,CPC");
  expect(lines[1]).toBe(`${D2},Campaign c1,"US, ""Static""",s1,12.50,1000,20,0.63`);
  expect(lines[2]).toBe("Total,,,,12.50,1000,20,0.63");
});

test("a modeled report says so in its title, file name and note — and adds no column", async () => {
  const r = await composeEntityReport({
    level: "campaign",
    subject: "OneAgency",
    spec: spec(["spend"], "1", D1, ["act_1"]),
    rows: [
      { accountId: "act_1", entityId: "c1", row: insight(D1, 100) },
      { accountId: "act_1", entityId: "c1", row: insight(D2, 97) },
    ],
    meta: new Map([["c1", meta("One", "c1")]]),
    whitelist: null,
    brandOf: null,
  });
  const m = annotateModeled(
    { ...r, title: "OneAgency — by campaign", filename: "oneagency_x" },
    {
      rows: [],
      modeled: [{ date: D2, actualSpend: 0, referenceMedian: 100, referenceDays: [D1] }],
      skipped: [],
    },
  );
  expect(m.title).toBe("OneAgency — by campaign (modeled)");
  expect(m.filename).toBe("oneagency_x_modeled");
  expect(m.note).toStartWith("MODELED ESTIMATE, not actual delivery. 1 interrupted day");
  expect(m.note).toContain(`${D2} (actual spend $0 vs $100 median of 1 active days)`);
  expect(m.columns).toEqual(r.columns);
});

test("the file carries exactly the picked columns, in the picked order", async () => {
  const r = await composeEntityReport({
    level: "adset",
    subject: "OneAgency",
    spec: spec(["spend", "clicks"], "1", D2, ["act_1"]),
    rows: [{ accountId: "act_1", entityId: "s1", row: insight(D2, 10) }],
    meta: new Map([["s1", meta("Broad", "c1")]]),
    whitelist: null,
    brandOf: new Map([["c1", "Slots.lv"]]),
  });
  // Metric first, an identity column after it, Account ID picked, Ad ID not fillable at ad-set level.
  const p = projectColumns(r, ["clicks", "dim:adset", "dim:account_id", "dim:ad_id", "spend"]);
  expect(p.columns.map((c) => c.label)).toEqual(["Clicks", "Ad set", "Account ID", "Spend"]);
  expect(p.rows).toEqual([[20, "Broad", "act_1", 10]]);
  // "Total" goes in the first text column kept, wherever it is.
  expect(p.totals).toEqual([20, "Total", "", 10]);
});

test("a split moves the share of every row under the new campaign, with no IDs, totals unchanged", async () => {
  const input = {
    level: "adset" as const,
    subject: "OneAgency",
    spec: spec(["spend", "clicks", "cpc"], "1", D2, ["act_1"]),
    rows: [
      { accountId: "act_1", entityId: "s1", row: insight(D2, 100) },
      { accountId: "act_1", entityId: "s2", row: insight(D2, 50) },
    ],
    meta: new Map([
      ["s1", meta("Georgia", "c1")],
      ["s2", meta("Ohio", "c1")],
    ]),
    whitelist: null,
    brandOf: null,
  };
  const whole = await composeEntityReport(input);
  const r = projectColumns(
    await composeEntityReport({ ...input, split: { share: 0.2, campaign: "Name#2" } }),
    ["dim:campaign", "dim:campaign_id", "dim:adset", "dim:adset_id", "spend", "clicks", "cpc"],
  );
  expect(r.rows).toEqual([
    ["Campaign c1", "c1", "Georgia", "s1", 80, 16, 5],
    ["Campaign c1", "c1", "Ohio", "s2", 40, 16, 2.5],
    ["Name#2", "", "Georgia", "", 20, 4, 5],
    ["Name#2", "", "Ohio", "", 10, 4, 2.5],
  ]);
  // Every metric of the whole report is unchanged by the split.
  const spendAt = whole.columns.findIndex((c) => c.key === "spend");
  expect(r.totals?.[4]).toBe(whole.totals?.[spendAt]);
  expect(r.totals?.[5]).toBe(40);
});

test("renames match exact names in every row; headers can be renamed per column", async () => {
  const r = await composeEntityReport({
    level: "adset",
    subject: "OneAgency",
    spec: spec(["spend"], "1", D2, ["act_1"]),
    rows: [
      { accountId: "act_1", entityId: "s1", row: insight(D2, 10) },
      { accountId: "act_1", entityId: "s2", row: insight(D2, 5) },
    ],
    meta: new Map([
      ["s1", meta("Name#1", "c1")],
      ["s2", meta("Name#1 copy", "c1")],
    ]),
    whitelist: null,
    brandOf: null,
  });
  const renamed = projectColumns(
    renameEntities(r, {
      campaignNames: { "Campaign c1": "Spring promo" },
      adSetNames: { "Name#1": "Name#2" },
      columnLabels: {},
      split: null,
    }),
    ["dim:campaign", "dim:adset", "spend"],
    { "dim:adset": "Audience", spend: "Amount spent (USD)" },
  );
  expect(renamed.columns.map((c) => c.label)).toEqual([
    "Campaign",
    "Audience",
    "Amount spent (USD)",
  ]);
  expect(renamed.rows).toEqual([
    ["Spring promo", "Name#2", 10],
    ["Spring promo", "Name#1 copy", 5], // exact match only
  ]);
});

test("only spend, CTR, CPC and CPM keep decimals; every other figure is whole", async () => {
  const r = await composeEntityReport({
    level: "campaign",
    subject: "OneAgency",
    spec: spec(["spend", "ctr", "cpc", "cpm", "cost_per_registration", "frequency"], "all_days"),
    rows: [
      {
        accountId: "act_1",
        entityId: "c1",
        row: insight(D2, 10, {
          reach: "300",
          actions: [{ action_type: "complete_registration", value: "3" }],
        }),
      },
    ],
    meta: new Map([["c1", meta("One", "c1")]]),
    whitelist: null,
    brandOf: null,
  });
  const w = wholeNumbers(
    projectColumns(r, ["spend", "ctr", "cpc", "cpm", "cost_per_registration", "frequency"]),
  );
  expect(w.rows[0]).toEqual([10, 2, 0.5, 10, 3, 3]); // 10/3 = 3.33 and 1000/300 = 3.33 → 3
  expect(w.columns.map((c) => c.kind)).toEqual(["money", "pct", "money", "money", "int", "int"]);
});
