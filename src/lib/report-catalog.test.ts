import { test, expect } from "bun:test";
import { REPORT_METRICS, metric, LEGACY_UI_COLUMN_KEYS } from "./report-catalog";

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
