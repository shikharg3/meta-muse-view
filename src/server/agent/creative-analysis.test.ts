import { test, expect } from "bun:test";
import {
  aggregateByCreative,
  rankCreatives,
  extractCopy,
  normalizeMetric,
  type CreativeRow,
} from "./creative-analysis";

const ins = (
  entityId: string,
  o: Partial<{
    spend: number;
    impressions: number;
    reach: number;
    clicks: number;
    conversionValues: number;
    actions: unknown;
  }>,
) => ({
  entityId,
  spend: 0,
  impressions: 0,
  reach: 0,
  clicks: 0,
  conversionValues: 0,
  actions: null,
  ...o,
});

test("normalizeMetric maps phrasing to metric keys", () => {
  expect(normalizeMetric("by spend")).toBe("spend");
  expect(normalizeMetric("best CTR")).toBe("ctr");
  expect(normalizeMetric("lowest cost per result")).toBe("cost_per_result");
  expect(normalizeMetric("CPC")).toBe("cpc");
  expect(normalizeMetric("ROAS")).toBe("roas");
  expect(normalizeMetric("most results")).toBe("results");
  expect(normalizeMetric(undefined)).toBe("results");
});

test("extractCopy pulls headline/body/cta from object_story_spec", () => {
  const copy = extractCopy({
    object_story_spec: {
      link_data: {
        message: "Join now and get 200% bonus",
        name: "Big Welcome Bonus",
        call_to_action: { type: "SIGN_UP" },
      },
    },
  });
  expect(copy.title).toBe("Big Welcome Bonus");
  expect(copy.body).toBe("Join now and get 200% bonus");
  expect(copy.cta).toBe("sign up");
  expect(extractCopy(null)).toEqual({ title: undefined, body: undefined, cta: undefined });
});

test("aggregateByCreative groups ads by creative with objective-aware results", () => {
  // cr1 used by two ads: a1 (leads), a2 (traffic); cr2 by a3 (leads)
  const creativeByAd = new Map([
    ["a1", "cr1"],
    ["a2", "cr1"],
    ["a3", "cr2"],
  ]);
  const objectiveByAd = new Map<string, string | undefined>([
    ["a1", "OUTCOME_LEADS"],
    ["a2", "OUTCOME_TRAFFIC"],
    ["a3", "OUTCOME_LEADS"],
  ]);
  const meta = new Map([
    ["cr1", { name: "Bonus A", thumbnailUrl: "u1", raw: {} }],
    ["cr2", { name: "Bonus B", thumbnailUrl: "u2", raw: {} }],
  ]);
  const rows = aggregateByCreative(
    [
      ins("a1", {
        spend: 100,
        impressions: 1000,
        clicks: 50,
        actions: [{ action_type: "lead", value: "8" }],
      }),
      ins("a2", {
        spend: 50,
        impressions: 500,
        clicks: 25,
        actions: [{ action_type: "link_click", value: "30" }],
      }),
      ins("a3", {
        spend: 20,
        impressions: 400,
        clicks: 8,
        actions: [{ action_type: "lead", value: "2" }],
      }),
    ],
    creativeByAd,
    objectiveByAd,
    meta,
  );
  const cr1 = rows.find((r) => r.id === "cr1")!;
  expect(cr1.spend).toBe(150);
  expect(cr1.clicks).toBe(75);
  expect(cr1.results).toBe(38); // 8 leads + 30 link clicks (objective-aware)
  expect(cr1.ctr).toBeCloseTo(5); // 75/1500*100
  expect(cr1.cpc).toBeCloseTo(2);
  expect(cr1.resultLabel).toBe("Leads"); // leads objective spent more ($100 > $50)
  expect(rows).toHaveLength(2);
});

const row = (o: Partial<CreativeRow>): CreativeRow => ({
  id: "x",
  name: "x",
  format: "Image",
  thumbnailUrl: null,
  spend: 0,
  impressions: 0,
  clicks: 0,
  ctr: 0,
  cpc: 0,
  cpm: 0,
  roas: 0,
  results: 0,
  resultLabel: "Results",
  costPerResult: 0,
  copy: {},
  ...o,
});

test("rankCreatives sorts by results desc by default", () => {
  const ranked = rankCreatives(
    [
      row({ id: "a", results: 5, spend: 100 }),
      row({ id: "b", results: 20, spend: 50 }),
      row({ id: "c", results: 12, spend: 80 }),
    ],
    "results",
    2,
  );
  expect(ranked.map((r) => r.id)).toEqual(["b", "c"]);
});

test("rankCreatives applies an impressions floor for efficiency metrics", () => {
  const ranked = rankCreatives(
    [
      row({ id: "fluke", ctr: 80, impressions: 10, spend: 1 }), // tiny volume — excluded
      row({ id: "real", ctr: 9, impressions: 5000, spend: 100 }),
      row({ id: "ok", ctr: 6, impressions: 3000, spend: 80 }),
    ],
    "ctr",
    5,
  );
  expect(ranked.map((r) => r.id)).toEqual(["real", "ok"]);
});

test("rankCreatives ranks cost_per_result ascending and drops zero (no-data)", () => {
  const ranked = rankCreatives(
    [
      row({ id: "cheap", costPerResult: 2, impressions: 1000, spend: 100 }),
      row({ id: "pricey", costPerResult: 9, impressions: 1000, spend: 100 }),
      row({ id: "nodata", costPerResult: 0, impressions: 1000, spend: 100 }),
    ],
    "cost_per_result",
    5,
  );
  expect(ranked.map((r) => r.id)).toEqual(["cheap", "pricey"]); // nodata excluded, cheap first
});
