import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { backfillStep, orderUnsyncedFirst } from "./cycle";
import { getCheckpoint } from "./state";
import { addDays } from "@/lib/range";

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
