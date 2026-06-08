import { test, expect } from "bun:test";
import { buildQuery } from "./url";

test("comma-joins array params and JSON-encodes objects", () => {
  const qs = buildQuery({
    fields: ["spend", "impressions"],
    level: "campaign",
    filtering: [{ field: "spend", operator: "GREATER_THAN", value: 0 }],
  });
  const p = new URLSearchParams(qs);
  expect(p.get("fields")).toBe("spend,impressions");
  expect(p.get("level")).toBe("campaign");
  expect(JSON.parse(p.get("filtering")!)).toEqual([
    { field: "spend", operator: "GREATER_THAN", value: 0 },
  ]);
});

test("skips undefined values", () => {
  const qs = buildQuery({ fields: ["spend"], after: undefined });
  expect(new URLSearchParams(qs).has("after")).toBe(false);
});
