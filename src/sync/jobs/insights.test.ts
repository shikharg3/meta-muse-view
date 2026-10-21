import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncInsightsRange } from "./insights";
import type { InsightRow, InsightsClient } from "@/meta/types";
import { MetaAuthError } from "@/meta/client";
import { CORE_METRICS, SPEND_CORRUPTING_METRICS } from "@/meta/fieldsets";

beforeEach(async () => {
  await db.execute(sql`truncate table insights_daily cascade`);
});

const day = "2026-06-01";
const fake = (getInsights: InsightsClient["getInsights"]): InsightsClient =>
  ({ getInsights }) as unknown as InsightsClient;

test("parallel metric groups merge into one row per (entity, date)", async () => {
  const client = fake(async (_id, params) => {
    const fields = params.fields as string[];
    if (fields.includes("spend"))
      return [{ date_start: day, date_stop: day, campaign_id: "c1", spend: "100" }] as InsightRow[];
    if (fields.includes("impressions"))
      return [
        { date_start: day, date_stop: day, campaign_id: "c1", impressions: "500" },
      ] as InsightRow[];
    return [];
  });
  await syncInsightsRange(client, "act_1", "campaign", day, day, false, false, [
    ["spend"],
    ["impressions"],
  ]);
  const rows = await db.select().from(schema.insightsDaily);
  expect(rows).toHaveLength(1);
  expect(rows[0].spend).toBeCloseTo(100);
  expect(rows[0].impressions).toBe(500);
});

test("a failing (non-auth) metric group is skipped; other groups still persist", async () => {
  const client = fake(async (_id, params) => {
    const fields = params.fields as string[];
    if (fields.includes("spend"))
      return [{ date_start: day, date_stop: day, campaign_id: "c1", spend: "100" }] as InsightRow[];
    throw new Error("Meta error 2500: boom");
  });
  await syncInsightsRange(client, "act_1", "campaign", day, day, false, false, [
    ["spend"],
    ["impressions"],
  ]);
  const rows = await db.select().from(schema.insightsDaily);
  expect(rows).toHaveLength(1);
  expect(rows[0].spend).toBeCloseTo(100);
});

test("a MetaAuthError in any group aborts the range (never silently skipped)", async () => {
  const client = fake(async () => {
    throw new MetaAuthError("token invalid");
  });
  await expect(
    syncInsightsRange(client, "act_1", "campaign", day, day, false, false, [["spend"]]),
  ).rejects.toThrow(MetaAuthError);
});

// Meta's own answers for Silver Media（GMT-3）2 on 2026-10-14. Asked with action metrics over a
// multi-day split, spend, impressions and clicks came back "0" next to correct ratios and actions;
// asked without them, the figures were right.
const damaged = {
  date_start: day,
  date_stop: day,
  campaign_id: "c1",
  spend: "0",
  impressions: "0",
  clicks: "0",
  inline_link_clicks: "0",
  cpm: "103.285652",
  cpc: "4.7656",
  ctr: "2.167317",
  actions: [{ action_type: "link_click", value: "46" }],
} as InsightRow;
const correct = {
  date_start: day,
  date_stop: day,
  campaign_id: "c1",
  spend: "238.28",
  impressions: "2307",
  reach: "1926",
  clicks: "50",
  cpm: "103.285652",
  cpc: "4.7656",
  ctr: "2.167317",
} as InsightRow;
const asksForActions = (params: Record<string, unknown>) =>
  (params.fields as string[]).some((f) => SPEND_CORRUPTING_METRICS.includes(f));

test("a row Meta zeroed is stored with the figures it gives without action metrics", async () => {
  const client = fake(async (_id, params) => (asksForActions(params) ? [damaged] : [correct]));
  await syncInsightsRange(client, "act_1", "campaign", day, day, false, false, [CORE_METRICS]);
  const [row] = await db.select().from(schema.insightsDaily);
  expect(row.spend).toBeCloseTo(238.28);
  expect(row.impressions).toBe(2307);
  expect(row.clicks).toBe(50);
  expect(row.reach).toBe(1926);
  expect(row.inlineLinkClicks).toBe(46);
  expect(row.actions).toEqual([{ action_type: "link_click", value: "46" }]);
});

test("a zeroed row the re-request cannot repair never overwrites the stored figures", async () => {
  await db.insert(schema.insightsDaily).values({
    level: "campaign",
    entityId: "c1",
    date: day,
    accountId: "act_1",
    spend: 238.28,
    impressions: 2307,
  });
  const client = fake(async (_id, params) => {
    if (asksForActions(params)) return [damaged];
    throw new Error("Meta error 2: Service temporarily unavailable");
  });
  await syncInsightsRange(client, "act_1", "campaign", day, day, false, false, [CORE_METRICS]);
  const [row] = await db.select().from(schema.insightsDaily);
  expect(row.spend).toBeCloseTo(238.28);
  expect(row.impressions).toBe(2307);
});

test("undamaged rows cost no extra request, and a delivery-free day keeps its late lead", async () => {
  // A lead credited to a day the ad did not run: zero spend and no ratios, so not damage.
  const lateLead = {
    date_start: day,
    date_stop: day,
    campaign_id: "c2",
    spend: "0",
    impressions: "0",
    clicks: "0",
    actions: [{ action_type: "lead", value: "1" }],
  } as InsightRow;
  let calls = 0;
  const client = fake(async () => {
    calls++;
    return [{ ...correct, inline_link_clicks: "46" }, lateLead];
  });
  await syncInsightsRange(client, "act_1", "campaign", day, day, false, false, [CORE_METRICS]);
  expect(calls).toBe(1);
  const rows = await db.select().from(schema.insightsDaily);
  const lead = rows.find((r) => r.entityId === "c2");
  expect(lead?.spend).toBe(0);
  expect(lead?.actions).toEqual([{ action_type: "lead", value: "1" }]);
});
