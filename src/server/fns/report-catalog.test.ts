import { test, expect } from "bun:test";
import { classifyAvailable } from "./report-catalog";

const row = (
  raw: Record<string, unknown>,
  actions: { action_type: string; value: string }[] = [],
) => ({ raw, actions }) as { raw: unknown; actions: unknown };

test("a scalar is available only when a row carries a non-zero value", () => {
  const keys = classifyAvailable([row({ spend: "10", unique_clicks: "7", social_spend: "0" })]);
  expect(keys).toContain("spend");
  expect(keys).toContain("unique_clicks");
  // Present but zero on every sampled row — offering it would produce a column of zeros.
  expect(keys).not.toContain("social_spend");
});

test("an absent field is never offered", () => {
  const keys = classifyAvailable([row({ spend: "10" })]);
  // quality_ranking is non-null in 0 of 513,253 production rows and is not in the catalog at all;
  // marketing_messages_* is real but only for WhatsApp accounts.
  expect(keys).not.toContain("marketing_messages_delivered");
  expect(keys).not.toContain("quality_ranking");
});

test("event families resolve through any of their synonyms", () => {
  // Only the in-store purchase variant fired; the Purchases family must still count as available.
  const keys = classifyAvailable([
    row({ spend: "10" }, [{ action_type: "web_in_store_purchase", value: "3" }]),
  ]);
  expect(keys).toContain("purchases");
  expect(keys).toContain("value_purchases");
});

test("a derived metric needs every dependency present", () => {
  const withClicks = classifyAvailable([row({ spend: "10", clicks: "5", impressions: "100" })]);
  expect(withClicks).toContain("cpc"); // spend + clicks
  expect(withClicks).toContain("ctr"); // clicks + impressions

  const noClicks = classifyAvailable([row({ spend: "10", impressions: "100" })]);
  expect(noClicks).not.toContain("cpc");
  expect(noClicks).toContain("cpm"); // spend + impressions only
});

test("Meta's action-array shape counts as present", () => {
  // video_p25_watched_actions arrives as [{action_type, value}], not a scalar.
  const keys = classifyAvailable([
    row({
      spend: "10",
      impressions: "100",
      video_p25_watched_actions: [{ action_type: "video_view", value: "528" }],
    }),
  ]);
  expect(keys).toContain("video_p25_watched_actions");
  expect(keys).toContain("hook_rate"); // derived from video_p25 + impressions
});

test("an empty action array is not presence", () => {
  const keys = classifyAvailable([row({ spend: "10", video_p25_watched_actions: [] })]);
  expect(keys).not.toContain("video_p25_watched_actions");
});

test("no rows means nothing is offered except the objective-derived result", () => {
  const keys = classifyAvailable([]);
  expect(keys).toEqual(["results"]);
});
