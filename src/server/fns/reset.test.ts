import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { wipeSyncedData } from "./reset";

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      accounts, campaigns, ad_sets, ads, insights_daily, insights_breakdown_daily, sync_state,
      token_health, meta_credentials, import_batches cascade
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

test("wipeSyncedData keeps CSV-imported accounts and their rows", async () => {
  // The resync cannot restore an imported account (the token cannot read it), so the wipe must not
  // destroy it — while the Meta account beside it is still wiped as before.
  await db.insert(schema.accounts).values([
    { id: "act_meta", name: "Meta" },
    { id: "act_imp", name: "Imported" },
  ]);
  // An upload is what makes an account imported; its `source` stays 'meta' like any other.
  await db.insert(schema.importBatches).values({
    id: "b1",
    accountId: "act_imp",
    fileSha256: "x",
    dateFrom: "2026-06-01",
    dateTo: "2026-06-01",
    rowsByLevel: { account: 1, campaign: 0, adset: 0, ad: 0 },
    spend: 42,
    uploadedBy: "test",
  });
  await db.insert(schema.campaigns).values([
    { id: "c_meta", accountId: "act_meta", name: "M" },
    { id: "c_imp", accountId: "act_imp", name: "I" },
  ]);
  await db.insert(schema.insightsDaily).values([
    { level: "account", entityId: "act_meta", date: "2026-06-01", accountId: "act_meta" },
    { level: "account", entityId: "act_imp", date: "2026-06-01", accountId: "act_imp", spend: 42 },
  ]);

  await wipeSyncedData();

  const accounts = await db.select().from(schema.accounts);
  expect(accounts.map((a) => [a.id, a.source])).toEqual([["act_imp", "meta"]]);
  expect((await db.select().from(schema.campaigns)).map((c) => c.id)).toEqual(["c_imp"]);
  const insights = await db.select().from(schema.insightsDaily);
  expect(insights.map((i) => [i.entityId, i.spend])).toEqual([["act_imp", 42]]);
}, 30000);
