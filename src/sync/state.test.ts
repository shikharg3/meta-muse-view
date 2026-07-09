import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import {
  isFirstInsightsSync,
  markSync,
  recordTokenHealth,
  getCheckpoint,
  setCheckpoint,
  recordSyncEvent,
  getRecentSyncEvents,
  pruneSyncEvents,
  recordObservedTier,
  getStoredTier,
  recordServiceHealth,
  getServiceHealth,
} from "./state";
import type { InsightsClient } from "@/meta/types";

beforeEach(async () => {
  await db.execute(
    sql`truncate table sync_state, token_health, sync_checkpoints, sync_events, service_health cascade`,
  );
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

test("sync events round-trip newest-first and prune by age", async () => {
  const now = Date.now();
  await recordSyncEvent({
    kind: "rate_limit",
    code: 17,
    message: "User request limit reached",
    accountId: "act_1",
    retryAfterMin: 5,
    pressure: 96,
    at: now,
  });
  await recordSyncEvent({
    kind: "rate_limit",
    code: 4,
    message: "old throttle",
    accountId: "act_2",
    retryAfterMin: 0,
    pressure: 90,
    at: now - 10 * 86_400_000, // 10 days ago
  });
  const recent = await getRecentSyncEvents(10);
  expect(recent).toHaveLength(2);
  expect(recent[0].code).toBe(17); // newest first
  expect(recent[0].pressure).toBe(96);
  expect(recent[0].accountId).toBe("act_1");

  await pruneSyncEvents(7);
  const afterPrune = await getRecentSyncEvents(10);
  expect(afterPrune).toHaveLength(1); // the 10-day-old event is gone
  expect(afterPrune[0].code).toBe(17);
});

test("observed tier persists on the singleton row; a null observation never clobbers it", async () => {
  expect(await getStoredTier()).toBeNull(); // no row yet → unknown
  await recordTokenHealth({
    debugToken: async () => ({ is_valid: true, scopes: [] as string[] }),
  } as InsightsClient);
  expect(await getStoredTier()).toBeNull(); // row exists but tier not observed yet
  await recordObservedTier("standard_access");
  expect(await getStoredTier()).toBe("standard_access");
  await recordObservedTier(null); // a blank observation must preserve the last known tier
  expect(await getStoredTier()).toBe("standard_access");
});

test("service health round-trips and upserts one row per service", async () => {
  expect(await getServiceHealth("notion")).toBeNull(); // never run
  await recordServiceHealth("notion", false, "Notion 404: share the board");
  let h = await getServiceHealth("notion");
  expect(h?.ok).toBe(false);
  expect(h?.note).toBe("Notion 404: share the board");
  expect(h?.checkedAt).not.toBeNull();
  await recordServiceHealth("notion", true, null); // recovery upserts the same singleton row
  h = await getServiceHealth("notion");
  expect(h?.ok).toBe(true);
  expect(h?.note).toBeNull();
  expect(await getServiceHealth("other")).toBeNull(); // distinct service is independent
});
