import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncInsightsRange } from "./insights";
import type { InsightRow, InsightsClient } from "@/meta/types";
import { MetaAuthError } from "@/meta/client";

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
