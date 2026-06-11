import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { wipeSyncedData } from "./reset";

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      accounts, campaigns, insights_daily, sync_state, token_health, meta_credentials cascade
  `);
});

test("wipeSyncedData clears synced data but keeps credentials", async () => {
  await db.insert(schema.accounts).values({ id: "act_1", name: "A" });
  await db.insert(schema.campaigns).values({ id: "c1", accountId: "act_1", name: "C" });
  await db.insert(schema.insightsDaily).values({
    level: "account",
    entityId: "act_1",
    date: "2026-06-01",
    accountId: "act_1",
  });
  await db.insert(schema.syncState).values({ accountId: "act_1", status: "ok" });
  await db.insert(schema.tokenHealth).values({ id: "singleton", isValid: true });
  await db.insert(schema.metaCredentials).values({ id: "singleton", appId: "123" });

  await wipeSyncedData();

  expect(await db.select().from(schema.accounts)).toHaveLength(0);
  expect(await db.select().from(schema.campaigns)).toHaveLength(0);
  expect(await db.select().from(schema.insightsDaily)).toHaveLength(0);
  expect(await db.select().from(schema.syncState)).toHaveLength(0);
  expect(await db.select().from(schema.tokenHealth)).toHaveLength(0);
  const creds = await db.select().from(schema.metaCredentials);
  expect(creds).toHaveLength(1);
  expect(creds[0].appId).toBe("123");
}, 30000);
