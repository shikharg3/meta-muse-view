import { test, expect } from "bun:test";
import { buildReport, normalizeColumns, parseBreakdown, resolveRange } from "./report";
import type { ReportRowSource } from "./report";
import type { InsightRow } from "@/meta/types";

const rowSource =
  (byAccount: Record<string, InsightRow[] | "throw">): ReportRowSource =>
  async (id) => {
    const v = byAccount[id];
    if (v === "throw") throw new Error("boom");
    return v ?? [];
  };

const row = (date: string, campaign: string, o: Partial<InsightRow>): InsightRow => ({
  date_start: date,
  date_stop: date,
  campaign_id: campaign,
  ...o,
});

test("normalizeColumns maps aliases, dedupes, drops unknowns", () => {
  expect(normalizeColumns(["Spend", "cost", "CPC", "ctr", "cpm", "results", "bogus"])).toEqual([
    "spend",
    "cpc",
    "ctr",
    "cpm",
    "results",
  ]);
  // New catalog keys pass straight through; "purchases" is now its own column, not conversions.
  expect(
    normalizeColumns(["registrations", "purchases", "landing_page_views", "cost_per_lead"]),
  ).toEqual(["registrations", "purchases", "landing_page_views", "cost_per_lead"]);
});

test("parseBreakdown recognizes synonyms, legacy composites, and defaults to none", () => {
  expect(parseBreakdown("by day")).toEqual({ dim: "none", byDay: true });
  expect(parseBreakdown("Daily")).toEqual({ dim: "none", byDay: true });
  expect(parseBreakdown("platform")).toEqual({ dim: "platform", byDay: false });
  expect(parseBreakdown(undefined)).toEqual({ dim: "none", byDay: false });
  expect(parseBreakdown("nonsense")).toEqual({ dim: "none", byDay: false });
  // split flag composes with any dimension
  expect(parseBreakdown("region", true)).toEqual({ dim: "region", byDay: true });
});

test("resolveRange handles days, explicit dates, and rejects empty", () => {
  expect(resolveRange({ since: "2026-06-01", until: "2026-06-07" })).toEqual({
    since: "2026-06-01",
    until: "2026-06-07",
  });
  expect(resolveRange({ days: 7 })).not.toBeNull();
  expect(resolveRange({})).toBeNull();
  expect(resolveRange({ days: 0 })).toBeNull();
});

test("buildReport aggregates by day with objective-aware results", async () => {
  // c1 = leads objective (result = lead action); c2 = traffic (result = link_click)
  const src = rowSource({
    act_1: [
      row("2026-06-01", "c1", {
        spend: "100",
        impressions: "1000",
        clicks: "50",
        actions: [{ action_type: "lead", value: "5" }],
      }),
      row("2026-06-02", "c1", {
        spend: "100",
        impressions: "1000",
        clicks: "50",
        actions: [{ action_type: "lead", value: "5" }],
      }),
    ],
    act_2: [
      row("2026-06-01", "c2", {
        spend: "50",
        impressions: "500",
        clicks: "25",
        actions: [{ action_type: "link_click", value: "30" }],
      }),
      row("2026-06-02", "c2", {
        spend: "50",
        impressions: "500",
        clicks: "25",
        actions: [{ action_type: "link_click", value: "20" }],
      }),
    ],
  });
  const p = await buildReport(
    src,
    {
      accountIds: ["act_1", "act_2"],
      since: "2026-06-01",
      until: "2026-06-02",
      columns: ["spend", "results", "cpc", "ctr", "cpm"],
      breakdown: "none",
      byDay: true,
      objectiveByCampaign: { c1: "OUTCOME_LEADS", c2: "OUTCOME_TRAFFIC" },
    },
    "PlayW3",
  );
  expect(p.columns.map((c) => c.label)).toEqual(["Date", "Spend", "Results", "CPC", "CTR", "CPM"]);
  // Day 1: spend 150, results = 5 leads + 30 link clicks = 35, cpc 2, ctr 5, cpm 100
  expect(p.rows[0]).toEqual(["2026-06-01", 150, 35, 2, 5, 100]);
  expect(p.rows[1]).toEqual(["2026-06-02", 150, 25, 2, 5, 100]);
  expect(p.totals).toEqual(["Total", 300, 60, 2, 5, 100]);
  expect(p.rowCount).toBe(2);
  expect(p.filename).toBe("playw3_2026-06-01_2026-06-02_by_day");
});

test("buildReport with breakdown none yields a single total row and no dimension column", async () => {
  const src = rowSource({
    act_1: [row("2026-06-01", "c1", { spend: "200", impressions: "2000", clicks: "100" })],
  });
  const p = await buildReport(
    src,
    {
      accountIds: ["act_1"],
      since: "2026-06-01",
      until: "2026-06-01",
      columns: ["spend", "ctr"],
      breakdown: "none",
      byDay: false,
      objectiveByCampaign: {},
    },
    "Acme",
  );
  expect(p.columns.map((c) => c.label)).toEqual(["Spend", "CTR"]);
  expect(p.rows).toEqual([[200, 5]]);
  expect(p.totals).toBeNull();
});

test("buildReport skips accounts that error and notes it", async () => {
  const src = rowSource({
    act_ok: [row("2026-06-01", "c1", { spend: "10", impressions: "100", clicks: "5" })],
    act_bad: "throw",
  });
  const p = await buildReport(
    src,
    {
      accountIds: ["act_ok", "act_bad"],
      since: "2026-06-01",
      until: "2026-06-01",
      columns: ["spend"],
      breakdown: "none",
      byDay: true,
      objectiveByCampaign: {},
    },
    "Mixed",
  );
  expect(p.rowCount).toBe(1);
  expect(p.note).toContain("1 of 2 accounts");
});

test("buildReport applies a client markup to spend and derived cost metrics", async () => {
  const src = rowSource({
    act_1: [row("2026-06-01", "c1", { spend: "100", impressions: "1000", clicks: "50" })],
  });
  const p = await buildReport(
    src,
    {
      accountIds: ["act_1"],
      since: "2026-06-01",
      until: "2026-06-01",
      columns: ["spend", "cpc"],
      breakdown: "none",
      byDay: false,
      objectiveByCampaign: {},
      markup: 0.1,
    },
    "Acme",
  );
  // spend 100 -> 110 (+10%); cpc = 110 / 50 clicks = 2.2
  expect(p.rows[0][0]).toBeCloseTo(110, 6); // spend +10%
  expect(p.rows[0][1]).toBeCloseTo(2.2, 6); // cpc from marked-up spend
  expect(p.subtitle).toContain("10% markup");
});

test("buildReport exposes de-duplicated funnel event columns and cost-per-event", async () => {
  const src = rowSource({
    act_1: [
      row("2026-06-01", "c1", {
        spend: "300",
        actions: [
          { action_type: "omni_purchase", value: "6" },
          { action_type: "purchase", value: "6" }, // same event, different variant -> must not double-count
          { action_type: "lead", value: "10" },
          { action_type: "omni_complete_registration", value: "4" },
          { action_type: "landing_page_view", value: "50" },
        ],
      }),
    ],
  });
  const p = await buildReport(
    src,
    {
      accountIds: ["act_1"],
      since: "2026-06-01",
      until: "2026-06-01",
      columns: ["purchases", "leads", "registrations", "landing_page_views", "cost_per_purchase"],
      breakdown: "none",
      byDay: false,
      objectiveByCampaign: {},
    },
    "Acme",
  );
  // purchases de-duped to 6 (not 12); leads 10; registrations 4; LPV 50; cost/purchase = 300/6 = 50
  expect(p.rows).toEqual([[6, 10, 4, 50, 50]]);
});

test("parseBreakdown recognizes ad-set and combined day × ad-set phrasings", () => {
  expect(parseBreakdown("ad set")).toEqual({ dim: "adset", byDay: false });
  expect(parseBreakdown("adset")).toEqual({ dim: "adset", byDay: false });
  expect(parseBreakdown("daily by ad set")).toEqual({ dim: "adset", byDay: true });
  expect(parseBreakdown("day and adset")).toEqual({ dim: "adset", byDay: true });
  expect(parseBreakdown("adset_day")).toEqual({ dim: "adset", byDay: true }); // legacy composite
  expect(parseBreakdown("device platform")).toEqual({ dim: "device", byDay: false });
  expect(parseBreakdown("age and gender")).toEqual({ dim: "age_gender", byDay: false });
  expect(parseBreakdown("dma")).toEqual({ dim: "market", byDay: false });
  expect(parseBreakdown("hourly")).toEqual({ dim: "hour", byDay: false });
  expect(parseBreakdown("headline")).toEqual({ dim: "title_asset", byDay: false });
  expect(parseBreakdown("by campaign")).toEqual({ dim: "campaign", byDay: false });
  expect(parseBreakdown("by ad")).toEqual({ dim: "ad", byDay: false });
});

test("buildReport adset_day yields one row per ad set per day, chronological", async () => {
  const src = rowSource({
    act_1: [
      row("2026-07-02", "c1", { __dim: "California", spend: "30" }),
      row("2026-07-01", "c1", { __dim: "California", spend: "10" }),
      row("2026-07-01", "c1", { __dim: "Texas", spend: "20" }),
    ],
  });
  const p = await buildReport(
    src,
    {
      accountIds: ["act_1"],
      since: "2026-07-01",
      until: "2026-07-02",
      columns: ["spend"],
      breakdown: "adset",
      byDay: true,
      objectiveByCampaign: {},
    },
    "X",
  );
  expect(p.columns[0].label).toBe("Date · Ad set");
  expect(p.rows).toEqual([
    ["2026-07-01 · California", 10],
    ["2026-07-01 · Texas", 20],
    ["2026-07-02 · California", 30],
  ]);
  expect(p.totals).toEqual(["Total", 60]);
});

test("buildReport adset merges same-named ad sets and sorts by spend", async () => {
  const src = rowSource({
    act_1: [
      row("2026-07-01", "c1", { __dim: "California", spend: "10" }),
      row("2026-07-01", "c2", { __dim: "California", spend: "15" }),
      row("2026-07-01", "c1", { __dim: "Texas", spend: "20" }),
    ],
  });
  const p = await buildReport(
    src,
    {
      accountIds: ["act_1"],
      since: "2026-07-01",
      until: "2026-07-01",
      columns: ["spend"],
      breakdown: "adset",
      byDay: false,
      objectiveByCampaign: {},
    },
    "X",
  );
  expect(p.rows).toEqual([
    ["California", 25],
    ["Texas", 20],
  ]);
});
