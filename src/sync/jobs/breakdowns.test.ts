import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncBreakdowns } from "./breakdowns";
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

test("writes one row per (breakdown_type, value, date), promoting reach + dims + raw", async () => {
  const client = clientFor({
    age: [
      {
        date_start: "2026-06-01",
        date_stop: "2026-06-01",
        account_id: "act_1",
        age: "25-34",
        spend: "50",
        impressions: "5",
        reach: "4",
        actions: [{ action_type: "omni_purchase", value: "2" }],
      },
    ],
  });
  await syncBreakdowns(client, "act_1", { groups: [["age"]], days: 7 });
  const rows = await db.select().from(schema.insightsBreakdownDaily);
  expect(rows).toHaveLength(1);
  expect(rows[0].breakdownType).toBe("age");
  expect(rows[0].breakdownValue).toBe("25-34");
  expect(rows[0].reach).toBe(4);
  expect(rows[0].conversions).toBe(2);
  expect(rows[0].dims).toEqual({ age: "25-34" });
  expect((rows[0].raw as Record<string, unknown>).age).toBe("25-34");
});

test("campaign-level breakdowns key on campaign_id, not the account", async () => {
  const client = clientFor({
    age: [
      {
        date_start: "2026-06-01",
        date_stop: "2026-06-01",
        campaign_id: "c1",
        age: "25-34",
        spend: "30",
      },
      {
        date_start: "2026-06-01",
        date_stop: "2026-06-01",
        campaign_id: "c2",
        age: "25-34",
        spend: "20",
      },
    ],
  });
  await syncBreakdowns(client, "act_1", { groups: [["age"]], days: 7, level: "campaign" });
  const rows = await db.select().from(schema.insightsBreakdownDaily);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.level === "campaign")).toBe(true);
  expect(new Set(rows.map((r) => r.entityId))).toEqual(new Set(["c1", "c2"]));
});

test("multi-dimension groups become one breakdown_type with per-dim dims", async () => {
  const client = clientFor({
    "publisher_platform,platform_position": [
      {
        date_start: "2026-06-01",
        date_stop: "2026-06-01",
        account_id: "act_1",
        publisher_platform: "facebook",
        platform_position: "feed",
        spend: "10",
      },
    ],
  });
  await syncBreakdowns(client, "act_1", {
    groups: [["publisher_platform", "platform_position"]],
    days: 1,
  });
  const [row] = await db.select().from(schema.insightsBreakdownDaily);
  expect(row.breakdownType).toBe("publisher_platform|platform_position");
  expect(row.breakdownValue).toBe("facebook|feed");
  expect(row.dims).toEqual({ publisher_platform: "facebook", platform_position: "feed" });
});

test("a group Meta rejects is skipped without failing the others", async () => {
  const client: InsightsClient = {
    getAccounts: async () => [],
    getChildren: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getInsights: async (_id, params) => {
      if (String(params.breakdowns) === "bad_dim")
        throw new Error("(#100) bad_dim is not a valid breakdown");
      return [
        {
          date_start: "2026-06-01",
          date_stop: "2026-06-01",
          account_id: "act_1",
          country: "BR",
          spend: "5",
        },
      ];
    },
  };
  const written = await syncBreakdowns(client, "act_1", {
    groups: [["bad_dim"], ["country"]],
    days: 1,
  });
  expect(written).toBe(1);
  const rows = await db.select().from(schema.insightsBreakdownDaily);
  expect(rows).toHaveLength(1);
  expect(rows[0].breakdownType).toBe("country");
});
