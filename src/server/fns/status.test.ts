import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { backfillProgress } from "./status";

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

beforeEach(async () => {
  await db.execute(sql`truncate table sync_checkpoints cascade`);
});

test("backfillProgress reports remaining chunks + percent from a checkpoint", async () => {
  await db.insert(schema.syncCheckpoints).values({
    accountId: "act_1",
    dataset: "insights:account",
    backfilledThrough: daysAgo(90), // 90 days of history captured, target 1125
  });
  const p = await backfillProgress("insights:%", 1125);
  expect(p.remainingChunks).toBe(12); // ceil((1125 - 90) / 90)
  expect(p.pctComplete).toBe(8); // round(90 / 1125 * 100)
  expect(p.shallowest).toBe(daysAgo(90));
});

test("backfillProgress is complete (0 left, 100%) once at/under the retention floor", async () => {
  await db.insert(schema.syncCheckpoints).values({
    accountId: "act_1",
    dataset: "insights:account",
    backfilledThrough: daysAgo(1200), // past the 1125-day floor
  });
  const p = await backfillProgress("insights:%", 1125);
  expect(p.remainingChunks).toBe(0);
  expect(p.pctComplete).toBe(100);
});
