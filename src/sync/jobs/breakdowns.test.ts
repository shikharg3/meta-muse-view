import { test, expect, beforeEach } from "bun:test";
import { sql as dsql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncBreakdowns } from "./breakdowns";
import type { InsightsClient, InsightRow } from "@/meta/types";

beforeEach(async () => {
  await db.execute(dsql`truncate table insights_breakdown_daily`);
});

const fakeClient = (rows: InsightRow[]): InsightsClient =>
  ({ getInsights: async () => rows }) as unknown as InsightsClient;

test("asset breakdown rows keep one row PER ASSET (stable id key + readable label)", async () => {
  // Two video assets on the SAME ad and day: naive String(object) collapsed both into one
  // "[object Object]" PK, the second upsert silently overwriting the first.
  const rows: InsightRow[] = [
    {
      date_start: "2026-07-15",
      date_stop: "2026-07-15",
      ad_id: "ad1",
      spend: "10",
      impressions: "100",
      clicks: "5",
      video_asset: { video_id: "111", video_name: "Hero A" },
    },
    {
      date_start: "2026-07-15",
      date_stop: "2026-07-15",
      ad_id: "ad1",
      spend: "20",
      impressions: "200",
      clicks: "8",
      video_asset: { video_id: "222", video_name: "Hero B" },
    },
  ];
  const written = await syncBreakdowns(fakeClient(rows), "act_9", {
    groups: [["video_asset"]],
    level: "ad",
    since: "2026-07-15",
    until: "2026-07-15",
  });
  expect(written).toBe(2);
  const stored = await db
    .select({
      value: schema.insightsBreakdownDaily.breakdownValue,
      dims: schema.insightsBreakdownDaily.dims,
      spend: schema.insightsBreakdownDaily.spend,
    })
    .from(schema.insightsBreakdownDaily);
  expect(stored).toHaveLength(2); // NOT collapsed into one
  const byValue = new Map(stored.map((s) => [s.value, s]));
  expect([...byValue.keys()].sort()).toEqual(["111", "222"]); // stable id keys
  expect((byValue.get("111")?.dims as { video_asset?: string })?.video_asset).toBe("Hero A");
  expect(byValue.get("222")?.spend).toBe(20);
});

test("plain string breakdown values are stored unchanged", async () => {
  const rows: InsightRow[] = [
    {
      date_start: "2026-07-15",
      date_stop: "2026-07-15",
      spend: "5",
      impressions: "50",
      clicks: "2",
      age: "25-34",
      gender: "male",
    },
  ];
  await syncBreakdowns(fakeClient(rows), "act_9", {
    groups: [["age", "gender"]],
    level: "account",
    since: "2026-07-15",
    until: "2026-07-15",
  });
  const [stored] = await db
    .select({ value: schema.insightsBreakdownDaily.breakdownValue })
    .from(schema.insightsBreakdownDaily);
  expect(stored.value).toBe("25-34|male");
});
