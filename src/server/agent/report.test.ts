import { test, expect } from "bun:test";
import { buildReport, normalizeColumns, normalizeBreakdown, resolveRange } from "./report";
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
});

test("normalizeBreakdown recognizes synonyms and defaults to none", () => {
  expect(normalizeBreakdown("by day")).toBe("day");
  expect(normalizeBreakdown("Daily")).toBe("day");
  expect(normalizeBreakdown("platform")).toBe("platform");
  expect(normalizeBreakdown(undefined)).toBe("none");
  expect(normalizeBreakdown("nonsense")).toBe("none");
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
      breakdown: "day",
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
      breakdown: "day",
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
