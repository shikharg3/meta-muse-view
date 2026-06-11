import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { runCycle, isCycleRunning } from "@/sync/cycle";

/**
 * Wipe every synced artifact (structure, insights, sync/token state) while
 * keeping stored credentials. sync_state removal makes the next cycle treat
 * every account as a first run, i.e. a full 90-day backfill.
 */
export async function wipeSyncedData(): Promise<void> {
  await db.execute(sql`
    truncate table
      accounts, campaigns, ad_sets, ads, ad_creatives,
      insights_daily, insights_breakdown_daily,
      sync_state, token_health
  `);
}

export interface ResetResult {
  ok: true;
  /** False when a cycle was already in flight in this process (wipe still happened). */
  syncStarted: boolean;
}

/** Wipe all synced data, then kick off a full resync in the background. */
export async function resetAndResync(): Promise<ResetResult> {
  await wipeSyncedData();
  if (isCycleRunning()) return { ok: true, syncStarted: false };
  void runCycle().catch((e) => console.error("[reset] background resync failed:", e));
  return { ok: true, syncStarted: true };
}
