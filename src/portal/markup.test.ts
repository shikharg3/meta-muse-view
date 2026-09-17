import { test, expect } from "bun:test";
import {
  rateOn,
  markupRows,
  totalSpend,
  type CommissionPeriod,
  type CommissionTable,
  type RawDayRow,
} from "./markup";

/**
 * Markup is the agency's margin, so every case here is a way of billing the wrong number.
 *
 * The rates are 25 and 50 rather than a realistic 10 or 12 so that `×1.25` / `×1.5` are exact in
 * binary and the expectations can be written as exact figures — a `toBeCloseTo` here would pass on
 * a multiplier that is off in the third decimal, which is real money across 1.2M rows.
 */

const row = (over: Partial<RawDayRow> = {}): RawDayRow => ({
  campaignId: "c1",
  date: "2026-01-01",
  spend: 100,
  impressions: 10_000,
  reach: 8_000,
  clicks: 250,
  conversions: 12,
  conversionValues: 900,
  ...over,
});

const history = (...periods: CommissionPeriod[]): CommissionTable => new Map([["c1", periods]]);

test("rateOn falls back when a campaign has no rate history", () => {
  expect(rateOn(undefined, "2026-01-15", 10)).toBe(10);
  expect(rateOn([], "2026-01-15", 10)).toBe(10);
});

test("rateOn back-dates the earliest period instead of leaving the past unpriced", () => {
  // A rate entered today with from_date = today is how an operator says "this is the deal"; it must
  // price yesterday's spend too, otherwise adding a rate would retroactively reveal raw cost.
  const periods = [{ fromDate: "2026-03-01", rate: 15 }];
  expect(rateOn(periods, "2026-02-28", 10)).toBe(15);
  expect(rateOn(periods, "2020-01-01", 10)).toBe(15);
});

test("rateOn treats fromDate as inclusive", () => {
  const periods = [
    { fromDate: "2026-01-01", rate: 10 },
    { fromDate: "2026-02-01", rate: 20 },
  ];
  expect(rateOn(periods, "2026-01-31", 0)).toBe(10);
  expect(rateOn(periods, "2026-02-01", 0)).toBe(20); // the day it starts, not the day after
});

test("rateOn picks the last period that has begun, not the newest one on file", () => {
  const periods = [
    { fromDate: "2026-01-01", rate: 10 },
    { fromDate: "2026-02-01", rate: 15 },
    { fromDate: "2026-03-01", rate: 20 },
  ];
  expect(rateOn(periods, "2026-02-15", 0)).toBe(15);
  expect(rateOn(periods, "2026-09-17", 0)).toBe(20);
});

test("markupRows applies the rate in force on each row's own date", () => {
  const rows = [
    row({ date: "2026-01-01", spend: 200 }),
    row({ date: "2026-01-02", spend: 40 }),
    row({ date: "2026-01-03", spend: 80 }),
    row({ date: "2026-01-04", spend: 8 }),
  ];
  const commissions = history(
    { fromDate: "2026-01-01", rate: 25 },
    { fromDate: "2026-01-03", rate: 50 },
  );
  // A fallback that would be visibly wrong if history were ignored.
  const marked = markupRows(rows, commissions, () => 100);

  expect(marked.map((r) => r.spend)).toEqual([250, 50, 120, 12]);
});

test("markupRows takes the fallback per campaign, so one window can span brands", () => {
  const rows = [
    row({ campaignId: "c1", spend: 200 }),
    row({ campaignId: "c2", spend: 200 }),
    row({ campaignId: "c3", spend: 200 }),
  ];
  const commissions = history({ fromDate: "2026-01-01", rate: 25 });
  const defaults: Record<string, number> = { c2: 50, c3: 100 };
  const marked = markupRows(rows, commissions, (id) => defaults[id] ?? 0);

  expect(marked.map((r) => r.spend)).toEqual([250, 300, 400]);
});

test("markupRows touches spend and nothing else", () => {
  // Inflating a volume or conversion field would overstate the client's performance, not just the
  // price — and ROAS computed from marked spend and marked value would cancel out to look correct.
  const original = row({ spend: 100 });
  const [marked] = markupRows([original], history({ fromDate: "2026-01-01", rate: 25 }), () => 0);

  expect(marked.spend).toBe(125);
  expect(marked.impressions).toBe(original.impressions);
  expect(marked.reach).toBe(original.reach);
  expect(marked.clicks).toBe(original.clicks);
  expect(marked.conversions).toBe(original.conversions);
  expect(marked.conversionValues).toBe(original.conversionValues);
  expect(marked.campaignId).toBe(original.campaignId);
  expect(marked.date).toBe(original.date);

  // The input rows are also used to attribute campaigns to brands; marking up in place would make
  // a second pass over them double the margin.
  expect(original.spend).toBe(100);
});

test("totalSpend sums the marked-up rows", () => {
  const rows = [row({ date: "2026-01-01", spend: 200 }), row({ date: "2026-01-03", spend: 80 })];
  const marked = markupRows(
    rows,
    history({ fromDate: "2026-01-01", rate: 25 }, { fromDate: "2026-01-03", rate: 50 }),
    () => 0,
  );

  expect(totalSpend(marked)).toBe(370); // 250 + 120, not 280 (= raw 280) and not 350 (one flat rate)
  expect(totalSpend([])).toBe(0);
});
