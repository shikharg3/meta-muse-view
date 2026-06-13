import { test, expect } from "bun:test";
import { buildReport, normalizeColumns, normalizeBreakdown, resolveRange } from "./report";
import type { InsightRow, InsightsClient } from "@/meta/types";

const fakeClient = (byAccount: Record<string, InsightRow[] | "throw">): InsightsClient => ({
  getAccounts: async () => [],
  getChildren: async () => [],
  debugToken: async () => ({ is_valid: true, scopes: [] }),
  getInsights: async (id: string) => {
    const v = byAccount[id];
    if (v === "throw") throw new Error("no access");
    return v ?? [];
  },
});

const row = (date: string, o: Partial<InsightRow>): InsightRow => ({
  date_start: date,
  date_stop: date,
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
  const r = resolveRange({ days: 7 });
  expect(r).not.toBeNull();
  expect(resolveRange({})).toBeNull();
  expect(resolveRange({ days: 0 })).toBeNull();
});

test("buildReport aggregates by day across accounts with correct derived metrics", async () => {
  const client = fakeClient({
    act_1: [
      row("2026-06-01", {
        spend: "100",
        impressions: "1000",
        clicks: "50",
        actions: [{ action_type: "lead", value: "5" }],
      }),
      row("2026-06-02", {
        spend: "100",
        impressions: "1000",
        clicks: "50",
        actions: [{ action_type: "lead", value: "5" }],
      }),
    ],
    act_2: [
      row("2026-06-01", {
        spend: "50",
        impressions: "500",
        clicks: "25",
        actions: [{ action_type: "complete_registration", value: "3" }],
      }),
      row("2026-06-02", {
        spend: "50",
        impressions: "500",
        clicks: "25",
        actions: [{ action_type: "omni_purchase", value: "2" }],
      }),
    ],
  });
  const p = await buildReport(
    client,
    {
      accountIds: ["act_1", "act_2"],
      level: "account",
      since: "2026-06-01",
      until: "2026-06-02",
      columns: ["spend", "results", "cpc", "ctr", "cpm"],
      breakdown: "day",
    },
    "PlayW3",
  );
  expect(p.columns.map((c) => c.label)).toEqual(["Date", "Spend", "Results", "CPC", "CTR", "CPM"]);
  // Day 1: spend 150, results 5+3=8, cpc 150/75=2, ctr 75/1500*100=5, cpm 150/1500*1000=100
  expect(p.rows[0]).toEqual(["2026-06-01", 150, 8, 2, 5, 100]);
  expect(p.rows[1]).toEqual(["2026-06-02", 150, 7, 2, 5, 100]);
  // Totals across both days
  expect(p.totals).toEqual(["Total", 300, 15, 2, 5, 100]);
  expect(p.rowCount).toBe(2);
  expect(p.filename).toBe("playw3_2026-06-01_2026-06-02_by_day");
});

test("buildReport with breakdown none yields a single total row and no dimension column", async () => {
  const client = fakeClient({
    act_1: [row("2026-06-01", { spend: "200", impressions: "2000", clicks: "100" })],
  });
  const p = await buildReport(
    client,
    {
      accountIds: ["act_1"],
      level: "account",
      since: "2026-06-01",
      until: "2026-06-01",
      columns: ["spend", "ctr"],
      breakdown: "none",
    },
    "Acme",
  );
  expect(p.columns.map((c) => c.label)).toEqual(["Spend", "CTR"]);
  expect(p.rows).toEqual([[200, 5]]);
  expect(p.totals).toBeNull();
});

test("buildReport skips accounts that error and notes it", async () => {
  const client = fakeClient({
    act_ok: [row("2026-06-01", { spend: "10", impressions: "100", clicks: "5" })],
    act_bad: "throw",
  });
  const p = await buildReport(
    client,
    {
      accountIds: ["act_ok", "act_bad"],
      level: "account",
      since: "2026-06-01",
      until: "2026-06-01",
      columns: ["spend"],
      breakdown: "day",
    },
    "Mixed",
  );
  expect(p.rowCount).toBe(1);
  expect(p.note).toContain("1 of 2 accounts");
});
