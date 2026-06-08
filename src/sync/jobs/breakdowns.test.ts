import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncBreakdowns, BREAKDOWNS } from "./breakdowns";
import type { InsightRow, InsightsClient } from "@/meta/types";

function clientFor(byBreakdown: Record<string, InsightRow[]>): InsightsClient {
  return {
    getAccounts: async () => [],
    getChildren: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getInsights: async (_id: string, params: Record<string, unknown>) =>
      byBreakdown[String(params.breakdowns)] ?? [],
  };
}

beforeEach(async () => {
  await db.execute(sql`truncate table insights_breakdown_daily cascade`);
});

test("writes one row per (breakdown_type, value, date) for the age breakdown", async () => {
  const client = clientFor({
    age: [
      { date_start: "2026-06-01", date_stop: "2026-06-01", account_id: "act_1", age: "25-34", spend: "50", impressions: "5",
        actions: [{ action_type: "omni_purchase", value: "2" }] },
    ],
  });
  await syncBreakdowns(client, "act_1", { breakdowns: ["age"], days: 7 });
  const rows = await db.select().from(schema.insightsBreakdownDaily);
  expect(rows).toHaveLength(1);
  expect(rows[0].breakdownType).toBe("age");
  expect(rows[0].breakdownValue).toBe("25-34");
  expect(rows[0].conversions).toBe(2);
});

test("BREAKDOWNS lists the dashboard's audience dimensions", () => {
  expect(BREAKDOWNS).toEqual(["age", "gender", "publisher_platform", "device_platform", "country"]);
});
