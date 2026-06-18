import { test, expect } from "bun:test";
import { pickAction, normalizeInsightRow } from "./insights";
import type { InsightRow } from "./types";

test("pickAction sums the matching action type and returns 0 when absent", () => {
  const actions = [
    { action_type: "omni_purchase", value: "42" },
    { action_type: "link_click", value: "7" },
  ];
  expect(pickAction(actions, "omni_purchase")).toBe(42);
  expect(pickAction(actions, "nope")).toBe(0);
});

test("normalizeInsightRow maps strings to numbers and derives conversions/roas", () => {
  const row: InsightRow = {
    date_start: "2026-06-01",
    date_stop: "2026-06-01",
    account_id: "act_1",
    campaign_id: "c1",
    spend: "100.5",
    impressions: "1000",
    clicks: "50",
    ctr: "5",
    cpc: "2.01",
    cpm: "100.5",
    actions: [{ action_type: "omni_purchase", value: "10" }],
    action_values: [{ action_type: "omni_purchase", value: "300" }],
    purchase_roas: [{ action_type: "omni_purchase", value: "2.98" }],
  };
  const n = normalizeInsightRow(row, "campaign", "c1", "act_1");
  expect(n.spend).toBeCloseTo(100.5);
  expect(n.impressions).toBe(1000);
  expect(n.conversions).toBe(10);
  expect(n.conversionValues).toBe(300);
  expect(n.purchaseRoas).toBeCloseTo(2.98);
  expect(n.entityId).toBe("c1");
});
