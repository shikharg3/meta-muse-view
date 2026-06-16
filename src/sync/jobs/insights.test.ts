import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncInsights, trailingRange, chunkRange } from "./insights";
import type { InsightRow, InsightsClient } from "@/meta/types";
import { INSIGHT_METRIC_GROUPS } from "@/meta/fieldsets";

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
    {
      date_start: "2026-06-01",
      date_stop: "2026-06-01",
      campaign_id: "c1",
      spend: "100",
      impressions: "10",
      actions: [{ action_type: "omni_purchase", value: "3" }],
    },
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

test("account-level rows are keyed by the act_-prefixed account id, not the bare account_id", async () => {
  const rows: InsightRow[] = [
    { date_start: "2026-06-01", date_stop: "2026-06-01", account_id: "123", spend: "50" },
  ];
  await syncInsights(makeClient(rows), "act_123", { level: "account", days: 1 });
  const all = await db.select().from(schema.insightsDaily);
  expect(all).toHaveLength(1);
  expect(all[0].entityId).toBe("act_123");
});

test("trailingRange covers `days` inclusive of today", () => {
  const { since, until } = trailingRange(3, new Date("2026-06-08T12:00:00Z"));
  expect(until).toBe("2026-06-08");
  expect(since).toBe("2026-06-06");
});

test("chunkRange splits a long range into contiguous <=90-day windows", () => {
  const windows = chunkRange("2024-01-01", "2024-12-31", 90);
  expect(windows[0].since).toBe("2024-01-01");
  expect(windows[windows.length - 1].until).toBe("2024-12-31");
  const day = 86_400_000;
  for (let i = 1; i < windows.length; i++) {
    const prevUntil = new Date(`${windows[i - 1].until}T00:00:00Z`).getTime();
    const since = new Date(`${windows[i].since}T00:00:00Z`).getTime();
    expect((since - prevUntil) / day).toBe(1); // contiguous: no gap, no overlap
  }
  for (const w of windows) {
    const span =
      (new Date(`${w.until}T00:00:00Z`).getTime() - new Date(`${w.since}T00:00:00Z`).getTime()) /
        day +
      1;
    expect(span).toBeLessThanOrEqual(90);
  }
});

test("chunkRange returns a single window when the range already fits", () => {
  expect(chunkRange("2026-06-01", "2026-06-10", 90)).toEqual([
    { since: "2026-06-01", until: "2026-06-10" },
  ]);
});

test("syncInsights issues one request per chunk across a long backfill", async () => {
  let calls = 0;
  const client: InsightsClient = {
    getAccounts: async () => [],
    getChildren: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getInsights: async () => {
      calls++;
      return [];
    },
  };
  // 365-day window at 90-day chunks → 5 chunks, each requested once per metric group.
  await syncInsights(client, "act_1", {
    level: "account",
    days: 365,
    today: new Date("2026-06-08T00:00:00Z"),
  });
  // Each chunk: one request per metric group + one attribution-window request (refresh path).
  expect(calls).toBe(5 * (INSIGHT_METRIC_GROUPS.length + 1));
});

test("merges metric groups into one row and captures the full set in raw", async () => {
  const client: InsightsClient = {
    getAccounts: async () => [],
    getChildren: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getInsights: async (_id, params) => {
      const fields = (params.fields as string[]) ?? [];
      const base = { date_start: "2026-06-01", date_stop: "2026-06-01", campaign_id: "c1" };
      // Simulate Meta returning only the requested group's metrics.
      if (fields.includes("spend")) return [{ ...base, spend: "100", impressions: "10" }];
      if (fields.includes("frequency"))
        return [{ ...base, frequency: "2.5", quality_ranking: "ABOVE_AVERAGE" }];
      return [base];
    },
  };
  await syncInsights(client, "act_1", { level: "campaign", days: 1 });
  const [row] = await db.select().from(schema.insightsDaily);
  expect(row.spend).toBeCloseTo(100);
  expect(row.frequency).toBeCloseTo(2.5);
  expect(row.qualityRanking).toBe("ABOVE_AVERAGE");
  const raw = row.raw as Record<string, unknown>;
  expect(raw.spend).toBe("100");
  expect(raw.frequency).toBe("2.5");
}, 20000);

test("captures attribution-window splits in a separate column on refresh", async () => {
  const client: InsightsClient = {
    getAccounts: async () => [],
    getChildren: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getInsights: async (_id, params) => {
      const base = { date_start: "2026-06-01", date_stop: "2026-06-01", campaign_id: "c1" };
      if (params.action_attribution_windows)
        return [
          {
            ...base,
            actions: [{ action_type: "purchase", value: "5", "7d_click": "4", "1d_view": "1" }],
          },
        ];
      if ((params.fields as string[]).includes("spend")) return [{ ...base, spend: "10" }];
      return [base];
    },
  };
  await syncInsights(client, "act_1", { level: "campaign", days: 1 });
  const [row] = await db.select().from(schema.insightsDaily);
  expect(row.spend).toBeCloseTo(10);
  expect(row.actionsByWindow).toEqual([
    { action_type: "purchase", value: "5", "7d_click": "4", "1d_view": "1" },
  ]);
}, 20000);
