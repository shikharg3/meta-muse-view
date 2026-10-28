import { expect, test } from "bun:test";
import type { InsightRow } from "@/meta/types";
import { splitRow } from "./split";

const row: InsightRow = {
  date_start: "2026-10-27",
  date_stop: "2026-10-27",
  campaign_id: "c1",
  spend: "891.94",
  impressions: "12623",
  clicks: "123",
  actions: [
    { action_type: "complete_registration", value: "15" },
    { action_type: "omni_purchase", value: "5" },
  ],
  action_values: [{ action_type: "omni_purchase", value: "1234.56" }],
};

test("every metric splits 80/20 and the halves add back to the original exactly", () => {
  const [kept, moved] = splitRow(row, 0.2);
  expect([kept.spend, moved.spend]).toEqual(["713.55", "178.39"]);
  expect([kept.impressions, moved.impressions]).toEqual(["10098", "2525"]);
  expect([kept.clicks, moved.clicks]).toEqual(["98", "25"]);
  expect(kept.actions).toEqual([
    { action_type: "complete_registration", value: "12" },
    { action_type: "omni_purchase", value: "4" },
  ]);
  expect(moved.actions).toEqual([
    { action_type: "complete_registration", value: "3" },
    { action_type: "omni_purchase", value: "1" },
  ]);
  expect(Number(kept.action_values![0].value) + Number(moved.action_values![0].value)).toBeCloseTo(
    1234.56,
    10,
  );
});

test("counts never become fractions, even when the share does not divide them", () => {
  const [kept, moved] = splitRow({ ...row, clicks: "7", impressions: "3" }, 0.33);
  for (const r of [kept, moved]) {
    expect(Number.isInteger(Number(r.clicks))).toBe(true);
    expect(Number.isInteger(Number(r.impressions))).toBe(true);
  }
  expect(Number(kept.clicks) + Number(moved.clicks)).toBe(7);
  expect(Number(kept.impressions) + Number(moved.impressions)).toBe(3);
});

test("identity fields are copied, not split", () => {
  const [kept, moved] = splitRow(row, 0.2);
  expect([kept.campaign_id, moved.campaign_id, moved.date_start]).toEqual([
    "c1",
    "c1",
    "2026-10-27",
  ]);
});
