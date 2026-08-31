import { test, expect } from "bun:test";
import {
  buildReport,
  insightRowFrom,
  normalizeColumns,
  parseBreakdown,
  resolveRange,
} from "./report";
import type { ReportRowSource } from "./report";
import type { InsightRow } from "@/meta/types";
import type { TimeIncrement } from "@/lib/time-increment";
import { REPORT_METRICS } from "@/lib/report-catalog";

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
  expect(parseBreakdown("by day")).toEqual({ dim: "none", timeIncrement: "1" });
  expect(parseBreakdown("Daily")).toEqual({ dim: "none", timeIncrement: "1" });
  expect(parseBreakdown("platform")).toEqual({ dim: "platform", timeIncrement: "all_days" });
  expect(parseBreakdown(undefined)).toEqual({ dim: "none", timeIncrement: "all_days" });
  expect(parseBreakdown("nonsense")).toEqual({ dim: "none", timeIncrement: "all_days" });
  // split flag composes with any dimension
  expect(parseBreakdown("region", true)).toEqual({ dim: "region", timeIncrement: "1" });
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
      timeIncrement: "1",
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
  expect(p.filename).toBe("playw3_2026-06-01_2026-06-02_daily");
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
      timeIncrement: "all_days",
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
      timeIncrement: "1",
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
      timeIncrement: "all_days",
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
      timeIncrement: "all_days",
      objectiveByCampaign: {},
    },
    "Acme",
  );
  // purchases de-duped to 6 (not 12); leads 10; registrations 4; LPV 50; cost/purchase = 300/6 = 50
  expect(p.rows).toEqual([[6, 10, 4, 50, 50]]);
});

test("parseBreakdown recognizes ad-set and combined day × ad-set phrasings", () => {
  expect(parseBreakdown("ad set")).toEqual({ dim: "adset", timeIncrement: "all_days" });
  expect(parseBreakdown("adset")).toEqual({ dim: "adset", timeIncrement: "all_days" });
  expect(parseBreakdown("daily by ad set")).toEqual({ dim: "adset", timeIncrement: "1" });
  expect(parseBreakdown("day and adset")).toEqual({ dim: "adset", timeIncrement: "1" });
  expect(parseBreakdown("adset_day")).toEqual({ dim: "adset", timeIncrement: "1" }); // legacy composite
  expect(parseBreakdown("device platform")).toEqual({ dim: "device", timeIncrement: "all_days" });
  expect(parseBreakdown("age and gender")).toEqual({
    dim: "age_gender",
    timeIncrement: "all_days",
  });
  expect(parseBreakdown("dma")).toEqual({ dim: "market", timeIncrement: "all_days" });
  expect(parseBreakdown("hourly")).toEqual({ dim: "hour", timeIncrement: "all_days" });
  expect(parseBreakdown("headline")).toEqual({ dim: "title_asset", timeIncrement: "all_days" });
  expect(parseBreakdown("by campaign")).toEqual({ dim: "campaign", timeIncrement: "all_days" });
  expect(parseBreakdown("by ad")).toEqual({ dim: "ad", timeIncrement: "all_days" });
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
      timeIncrement: "1",
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
      timeIncrement: "all_days",
      objectiveByCampaign: {},
    },
    "X",
  );
  expect(p.rows).toEqual([
    ["California", 25],
    ["Texas", 20],
  ]);
});

// ---------------------------------------------------------------- characterization
// Captured from the live engine before the descriptor refactor. These are the contract: the refactor
// must move no number. Two days of one campaign, carrying three purchase synonyms so that family
// de-duplication is exercised rather than assumed.
const goldenRows: InsightRow[] = [
  row("2026-01-01", "c1", {
    spend: "100",
    impressions: "10000",
    reach: "8000",
    clicks: "500",
    inline_link_clicks: "400",
    actions: [
      { action_type: "omni_purchase", value: "10" },
      { action_type: "purchase", value: "10" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "10" },
      { action_type: "omni_complete_registration", value: "25" },
      { action_type: "lead", value: "5" },
      { action_type: "omni_initiated_checkout", value: "15" },
      { action_type: "omni_landing_page_view", value: "300" },
    ],
    action_values: [
      { action_type: "omni_purchase", value: "2500" },
      { action_type: "purchase", value: "2500" },
    ],
  }),
  row("2026-01-02", "c1", {
    spend: "50",
    impressions: "4000",
    reach: "3500",
    clicks: "200",
    inline_link_clicks: "150",
    actions: [
      { action_type: "omni_purchase", value: "4" },
      { action_type: "omni_complete_registration", value: "10" },
      { action_type: "lead", value: "2" },
      { action_type: "omni_landing_page_view", value: "120" },
    ],
    action_values: [{ action_type: "omni_purchase", value: "900" }],
  }),
];

// The characterization expectations below were captured against the old 22-column picker set, so the
// spec pins those keys in that order instead of tracking whatever the catalog projection now offers.
const LEGACY_22 = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "link_clicks",
  "ctr",
  "cpc",
  "cpm",
  "frequency",
  "results",
  "cost_per_result",
  "conversions",
  "conversion_value",
  "roas",
  "registrations",
  "leads",
  "initiate_checkout",
  "purchases",
  "landing_page_views",
  "cost_per_registration",
  "cost_per_lead",
  "cost_per_purchase",
];

const goldenSpec = (o: { timeIncrement: TimeIncrement; markup?: number }) => ({
  accountIds: ["act_1"],
  since: "2026-01-01",
  until: "2026-01-02",
  columns: LEGACY_22,
  breakdown: "none" as const,
  timeIncrement: o.timeIncrement,
  objectiveByCampaign: { c1: "OUTCOME_SALES" },
  markup: o.markup,
});

test("characterization: every legacy column, one total row", async () => {
  const p = await buildReport(
    rowSource({ act_1: goldenRows }),
    goldenSpec({ timeIncrement: "all_days" }),
    "Acme",
  );
  expect(p.columns.map((c) => c.key)).toEqual([
    "spend",
    "impressions",
    "reach",
    "clicks",
    "link_clicks",
    "ctr",
    "cpc",
    "cpm",
    "frequency",
    "results",
    "cost_per_result",
    "conversions",
    "conversion_value",
    "roas",
    "registrations",
    "leads",
    "initiate_checkout",
    "purchases",
    "landing_page_views",
    "cost_per_registration",
    "cost_per_lead",
    "cost_per_purchase",
  ]);
  const r = p.rows[0];
  // Reach is null, not 11,500. The two golden rows are two of Meta's own rows, and Meta counts
  // distinct people per row — 11,500 was the sum of two days' reach, which double-counts anyone
  // present on both. `all_days` therefore withholds it; see the dedicated test below.
  expect(r.slice(0, 5)).toEqual([150, 14000, null, 700, 550]);
  expect(r[5]).toBe(5); // ctr
  expect(r[6] as number).toBeCloseTo(0.214285, 5); // cpc
  expect(r[7] as number).toBeCloseTo(10.714285, 5); // cpm
  expect(r[8]).toBeNull(); // frequency — impressions/reach, so it inherits reach's withholding
  expect(r[9]).toBe(14); // results — OUTCOME_SALES counts purchases
  expect(r[11]).toBe(14); // conversions — omni_purchase
  expect(r[12]).toBe(3400); // conversion_value
  expect(r[13] as number).toBeCloseTo(22.666666, 5); // roas
  // Three purchase synonyms must not treble the count.
  expect(r.slice(14, 19)).toEqual([35, 7, 15, 14, 420]);
  expect(r[19] as number).toBeCloseTo(4.285714, 5); // cost_per_registration
  expect(r[20] as number).toBeCloseTo(21.428571, 5); // cost_per_lead
  expect(r[21] as number).toBeCloseTo(10.714285, 5); // cost_per_purchase
  expect(p.totals).toBeNull();
});

test("characterization: markup inflates spend and derived costs, never delivery", async () => {
  const p = await buildReport(
    rowSource({ act_1: goldenRows }),
    goldenSpec({ timeIncrement: "1", markup: 0.1 }),
    "Acme",
  );
  const d1 = p.rows[0]; // index 0 is the _dim cell, so every metric shifts by one
  expect(d1[1] as number).toBeCloseTo(110, 6); // spend +10%
  expect(d1[2]).toBe(10000); // impressions untouched
  expect(d1[7] as number).toBeCloseTo(0.22, 6); // cpc +10%
  expect(d1[14] as number).toBeCloseTo(22.727272, 5); // roas falls
  expect(d1[22] as number).toBeCloseTo(11, 6); // cost_per_purchase +10%
});

test("totals include event and cost-per columns, not zeros", async () => {
  const p = await buildReport(
    rowSource({ act_1: goldenRows }),
    goldenSpec({ timeIncrement: "1" }),
    "Acme",
  );
  const t = p.totals!;
  expect(t[0]).toBe("Total");
  expect(t[1]).toBe(150); // spend still right
  expect(t.slice(15, 20)).toEqual([35, 7, 15, 14, 420]); // registrations..landing_page_views
  expect(t[20] as number).toBeCloseTo(4.285714, 5); // cost_per_registration
  expect(t[21] as number).toBeCloseTo(21.428571, 5); // cost_per_lead
  expect(t[22] as number).toBeCloseTo(10.714285, 5); // cost_per_purchase
});

test("every catalog metric renders through the engine", async () => {
  const p = await buildReport(
    rowSource({ act_1: goldenRows }),
    { ...goldenSpec({ timeIncrement: "1" }), columns: REPORT_METRICS.map((m) => m.key) },
    "Acme",
  );
  expect(p.columns.length).toBe(REPORT_METRICS.length + 1); // + the Date column
  // Daily granularity on a single account means every bucket is exactly one of Meta's rows, so
  // nothing is withheld and every metric — de-duplicated ones included — must resolve to a number.
  for (const [i, cell] of p.rows[0].entries()) {
    if (p.columns[i].key === "_dim") continue;
    expect(Number.isFinite(cell as number), `${p.columns[i].key} produced ${cell}`).toBe(true);
  }
});

test("de-duplicated metrics are withheld once a row covers more than one Meta row", async () => {
  const columns = ["spend", "reach", "frequency", "cpp", "unique_clicks"];
  // Same rows, same range: only the granularity differs.
  const wide = await buildReport(
    rowSource({ act_1: goldenRows }),
    { ...goldenSpec({ timeIncrement: "all_days" }), columns },
    "Acme",
  );
  const daily = await buildReport(
    rowSource({ act_1: goldenRows }),
    { ...goldenSpec({ timeIncrement: "1" }), columns },
    "Acme",
  );

  // Spend still sums; the four de-duplicated metrics are withheld rather than double-counted.
  expect(wide.rows[0]).toEqual([150, null, null, null, null]);
  expect(wide.note).toContain("withheld");
  expect(wide.note).toContain("Reach");

  // One row per day = one Meta row per bucket, so the same metrics report exactly. Daily granularity
  // adds the Date column, so every metric index shifts by one.
  expect(daily.rows).toHaveLength(2);
  expect(daily.rows[0][0]).toBe("2026-01-01");
  expect(daily.rows[0][2]).toBe(8000); // reach, Meta's own figure for that day
  expect(daily.rows[0][3]).toBe(1.25); // frequency = 10000 impressions / 8000 reach
  // The note still fires, because the totals row below spans both days even though no data row does.
  expect(daily.note).toContain("withheld");
  // The totals row spans both days, so it withholds them again — a 2-day reach is not 8000 + 3500.
  expect(daily.totals?.[0]).toBe("Total");
  expect(daily.totals?.[1]).toBe(150); // spend still sums
  expect(daily.totals?.[2]).toBeNull(); // reach does not
});

test("an unknown column key is dropped rather than rendered", async () => {
  const p = await buildReport(
    rowSource({ act_1: goldenRows }),
    {
      ...goldenSpec({ timeIncrement: "all_days" }),
      columns: ["spend", "not_a_real_metric", "purchases"],
    },
    "Acme",
  );
  expect(p.columns.map((c) => c.key)).toEqual(["spend", "purchases"]);
  expect(p.rows[0]).toEqual([150, 14]);
});

test("a metric with no promoted column reads through to the report", async () => {
  // `unique_clicks` is not a column on insights_daily; it exists only inside the synced raw blob.
  const p = await buildReport(
    rowSource({ act_1: [row("2026-01-01", "c1", { spend: "10", unique_clicks: "7" })] }),
    { ...goldenSpec({ timeIncrement: "all_days" }), columns: ["spend", "unique_clicks"] },
    "Acme",
  );
  expect(p.rows[0]).toEqual([10, 7]);
});

test("promoted columns win over the raw blob on a key collision", () => {
  // The sync normalises spend into its own column; raw keeps Meta's original string. If raw won,
  // a partial sync pass could silently reinstate a stale or differently-rounded number.
  const merged = insightRowFrom({
    raw: { spend: "999", unique_clicks: "7", impressions: "1" },
    date: "2026-01-01",
    spend: 100,
    impressions: 10000,
    reach: 8000,
    clicks: 500,
    inlineLinkClicks: 400,
    actions: null,
    actionValues: null,
  } as unknown as Parameters<typeof insightRowFrom>[0]);
  expect(merged.spend).toBe("100");
  expect(merged.impressions).toBe("10000");
  // …while a field with no promoted column survives from raw.
  expect((merged as Record<string, unknown>).unique_clicks).toBe("7");
});

test("resolveRange accepts a preset, with explicit dates taking precedence", () => {
  const preset = resolveRange({ preset: "yesterday" });
  const today = new Date().toISOString().slice(0, 10);
  expect(preset).not.toBeNull();
  expect(preset!.since).toBe(preset!.until);
  expect(preset!.until < today).toBe(true);

  // Explicit dates win over a preset, and an unknown preset falls through to `days`.
  expect(resolveRange({ preset: "last_month", since: "2026-01-01", until: "2026-01-31" })).toEqual({
    since: "2026-01-01",
    until: "2026-01-31",
  });
  expect(resolveRange({ preset: "nonsense", days: 7 })).not.toBeNull();
  expect(resolveRange({ preset: "nonsense" })).toBeNull();
});
