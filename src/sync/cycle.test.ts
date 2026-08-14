import { test, expect, beforeEach } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import {
  backfillStep,
  orderUnsyncedFirst,
  buildRefreshJobs,
  backfillAccount,
  mapPool,
  refreshAccountIds,
  runCycle,
  MIN_CYCLE_GAP_MS,
} from "./cycle";
import { getCheckpoint, recordServiceHealth, msSinceLastCycle } from "./state";
import { addDays } from "@/lib/range";
import { fakeInsightsClient } from "@/meta/fake-client";

beforeEach(async () => {
  await db.execute(sql`truncate table sync_checkpoints cascade`);
});

test("backfillStep walks one chunk older per call and records the checkpoint", async () => {
  const today = new Date("2026-06-16T00:00:00Z");
  const windows: { since: string; until: string }[] = [];
  const run = async (since: string, until: string) => {
    windows.push({ since, until });
  };

  // First call (no checkpoint): window ends yesterday, spans one 90-day chunk.
  await backfillStep("act_1", "insights:account", 1125, today, run);
  expect(windows[0].until).toBe("2026-06-15");
  expect(windows[0].since).toBe(addDays("2026-06-15", -89));
  expect((await getCheckpoint("act_1", "insights:account"))?.backfilledThrough).toBe(
    windows[0].since,
  );

  // Second call resumes from the checkpoint, one day older.
  await backfillStep("act_1", "insights:account", 1125, today, run);
  expect(windows[1].until).toBe(addDays(windows[0].since, -1));
});

test("backfillStep clamps the oldest window to the retention floor", async () => {
  const today = new Date("2026-06-16T00:00:00Z");
  const windows: { since: string; until: string }[] = [];
  const run = async (since: string, until: string) => {
    windows.push({ since, until });
  };
  // maxDays=5 → floor = today-4 = 2026-06-12; the chunk is clamped to it.
  await backfillStep("act_2", "insights:ad", 5, today, run);
  expect(windows[0]).toEqual({ since: "2026-06-12", until: "2026-06-15" });
  // Once backfilled through the floor, further calls are no-ops.
  await backfillStep("act_2", "insights:ad", 5, today, run);
  expect(windows).toHaveLength(1);
});

test("orderUnsyncedFirst puts never-structured accounts first, preserving order within groups", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const structured = new Set(["a", "c", "e"]); // b and d were just added
  expect(orderUnsyncedFirst(ids, structured)).toEqual(["b", "d", "a", "c", "e"]);
});

test("orderUnsyncedFirst is a no-op when every account is already synced", () => {
  const ids = ["a", "b", "c"];
  expect(orderUnsyncedFirst(ids, new Set(ids))).toEqual(ids);
});

test("buildRefreshJobs insights job does NOT advance backfill checkpoints", async () => {
  await buildRefreshJobs(false).insights(fakeInsightsClient(), "act_rf");
  const rows = await db
    .select()
    .from(schema.syncCheckpoints)
    .where(eq(schema.syncCheckpoints.accountId, "act_rf"));
  expect(rows).toHaveLength(0); // refresh never touches the backfill checkpoints
});

test("buildRefreshJobs(false) refreshes CORE metrics only; full refreshes every group", async () => {
  const callsFor = async (full: boolean) => {
    let calls = 0;
    const client = fakeInsightsClient({
      getInsights: async () => {
        calls++;
        return [];
      },
    });
    await buildRefreshJobs(full).insights(client, "act_x");
    return calls;
  };
  const core = await callsFor(false);
  const all = await callsFor(true);
  expect(core).toBeGreaterThan(0);
  expect(all).toBeGreaterThan(core * 3); // the full refresh pulls far more metric groups
}, 20000);

test("backfillAccount advances a checkpoint for every insight level + breakdown", async () => {
  await backfillAccount(fakeInsightsClient(), "act_bf", new Date("2026-06-16T00:00:00Z"));
  const datasets = (
    await db
      .select()
      .from(schema.syncCheckpoints)
      .where(eq(schema.syncCheckpoints.accountId, "act_bf"))
  )
    .map((r) => r.dataset)
    .sort();
  expect(datasets).toEqual([
    "breakdown:account",
    "breakdown:campaign",
    "insights:account",
    "insights:ad",
    "insights:adset",
    "insights:campaign",
  ]);
});

test("mapPool processes every item and never exceeds the concurrency bound", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const seen: number[] = [];
  let active = 0;
  let peak = 0;
  await mapPool(items, 3, async (i) => {
    active++;
    peak = Math.max(peak, active);
    seen.push(i);
    await Promise.resolve();
    active--;
  });
  expect(seen.sort((a, b) => a - b)).toEqual(items);
  expect(peak).toBe(3);
});

test("refreshAccountIds skips synced disabled accounts on core, keeps everything on full", () => {
  const ordered = ["active1", "disabledSynced", "disabledNew", "active2"];
  const disabled = new Set(["disabledSynced", "disabledNew"]);
  const structured = new Set(["active1", "disabledSynced", "active2"]); // disabledNew never synced
  // Core pass: drop the already-synced disabled account, but keep the never-synced disabled one
  // (it still needs its first sync) and all active accounts.
  expect(refreshAccountIds(ordered, disabled, structured, false)).toEqual([
    "active1",
    "disabledNew",
    "active2",
  ]);
  // Full pass: refresh everything.
  expect(refreshAccountIds(ordered, disabled, structured, true)).toEqual(ordered);
});

test("backfillStep clamps the floor to the account created date (no walk into empty months)", async () => {
  const today = new Date("2026-07-05T00:00:00Z");
  const windows: { since: string; until: string }[] = [];
  const run = async (since: string, until: string) => {
    windows.push({ since, until });
  };
  const created = "2026-06-05"; // 30 days before today; retention target is 1125 days
  await backfillStep("act_c", "insights:account", 1125, today, run, created);
  await backfillStep("act_c", "insights:account", 1125, today, run, created);
  expect(windows).toHaveLength(1); // one 30-day chunk, then done — not ~13 chunks to the 37mo floor
  expect(windows[0].since).toBe(created); // stopped at creation date, not the retention floor
});
test("a restart cannot re-trigger a sweep inside the cooldown, and the clock survives it", async () => {
  // The suspension trigger: six deploys in 2.5h, each restarting the worker, each firing a fresh
  // sweep of every account. An in-process timer cannot stop that — the timestamp has to be in the
  // database, because the process is what restarted.
  await db.execute(sql`truncate table service_health cascade`);
  await recordServiceHealth("sync-cycle", true, "core: running");

  const since = await msSinceLastCycle("sync-cycle");
  expect(since).not.toBeNull();
  expect(since!).toBeLessThan(MIN_CYCLE_GAP_MS);

  // A fresh process calling runCycle() must decline before it reaches any Meta work, leaving the
  // recorded note exactly as it was.
  await runCycle();
  const [held] = await db
    .select()
    .from(schema.serviceHealth)
    .where(eq(schema.serviceHealth.service, "sync-cycle"));
  expect(held.note).toBe("core: running");

  // Deliberate human action still gets through.
  await runCycle({ force: true });
  const [forced] = await db
    .select()
    .from(schema.serviceHealth)
    .where(eq(schema.serviceHealth.service, "sync-cycle"));
  expect(forced.note).not.toBe("core: running");
});

test("the cooldown lapses once the gap has passed", async () => {
  await db.execute(sql`truncate table service_health cascade`);
  await recordServiceHealth("sync-cycle", true, "core: completed");
  await db
    .update(schema.serviceHealth)
    .set({ checkedAt: new Date(Date.now() - MIN_CYCLE_GAP_MS - 60_000) })
    .where(eq(schema.serviceHealth.service, "sync-cycle"));

  const since = await msSinceLastCycle("sync-cycle");
  expect(since!).toBeGreaterThan(MIN_CYCLE_GAP_MS);

  await runCycle();
  const [ran] = await db
    .select()
    .from(schema.serviceHealth)
    .where(eq(schema.serviceHealth.service, "sync-cycle"));
  expect(ran.note).not.toBe("core: completed");
});
