import { test, expect } from "bun:test";
import {
  NODE_FIELDS,
  INSIGHT_METRICS,
  INSIGHT_METRIC_GROUPS,
  BREAKDOWN_GROUPS,
  chunk,
} from "./fieldsets";

test("node field sets are populated and de-duplicated", () => {
  for (const fields of Object.values(NODE_FIELDS)) {
    expect(fields.length).toBeGreaterThan(10);
    expect(new Set(fields).size).toBe(fields.length);
  }
});

test("insight metric groups cover every metric with no loss or duplication", () => {
  const flat = INSIGHT_METRIC_GROUPS.flat();
  expect(flat.length).toBe(INSIGHT_METRICS.length);
  expect([...flat].sort()).toEqual([...INSIGHT_METRICS].sort());
});

test("chunk splits into the requested size, last chunk remainder kept", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([], 3)).toEqual([]);
});

test("breakdown groups are non-empty tuples", () => {
  expect(BREAKDOWN_GROUPS.length).toBeGreaterThan(5);
  expect(BREAKDOWN_GROUPS.every((g) => g.length >= 1)).toBe(true);
});
