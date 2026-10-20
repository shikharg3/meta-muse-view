import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { runCycle, isCycleRunning } from "@/sync/cycle";
import { requireAdmin, audit } from "./auth";

/** Synced tables holding an imported account's rows, keyed by `account_id`. */
const IMPORTED_CHILD_TABLES = [
  "campaigns",
  "ad_sets",
  "ads",
  "insights_daily",
  "insights_breakdown_daily",
] as const;

/**
 * Wipe every synced artifact (structure, insights, sync/token state) while keeping stored
 * credentials. sync_state removal puts every account at the front of the next refresh. Note that
 * `sync_checkpoints` is NOT cleared, so the backfill still considers history done: after a reset
 * only the trailing refresh window (28 days) comes back.
 *
 * CSV-imported accounts (an upload in `import_batches`) survive: they live in the same tables, but
 * the resync cannot restore them — the token cannot read those accounts at all. Their rows are
 * stashed in transaction-scoped temp tables, the truncate runs unchanged, and they are put back, all
 * in one transaction so a failure part-way never loses them. `import_batches` is not truncated.
 */
export async function wipeSyncedData(): Promise<void> {
  await db.transaction(async (tx) => {
    // One statement per execute: the driver runs parameterised queries, which cannot batch.
    await tx.execute(sql`
      create temp table keep_accounts on commit drop as
        select * from accounts where id in (select account_id from import_batches)
    `);
    for (const table of IMPORTED_CHILD_TABLES) {
      await tx.execute(sql`
        create temp table ${sql.identifier(`keep_${table}`)} on commit drop as
          select * from ${sql.identifier(table)}
          where account_id in (select id from keep_accounts)
      `);
    }
    await tx.execute(sql`
      truncate table
        accounts, campaigns, ad_sets, ads, ad_creatives,
        insights_daily, insights_breakdown_daily,
        sync_state, token_health
    `);
    for (const table of ["accounts", ...IMPORTED_CHILD_TABLES]) {
      await tx.execute(
        sql`insert into ${sql.identifier(table)} select * from ${sql.identifier(`keep_${table}`)}`,
      );
    }
  });
}

export interface ResetResult {
  ok: true;
  /** False when a cycle was already in flight in this process (wipe still happened). */
  syncStarted: boolean;
}

/** Wipe all synced data, then kick off a full resync in the background. */
export async function resetAndResync(): Promise<ResetResult> {
  await requireAdmin();
  await audit("sync.reset", "wiped all synced data and triggered a full resync");
  await wipeSyncedData();
  if (isCycleRunning()) return { ok: true, syncStarted: false };
  // `force`: a human clicked this. The restart cooldown exists to stop repeated AUTOMATIC sweeps,
  // not to override a deliberate instruction.
  void runCycle({ full: true, force: true }).catch((e) =>
    console.error("[reset] background resync failed:", e),
  );
  return { ok: true, syncStarted: true };
}

/** Kick a fresh CORE refresh (headline metrics, active accounts — fast) in the background; no wipe.
 *  The daily full pass still covers all metrics + breakdowns. Admin-only. */
export async function triggerSync(): Promise<{ ok: true; started: boolean }> {
  await requireAdmin();
  if (isCycleRunning()) return { ok: true, started: false };
  await audit("sync.manual", "triggered a manual core refresh");
  void runCycle({ full: false, force: true }).catch((e) =>
    console.error("[sync] manual core refresh failed:", e),
  );
  return { ok: true, started: true };
}
