import { test, expect } from "bun:test";
import {
  REPORT_METRICS,
  metric,
  LEGACY_UI_COLUMN_KEYS,
  GROUP_LABELS,
  EVENT_FAMILY_LABELS,
  type MetricGroup,
} from "./report-catalog";

test("keys are unique", () => {
  const keys = REPORT_METRICS.map((m) => m.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("every derived dependency resolves to a real metric", () => {
  const keys = new Set(REPORT_METRICS.map((m) => m.key));
  for (const m of REPORT_METRICS) {
    if (m.source.kind !== "derived") continue;
    for (const dep of m.source.deps) {
      expect(keys.has(dep), `${m.key} depends on missing ${dep}`).toBe(true);
    }
  }
});

test("no cost or ratio metric reads a stored field", () => {
  // Meta ships precomputed cpc/cpm/cost_per_* inside the synced `raw` blob. Sourcing one would
  // bypass the markup applied to spend and understate what a client is charged, so every cost or
  // ratio must be derived from spend and a count.
  for (const m of REPORT_METRICS) {
    const isCostOrRatio =
      /^(cost_per_|cpc|cpm|cpp|ctr|roas|frequency)/.test(m.key) || m.group === "cost";
    if (!isCostOrRatio) continue;
    expect(m.source.kind, `${m.key} must be derived, is ${m.source.kind}`).toBe("derived");
  }
});

test("derived dependency graphs terminate", () => {
  // A cycle here would hang report generation rather than fail it.
  const walk = (key: string, stack: string[]): void => {
    expect(stack.includes(key), `cycle: ${[...stack, key].join(" -> ")}`).toBe(false);
    const m = metric(key);
    if (!m || m.source.kind !== "derived") return;
    for (const dep of m.source.deps) walk(dep, [...stack, key]);
  };
  for (const m of REPORT_METRICS) walk(m.key, []);
});

test("every legacy UI key exists in the catalog", () => {
  for (const k of LEGACY_UI_COLUMN_KEYS) {
    expect(metric(k), `missing legacy key ${k}`).toBeDefined();
  }
});

test("the catalog covers the measured stored metric set", () => {
  // 112 as built. A floor, not a target: production carries 111 distinct raw keys, of which the
  // identity fields and every precomputed cost/rate are deliberately excluded.
  expect(REPORT_METRICS.length).toBeGreaterThanOrEqual(100);
});

test("no group is empty", () => {
  for (const g of Object.keys(GROUP_LABELS) as MetricGroup[]) {
    expect(
      REPORT_METRICS.some((m) => m.group === g),
      `group ${g} has no metrics — remove it or populate it`,
    ).toBe(true);
  }
});

test("every event family is exposed as a count, a value and a cost-per", () => {
  for (const family of EVENT_FAMILY_LABELS) {
    const count = REPORT_METRICS.filter(
      (m) =>
        m.source.kind === "event" && m.source.family === family && m.source.measure === "count",
    );
    const value = REPORT_METRICS.filter(
      (m) =>
        m.source.kind === "event" && m.source.family === family && m.source.measure === "value",
    );
    expect(count.length, `${family} count`).toBe(1);
    expect(value.length, `${family} value`).toBe(1);
    // Its cost-per must be derived over that family's own count key.
    const costs = REPORT_METRICS.filter(
      (m) => m.source.kind === "derived" && m.source.deps.includes(count[0].key),
    );
    expect(costs.length, `${family} cost-per over ${count[0].key}`).toBeGreaterThanOrEqual(1);
  }
});

test("no metric sources a precomputed Meta cost or rate field", () => {
  // The exact keys production returns that would bypass the markup if read directly.
  const banned = [
    "cpc",
    "cpm",
    "cpp",
    "ctr",
    "unique_ctr",
    "website_ctr",
    "inline_link_click_ctr",
    "cost_per_result",
    "cost_per_action_type",
    "cost_per_conversion",
    "cost_per_inline_link_click",
    "cost_per_inline_post_engagement",
    "cost_per_outbound_click",
    "cost_per_thruplay",
    "cost_per_unique_click",
    "cost_per_unique_action_type",
    "purchase_roas",
    "website_purchase_roas",
    "result_rate",
    "average_purchases_conversion_value",
    "marketing_messages_cost_per_delivered",
    "marketing_messages_read_rate",
    "marketing_messages_delivery_rate",
  ];
  for (const m of REPORT_METRICS) {
    if (m.source.kind !== "scalar") continue;
    expect(banned.includes(m.source.field), `${m.key} reads precomputed ${m.source.field}`).toBe(
      false,
    );
  }
});
