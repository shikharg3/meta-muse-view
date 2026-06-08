import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncInsights, trailingRange } from "./insights";
import type { InsightRow, InsightsClient } from "@/meta/types";

function makeClient(rows: InsightRow[]): InsightsClient {
  return {
    getAccounts: async () => [],
    getChildren: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getInsights: async () => rows,
  };
}

beforeEach(async () => {
  await db.execute(sql`truncate table insights_daily cascade`);
});

test("upserts one row per (level, entity, date) and is idempotent on re-pull", async () => {
  const rows: InsightRow[] = [
    { date_start: "2026-06-01", date_stop: "2026-06-01", campaign_id: "c1", spend: "100", impressions: "10",
      actions: [{ action_type: "omni_purchase", value: "3" }] },
  ];
  const client = makeClient(rows);
  await syncInsights(client, "act_1", { level: "campaign", days: 3 });
  await syncInsights(client, "act_1", { level: "campaign", days: 3 }); // re-pull same window

  const all = await db.select().from(schema.insightsDaily);
  expect(all).toHaveLength(1);
  expect(all[0].spend).toBeCloseTo(100);
  expect(all[0].conversions).toBe(3);
  expect(all[0].level).toBe("campaign");
});

test("trailingRange covers `days` inclusive of today", () => {
  const { since, until } = trailingRange(3, new Date("2026-06-08T12:00:00Z"));
  expect(until).toBe("2026-06-08");
  expect(since).toBe("2026-06-06");
});
