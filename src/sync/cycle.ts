import { MetaClient } from "@/meta/client";
import { getCredentials } from "@/lib/credentials";
import { syncStructure, syncAccounts } from "./jobs/structure";
import { syncInsights } from "./jobs/insights";
import { syncBreakdowns, BREAKDOWNS } from "./jobs/breakdowns";
import { syncClients } from "./jobs/clients";
import { isFirstInsightsSync, markSync, recordTokenHealth } from "./state";
import { runOnce, type Jobs } from "./run";

// First sync of an account backfills as much history as Meta retains; later cycles
// only refresh the trailing edge. Meta caps plain insights at 37 months but
// breakdown queries at 13 months, so the two backfills use different ceilings.
export const BACKFILL_DAYS = 1125; // ~37 months: Meta's max insights retention
export const BREAKDOWN_BACKFILL_DAYS = 394; // 13 months: Meta's breakdown retention cap
export const INSIGHTS_REFRESH_DAYS = 28; // trailing refresh >= the 28-day attribution window
export const BREAKDOWN_REFRESH_DAYS = 28;

function buildJobs(): Jobs {
  // Cycle-scoped memo: insights marks the account synced before breakdowns runs,
  // so both jobs must observe the same first-run answer.
  const firstRun = new Map<string, boolean>();
  const isFirst = async (id: string): Promise<boolean> => {
    let v = firstRun.get(id);
    if (v === undefined) {
      v = await isFirstInsightsSync(id);
      firstRun.set(id, v);
    }
    return v;
  };
  return {
    structure: async (client, id) => {
      try {
        await syncStructure(client, id);
        await markSync(id, "structure", null);
      } catch (e) {
        await markSync(id, "structure", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    insights: async (client, id) => {
      try {
        for (const level of ["account", "campaign", "adset", "ad"] as const) {
          await syncInsights(client, id, {
            level,
            days: (await isFirst(id)) ? BACKFILL_DAYS : INSIGHTS_REFRESH_DAYS,
          });
        }
        await markSync(id, "insights", null);
      } catch (e) {
        await markSync(id, "insights", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    breakdowns: async (client, id) => {
      try {
        const days = (await isFirst(id)) ? BREAKDOWN_BACKFILL_DAYS : BREAKDOWN_REFRESH_DAYS;
        // Account-level powers the all-accounts/client Audiences view; campaign-level
        // is captured so a future per-campaign audience filter has data (phase 2).
        await syncBreakdowns(client, id, { breakdowns: [...BREAKDOWNS], days, level: "account" });
        await syncBreakdowns(client, id, { breakdowns: [...BREAKDOWNS], days, level: "campaign" });
      } catch (e) {
        await markSync(id, "insights", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
  };
}

let running = false;

/** True while a cycle started by this process is in flight. */
export function isCycleRunning(): boolean {
  return running;
}

/**
 * One full sync cycle (token health → per-account structure/insights/breakdowns).
 * Re-entrant safe within a process: overlapping calls are skipped. The hourly
 * worker and the web server are separate processes, so a concurrent run there is
 * possible but harmless — every job is an idempotent upsert.
 */
export async function runCycle(): Promise<void> {
  if (running) {
    console.warn("[sync] previous cycle still running; skipping this tick");
    return;
  }
  running = true;
  try {
    // Notion client board first: independent of Meta credentials and non-fatal.
    try {
      const n = await syncClients();
      if (n !== null) console.log(`[sync] notion clients: ${n}`);
    } catch (e) {
      console.error("[sync] notion clients failed:", e);
    }

    const creds = await getCredentials();
    if (!creds) {
      console.warn(
        "[sync] no credentials configured — set them on the Settings page; skipping cycle",
      );
      return;
    }
    const client = new MetaClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      token: creds.token,
      version: creds.apiVersion,
    });
    // Record token health up front so a deleted/expired app is captured even when
    // the account enumeration below throws (otherwise the badge stays stale-green).
    await recordTokenHealth(client);
    const owned = await syncAccounts(client, creds.businessId);
    const ids = creds.accountIds.length ? owned.filter((a) => creds.accountIds.includes(a)) : owned;
    console.log(`[sync] cycle: ${ids.length} accounts`);
    await runOnce({ client, accountIds: ids, jobs: buildJobs() });
    console.log("[sync] cycle done");
  } finally {
    running = false;
  }
}
