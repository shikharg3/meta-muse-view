import { expect, test } from "bun:test";
import { addDays } from "@/lib/range";
import type { InsightRow } from "@/meta/types";
import { modelInterruptedDays, type KeyedRow } from "./modeling";

const row = (date: string, spend: number, extra: Partial<InsightRow> = {}): InsightRow => ({
  date_start: date,
  date_stop: date,
  spend: String(spend),
  impressions: String(spend * 10),
  clicks: String(spend / 10),
  ...extra,
});

/** One entity's daily spend from `start`; null = no row that day. */
function series(start: string, spends: (number | null)[], key = "s1"): KeyedRow[] {
  return spends.flatMap((s, i) =>
    s === null ? [] : [{ accountId: "act_1", key, row: row(addDays(start, i), s) }],
  );
}

const dayOf = (r: KeyedRow) => String(r.row.date_start);
const spendOn = (rows: KeyedRow[], d: string) =>
  rows.filter((r) => dayOf(r) === d).reduce((s, r) => s + Number(r.row.spend), 0);

test("a dead yesterday is modeled from the previous 7 active days, within ±15%", () => {
  // 10-20 … 10-26 ran at 100/day; 10-27 (yesterday) did not run at all.
  const rows = series("2026-10-20", [100, 100, 100, 100, 100, 100, 100, null]);
  const r = modelInterruptedDays(rows, { since: "2026-10-27", until: "2026-10-27" }, "2026-10-27");
  expect(r.modeled.map((m) => [m.date, m.actualSpend, m.referenceDays.length])).toEqual([
    ["2026-10-27", 0, 7],
  ]);
  const spend = spendOn(r.rows, "2026-10-27");
  expect(spend).toBeGreaterThanOrEqual(85);
  expect(spend).toBeLessThanOrEqual(115);
  // Seeded, not random: the same report always shows the same estimate.
  const again = modelInterruptedDays(
    rows,
    { since: "2026-10-27", until: "2026-10-27" },
    "2026-10-27",
  );
  expect(again.rows).toEqual(r.rows);
});

test("low spend is judged against the median: under 25% is modeled, above is left actual", () => {
  const range = { since: "2026-10-27", until: "2026-10-27" };
  const low = series("2026-10-20", [100, 100, 100, 100, 100, 100, 100, 20]);
  expect(modelInterruptedDays(low, range, "2026-10-27").modeled).toHaveLength(1);
  const normal = series("2026-10-20", [100, 100, 100, 100, 100, 100, 100, 30]);
  const r = modelInterruptedDays(normal, range, "2026-10-27");
  expect(r.modeled).toHaveLength(0);
  expect(spendOn(r.rows, "2026-10-27")).toBe(30);
});

test("a gap mid-campaign is modeled from active days on both sides, never from the other dead day", () => {
  // 10-10 … 10-24 at 100/day, except 10-16 and 10-17 dead and 10-18 at 5 (a trickle).
  const spends = Array.from({ length: 15 }, (_, i) =>
    i === 6 || i === 7 ? null : i === 8 ? 5 : 100,
  );
  const rows = series("2026-10-10", spends);
  const r = modelInterruptedDays(rows, { since: "2026-10-10", until: "2026-10-24" }, "2026-10-27");
  expect(r.modeled.map((m) => m.date)).toEqual(["2026-10-16", "2026-10-17", "2026-10-18"]);
  for (const m of r.modeled) {
    expect(m.referenceMedian).toBe(100); // the trickle day does not drag its neighbours' median down
    expect(m.referenceDays).not.toContain("2026-10-18");
  }
  // Untouched days keep their actual rows.
  expect(spendOn(r.rows, "2026-10-15")).toBe(100);
});

test("days before the campaign's first delivery are not interruptions", () => {
  const rows = series("2026-10-23", [100, 100, 100, 100, 100]);
  const r = modelInterruptedDays(rows, { since: "2026-10-20", until: "2026-10-27" }, "2026-10-27");
  expect(r.modeled).toHaveLength(0);
  expect(r.rows.map(dayOf)).not.toContain("2026-10-20");
});

test("a dead day with too few active days nearby is left actual and reported", () => {
  // One active day, 10-20, seven days before the dead yesterday.
  const rows = series("2026-10-20", [100, null, null, null, null, null, null, null]);
  const r = modelInterruptedDays(rows, { since: "2026-10-27", until: "2026-10-27" }, "2026-10-27");
  expect(r.modeled).toHaveLength(0);
  expect(r.skipped).toEqual([
    { date: "2026-10-27", reason: "only 1 active day nearby to model from" },
  ]);
});

test("each entity is modeled from its own days, a missing day counting as zero", () => {
  const rows = [
    ...series("2026-10-20", [200, 200, 200, 200, 200, 200, 200, null], "big"),
    ...series("2026-10-20", [70, null, 70, null, 70, null, 70, null], "part-time"),
  ];
  const r = modelInterruptedDays(rows, { since: "2026-10-27", until: "2026-10-27" }, "2026-10-27");
  const on = (key: string) => r.rows.find((x) => x.key === key && dayOf(x) === "2026-10-27");
  expect(Number(on("big")!.row.spend)).toBeGreaterThanOrEqual(170);
  expect(Number(on("big")!.row.spend)).toBeLessThanOrEqual(230);
  // 280 over 7 reference days = 40/day, ±15%.
  expect(Number(on("part-time")!.row.spend)).toBeGreaterThanOrEqual(34);
  expect(Number(on("part-time")!.row.spend)).toBeLessThanOrEqual(46);
});

test("synonymous action types keep one value, counts stay whole, ids are copied", () => {
  const actions = [
    { action_type: "complete_registration", value: "10" },
    { action_type: "omni_complete_registration", value: "10" },
  ];
  const rows: KeyedRow[] = [
    ...Array.from({ length: 7 }, (_, i) => ({
      accountId: "act_1",
      key: "s1",
      row: row(addDays("2026-10-20", i), 100, { actions, campaign_id: "c1", __dim: "s1" }),
    })),
  ];
  const r = modelInterruptedDays(rows, { since: "2026-10-27", until: "2026-10-27" }, "2026-10-27");
  const est = r.rows.find((x) => dayOf(x) === "2026-10-27")!.row;
  const acts = est.actions!;
  expect(acts[0].value).toBe(acts[1].value); // one factor for the array: the family reads the same
  expect(Number.isInteger(Number(acts[0].value))).toBe(true);
  expect(Number.isInteger(Number(est.impressions))).toBe(true);
  expect(est.campaign_id).toBe("c1");
  expect(est.__dim).toBe("s1");
});
