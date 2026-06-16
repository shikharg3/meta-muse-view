import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import {
  isFirstInsightsSync,
  markSync,
  recordTokenHealth,
  getCheckpoint,
  setCheckpoint,
} from "./state";
import type { InsightsClient } from "@/meta/types";

beforeEach(async () => {
  await db.execute(sql`truncate table sync_state, token_health, sync_checkpoints cascade`);
});

test("markSync advances a phase timestamp only on success", async () => {
  await markSync("act_1", "structure", null);
  await markSync("act_1", "insights", "boom");
  const [row] = await db.select().from(schema.syncState);
  expect(row.status).toBe("error");
  expect(row.lastError).toBe("boom");
  expect(row.lastStructureSync).not.toBeNull();
  expect(row.lastInsightsSync).toBeNull();
});

test("recordTokenHealth stores debug_token result", async () => {
  const client = {
    debugToken: async () => ({ is_valid: true, scopes: ["ads_read"] }),
  } as InsightsClient;
  await recordTokenHealth(client);
  const rows = await db.select().from(schema.tokenHealth);
  expect(rows[0].isValid).toBe(true);
  expect(rows[0].scopes).toEqual(["ads_read"]);
});

test("isFirstInsightsSync flips only after a successful insights sync", async () => {
  expect(await isFirstInsightsSync("act_1")).toBe(true);
  await markSync("act_1", "structure", null);
  expect(await isFirstInsightsSync("act_1")).toBe(true);
  await markSync("act_1", "insights", "boom");
  expect(await isFirstInsightsSync("act_1")).toBe(true);
  await markSync("act_1", "insights", null);
  expect(await isFirstInsightsSync("act_1")).toBe(false);
}, 20000);

test("checkpoints round-trip and patch only provided fields", async () => {
  expect(await getCheckpoint("act_1", "insights:ad")).toBeNull();
  await setCheckpoint("act_1", "insights:ad", { backfilledThrough: "2025-01-01" });
  expect(await getCheckpoint("act_1", "insights:ad")).toEqual({
    backfilledThrough: "2025-01-01",
    cursor: null,
  });
  // Patching cursor must not clobber the existing backfilledThrough.
  await setCheckpoint("act_1", "insights:ad", { cursor: "run_42" });
  expect(await getCheckpoint("act_1", "insights:ad")).toEqual({
    backfilledThrough: "2025-01-01",
    cursor: "run_42",
  });
}, 20000);
