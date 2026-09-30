import { test, expect } from "bun:test";
import { addDays } from "@/lib/range";
import {
  rateOn,
  markupRows,
  totalSpend,
  effectiveTimeline,
  type CommissionPeriod,
  type CommissionTable,
  type DefaultCommissionPeriod,
  type RawDayRow,
} from "./markup";
import { defaultCommissionLookup, type PortalScope } from "./scope";

/**
 * Markup is the agency's margin, so every case here is a way of billing the wrong number.
 *
 * The rates are 25 and 50 rather than a realistic 10 or 12 so that `×1.25` / `×1.5` are exact in
 * binary and the expectations can be written as exact figures — a `toBeCloseTo` here would pass on
 * a multiplier that is off in the third decimal, which is real money across 1.2M rows. Cases that
 * need realistic rates assert the rate itself, which is exact.
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

/** Campaign `c1`, under Brand `owner:g` of Client `b1`, with those two levels' schedules. */
const scopeWith = (schedules: {
  brand?: DefaultCommissionPeriod[];
  group?: DefaultCommissionPeriod[];
}): PortalScope => ({
  actor: { id: "u", email: "u@example.com", name: null, status: "approved" },
  brands: [
    {
      id: "b1",
      clientId: "owner",
      name: "Client",
      pageName: null,
      pageAvatarUrl: null,
      commission: schedules.brand ?? [],
      accountIds: [],
    },
  ],
  campaignIds: ["c1"],
  aliasOf: new Map([["c1", "Campaign"]]),
  brandOf: new Map([["c1", "b1"]]),
  groupOf: new Map([["c1", "owner:g"]]),
  groups: new Map([
    [
      "owner:g",
      {
        id: "owner:g",
        key: "g",
        clientId: "owner",
        brandId: "b1",
        name: "Brand",
        pageName: null,
        pageAvatarUrl: null,
        commission: schedules.group ?? [],
      },
    ],
  ]),
});

const fourDays = () => [
  row({ date: "2026-01-01", spend: 200 }),
  row({ date: "2026-01-02", spend: 40 }),
  row({ date: "2026-01-03", spend: 80 }),
  row({ date: "2026-01-04", spend: 8 }),
];

test("rateOn falls back when a campaign has no rate history", () => {
  expect(rateOn(undefined, "2026-01-15", 10)).toBe(10);
  expect(rateOn([], "2026-01-15", 10)).toBe(10);
});

test("rateOn leaves the days before the first period to the fallback", () => {
  // A rate entered with from_date = today says what today onwards costs. Pricing yesterday at it
  // too would move every figure the client has already been shown.
  const periods = [{ fromDate: "2026-03-01", rate: 15 }];
  expect(rateOn(periods, "2026-02-28", 10)).toBe(10);
  expect(rateOn(periods, "2020-01-01", 10)).toBe(10);
  expect(rateOn(periods, "2026-03-01", 10)).toBe(15);
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

test("a mid-campaign increase then decrease re-prices only the days from each change", () => {
  // The feature's acceptance case: a campaign billing the 10% default gets 14% from 1 Oct, then
  // 11% from 1 Nov. September must still read 10%.
  const periods = [
    { fromDate: "2026-10-01", rate: 14 },
    { fromDate: "2026-11-01", rate: 11 },
  ];
  const lookup = defaultCommissionLookup(scopeWith({}), 10);
  const billed = (date: string) => rateOn(periods, date, lookup("c1", date));

  expect(billed("2026-09-30")).toBe(10);
  expect(billed("2026-10-01")).toBe(14);
  expect(billed("2026-10-31")).toBe(14);
  expect(billed("2026-11-01")).toBe(11);
  expect(billed("2027-03-01")).toBe(11);
});

test("the default lookup reads each level as it stood on the day asked about", () => {
  const lookup = defaultCommissionLookup(
    scopeWith({
      brand: [{ fromDate: "2025-01-01", rate: 15 }],
      group: [
        { fromDate: "2026-01-01", rate: 25 },
        { fromDate: "2026-03-01", rate: null },
      ],
    }),
    10,
  );
  expect(lookup("c1", "2024-12-31")).toBe(10); // before any entry at any level
  expect(lookup("c1", "2025-12-31")).toBe(15); // before the Brand's first entry: the Client's
  expect(lookup("c1", "2026-02-28")).toBe(25);
  // A null Brand entry hands its days back to the Client from that date, not before it.
  expect(lookup("c1", "2026-03-01")).toBe(15);
});

test("markupRows re-prices a Client default changed mid-window only from the change", () => {
  const lookup = defaultCommissionLookup(
    scopeWith({
      brand: [
        { fromDate: "2025-01-01", rate: 25 },
        { fromDate: "2026-01-03", rate: 50 },
      ],
    }),
    100,
  );
  const marked = markupRows(fourDays(), new Map(), lookup);
  expect(marked.map((r) => r.spend)).toEqual([250, 50, 120, 12]);
});

test("markupRows gives a campaign's own entry only its own days, after an inherited stretch", () => {
  // The Client default prices the first two days; the campaign's entry from the 3rd takes over.
  const lookup = defaultCommissionLookup(
    scopeWith({ brand: [{ fromDate: "2025-01-01", rate: 25 }] }),
    100,
  );
  const marked = markupRows(fourDays(), history({ fromDate: "2026-01-03", rate: 50 }), lookup);
  expect(marked.map((r) => r.spend)).toEqual([250, 50, 120, 12]);
});

test("markupRows follows a decrease and then an increase", () => {
  const lookup = defaultCommissionLookup(
    scopeWith({
      group: [
        { fromDate: "2025-01-01", rate: 50 },
        { fromDate: "2026-01-02", rate: 25 },
        { fromDate: "2026-01-04", rate: 50 },
      ],
    }),
    100,
  );
  const rows = fourDays().map((r) => ({ ...r, spend: 100 }));
  expect(markupRows(rows, new Map(), lookup).map((r) => r.spend)).toEqual([150, 125, 125, 150]);
});

test("markupRows applies the rate in force on each row's own date", () => {
  const commissions = history(
    { fromDate: "2026-01-01", rate: 25 },
    { fromDate: "2026-01-03", rate: 50 },
  );
  // A fallback that would be visibly wrong if history were ignored.
  const marked = markupRows(fourDays(), commissions, () => 100);

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

test("effectiveTimeline states exactly the rate markupRows bills, day by day", () => {
  // The admin console shows this instead of re-deriving the margin, so it must never disagree
  // with what the portal bills — on any day, not just at the boundaries.
  const campaign = [
    { fromDate: "2026-10-01", rate: 14 },
    { fromDate: "2026-11-01", rate: 11 },
  ];
  const group = [
    { fromDate: "2026-02-01", rate: 12 },
    { fromDate: "2026-06-01", rate: null },
  ];
  const brand = [{ fromDate: "2025-03-24", rate: 15 }];
  const timeline = effectiveTimeline({ campaign, group, brand }, 10);

  expect(timeline).toEqual([
    { fromDate: null, toDate: "2025-03-23", rate: 10, source: "default" },
    { fromDate: "2025-03-24", toDate: "2026-01-31", rate: 15, source: "brand" },
    { fromDate: "2026-02-01", toDate: "2026-05-31", rate: 12, source: "group" },
    { fromDate: "2026-06-01", toDate: "2026-09-30", rate: 15, source: "brand" },
    { fromDate: "2026-10-01", toDate: "2026-10-31", rate: 14, source: "campaign" },
    { fromDate: "2026-11-01", toDate: null, rate: 11, source: "campaign" },
  ]);

  const lookup = defaultCommissionLookup(scopeWith({ brand, group }), 10);
  for (let day = "2025-03-01"; day <= "2026-12-31"; day = addDays(day, 1)) {
    const stretch = timeline.find(
      (s) => (s.fromDate === null || s.fromDate <= day) && (s.toDate === null || day <= s.toDate),
    );
    expect(stretch?.rate).toBe(rateOn(campaign, day, lookup("c1", day)));
  }
});

test("effectiveTimeline merges a repeated rate, but not the same rate from another level", () => {
  // A Client set to 10% is a decision even though it equals the agency default; the dialog says
  // whose rate a day is on, so the two stretches stay apart.
  expect(effectiveTimeline({ brand: [{ fromDate: "2025-01-01", rate: 10 }] }, 10)).toEqual([
    { fromDate: null, toDate: "2024-12-31", rate: 10, source: "default" },
    { fromDate: "2025-01-01", toDate: null, rate: 10, source: "brand" },
  ]);
  expect(
    effectiveTimeline(
      {
        brand: [
          { fromDate: "2025-01-01", rate: 15 },
          { fromDate: "2025-06-01", rate: 15 },
        ],
      },
      10,
    ),
  ).toEqual([
    { fromDate: null, toDate: "2024-12-31", rate: 10, source: "default" },
    { fromDate: "2025-01-01", toDate: null, rate: 15, source: "brand" },
  ]);
});
