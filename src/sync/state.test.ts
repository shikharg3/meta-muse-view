import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { markSync, recordTokenHealth } from "./state";
import type { InsightsClient } from "@/meta/types";

beforeEach(async () => {
  await db.execute(sql`truncate table sync_state, token_health cascade`);
});

test("markSync upserts per-account status", async () => {
  await markSync("act_1", "structure", null);
  await markSync("act_1", "insights", "boom");
  const rows = await db.select().from(schema.syncState);
  expect(rows).toHaveLength(1);
  expect(rows[0].lastError).toBe("boom");
  expect(rows[0].lastStructureSync).not.toBeNull();
  expect(rows[0].lastInsightsSync).not.toBeNull();
});

test("recordTokenHealth stores debug_token result", async () => {
  const client = { debugToken: async () => ({ is_valid: true, scopes: ["ads_read"] }) } as InsightsClient;
  await recordTokenHealth(client);
  const rows = await db.select().from(schema.tokenHealth);
  expect(rows[0].isValid).toBe(true);
  expect(rows[0].scopes).toEqual(["ads_read"]);
});
