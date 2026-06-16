import { MetaClient } from "@/meta/client";
import { db, schema } from "@/db/client";
import { Limiter } from "@/meta/limiter";
import { getCredentials } from "@/lib/credentials";
import { syncStructure, syncAccounts } from "./jobs/structure";
import { syncInsights, syncInsightsRange } from "./jobs/insights";
import { syncBreakdowns } from "./jobs/breakdowns";
import { BREAKDOWN_GROUPS } from "@/meta/fieldsets";
import { addDays } from "@/lib/range";
import { syncClients } from "./jobs/clients";
import { syncEdges, syncActivities } from "./jobs/objects";
import {
  markSync,
  recordTokenHealth,
  getFieldBlocklist,
  saveFieldBlocklist,
  getCheckpoint,
  setCheckpoint,
} from "./state";
import { runOnce, type Jobs } from "./run";
import { detectSpendDropAlerts } from "./alerts";

// First sync of an account backfills as much history as Meta retains; later cycles
// only refresh the trailing edge. Meta caps plain insights at 37 months but
// breakdown queries at 13 months, so the two backfills use different ceilings.
export const BACKFILL_DAYS = 1125; // ~37 months: Meta's max insights retention
export const BREAKDOWN_BACKFILL_DAYS = 394; // 13 months: Meta's breakdown retention cap
export const INSIGHTS_REFRESH_DAYS = 28; // trailing refresh >= the 28-day attribution window
export const BREAKDOWN_REFRESH_DAYS = 28;

const BACKFILL_CHUNK = 90;
const LEVELS = ["account", "campaign", "adset", "ad"] as const;

/**
 * Advance one dataset's historical backfill by a single chunk, resuming from a persisted
 * checkpoint. Bounding each cycle to one chunk per dataset means every account is touched every
 * cycle (rate-limited early accounts don't starve later ones) and history fills in resumably.
 */
export async function backfillStep(
  accountId: string,
  dataset: string,
  maxDays: number,
  today: Date,
  run: (since: string, until: string) => Promise<unknown>,
): Promise<void> {
  const todayYmd = today.toISOString().slice(0, 10);
  const floor = addDays(todayYmd, -(maxDays - 1));
  const cp = await getCheckpoint(accountId, dataset);
  const doneThrough = cp?.backfilledThrough ?? todayYmd;
  if (doneThrough <= floor) return; // fully backfilled
  const until = addDays(doneThrough, -1);
  const cand = addDays(until, -(BACKFILL_CHUNK - 1));
  const since = cand < floor ? floor : cand;
  await run(since, until);
  await setCheckpoint(accountId, dataset, { backfilledThrough: since });
}
function buildJobs(): Jobs {
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
        const today = new Date();
        for (const level of LEVELS) {
          await syncInsights(client, id, { level, days: INSIGHTS_REFRESH_DAYS });
          await backfillStep(id, `insights:${level}`, BACKFILL_DAYS, today, (s, u) =>
            syncInsightsRange(client, id, level, s, u),
          );
        }
        await markSync(id, "insights", null);
      } catch (e) {
        await markSync(id, "insights", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    breakdowns: async (client, id) => {
      try {
        const today = new Date();
        // Asset breakdowns are ad-level only + very high cardinality → refresh window only.
        const asset = BREAKDOWN_GROUPS.filter((g) => g[0].endsWith("_asset"));
        const standard = BREAKDOWN_GROUPS.filter((g) => !g[0].endsWith("_asset"));
        for (const level of ["account", "campaign"] as const) {
          await syncBreakdowns(client, id, {
            groups: standard,
            days: BREAKDOWN_REFRESH_DAYS,
            level,
          });
          await backfillStep(id, `breakdown:${level}`, BREAKDOWN_BACKFILL_DAYS, today, (s, u) =>
            syncBreakdowns(client, id, { groups: standard, level, since: s, until: u }),
          );
        }
        await syncBreakdowns(client, id, {
          groups: asset,
          days: BREAKDOWN_REFRESH_DAYS,
          level: "ad",
        });
      } catch (e) {
        await markSync(id, "insights", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    objects: async (client, id) => {
      // Reference objects + change history are supplementary; per-edge errors are already
      // isolated inside the jobs, so a failure here never fails the account's core sync.
      try {
        await syncEdges(client, id);
        await syncActivities(client, id, { days: 90 });
      } catch (e) {
        console.error(`[sync] objects ${id} failed:`, e instanceof Error ? e.message : e);
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
    const client = new MetaClient(
      {
        appId: creds.appId,
        appSecret: creds.appSecret,
        token: creds.token,
        version: creds.apiVersion,
      },
      // Pace all requests: the full-field/full-metric extraction is request-heavy, so a single
      // in-flight call every 250ms keeps us under Meta's user/app limits (#17/#4).
      {
        limiter: new Limiter(1, 250),
        // Persist discovered bad-field sets so the costly bisection discovery runs once, not per restart.
        fieldStore: { load: getFieldBlocklist, save: saveFieldBlocklist },
      },
    );
    // Record token health up front so a deleted/expired app is captured even when
    // the account enumeration below throws (otherwise the badge stays stale-green).
    await recordTokenHealth(client);
    // Account enumeration can hit a transient rate limit (#80004); fall back to the accounts
    // already known in the DB so a throttled getAccounts doesn't abort the whole cycle.
    let owned: string[];
    try {
      owned = await syncAccounts(client, creds.businessId);
    } catch (e) {
      console.error(
        "[sync] account enumeration failed; using known DB accounts:",
        e instanceof Error ? e.message : e,
      );
      owned = (await db.select({ id: schema.accounts.id }).from(schema.accounts)).map((r) => r.id);
    }
    const ids = creds.accountIds.length ? owned.filter((a) => creds.accountIds.includes(a)) : owned;
    console.log(`[sync] cycle: ${ids.length} accounts`);
    await runOnce({ client, accountIds: ids, jobs: buildJobs() });
    try {
      const n = await detectSpendDropAlerts();
      if (n > 0) console.log(`[sync] alerts: ${n} new spend-drop alert(s)`);
    } catch (e) {
      console.error("[sync] alert detection failed:", e);
    }
    console.log("[sync] cycle done");
  } finally {
    running = false;
  }
}
