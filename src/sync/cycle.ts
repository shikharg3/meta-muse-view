import { MetaClient } from "@/meta/client";
import type { InsightsClient } from "@/meta/types";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { Limiter } from "@/meta/limiter";
import { pacingFor, normalizeTier } from "@/meta/rate-limit";
import { getCredentials } from "@/lib/credentials";
import { syncStructure, syncAccounts } from "./jobs/structure";
import { syncInsights, syncInsightsRange } from "./jobs/insights";
import { syncBreakdowns } from "./jobs/breakdowns";
import { BREAKDOWN_GROUPS, CORE_METRICS } from "@/meta/fieldsets";
import { accountStatus } from "@/server/agg";
import { addDays } from "@/lib/range";
import { syncClients } from "./jobs/clients";
import { syncEdges, syncActivities, syncLeadForms } from "./jobs/objects";
import {
  markSync,
  recordTokenHealth,
  getFieldBlocklist,
  saveFieldBlocklist,
  getCheckpoint,
  setCheckpoint,
  getStructuredAccountIds,
  recordSyncEvent,
  pruneSyncEvents,
  recordObservedTier,
  getStoredTier,
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
const STANDARD_BREAKDOWN_GROUPS = BREAKDOWN_GROUPS.filter((g) => !g[0].endsWith("_asset"));
const ASSET_BREAKDOWN_GROUPS = BREAKDOWN_GROUPS.filter((g) => g[0].endsWith("_asset"));

/**
 * Order accounts so never-structured ones (e.g. just added to the system user) come first,
 * preserving enumeration order within each group. The cycle is sequential and rate-limited, so a
 * new account placed at the back of the queue can be starved for a full cycle; front-loading it
 * guarantees it gets baseline structure + insights right away.
 */
export function orderUnsyncedFirst(ids: string[], structured: Set<string>): string[] {
  const fresh = ids.filter((id) => !structured.has(id));
  const rest = ids.filter((id) => structured.has(id));
  return [...fresh, ...rest];
}

/**
 * Accounts to refresh this cycle. On the hourly CORE pass, already-synced DISABLED accounts are
 * skipped — a disabled account produces no new data, its history is finished by the backfill, and
 * the enumeration keeps its status current so it rejoins instantly if re-enabled. The daily FULL
 * pass still refreshes everything (catches post-disablement attribution settling).
 */
export function refreshAccountIds(
  ordered: string[],
  disabled: Set<string>,
  structured: Set<string>,
  full: boolean,
): string[] {
  if (full) return ordered;
  return ordered.filter((id) => !(disabled.has(id) && structured.has(id)));
}

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
  floorDate?: string, // account creation date; backfill never walks older than this
): Promise<boolean> {
  const todayYmd = today.toISOString().slice(0, 10);
  // Don't backfill older than the account existed: clamp the retention floor to the account's
  // creation date so a brand-new account finishes in ~1 chunk instead of walking empty months.
  const retentionFloor = addDays(todayYmd, -(maxDays - 1));
  const floor = floorDate && floorDate > retentionFloor ? floorDate : retentionFloor;
  const cp = await getCheckpoint(accountId, dataset);
  const doneThrough = cp?.backfilledThrough ?? todayYmd;
  if (doneThrough <= floor) return false; // fully backfilled
  const until = addDays(doneThrough, -1);
  const cand = addDays(until, -(BACKFILL_CHUNK - 1));
  const since = cand < floor ? floor : cand;
  await run(since, until);
  await setCheckpoint(accountId, dataset, { backfilledThrough: since });
  return true;
}
/** Build a MetaClient from stored creds with the given limiter (refresh and backfill differ). */
function buildClient(
  creds: { appId: string; appSecret: string; token: string; apiVersion: string },
  limiter: Limiter,
): MetaClient {
  return new MetaClient(
    {
      appId: creds.appId,
      appSecret: creds.appSecret,
      token: creds.token,
      version: creds.apiVersion,
    },
    {
      limiter,
      // Persist discovered bad-field sets so the costly bisection discovery runs once per restart.
      fieldStore: { load: getFieldBlocklist, save: saveFieldBlocklist },
      // Persist rate-limit/throttle events so admins can see when (and why) the API pushes back.
      onEvent: (e) => void recordSyncEvent(e).catch(() => {}),
    },
  );
}

/**
 * Refresh jobs (no historical backfill — that's runBackfillCycle). `full=false` (hourly) pulls only
 * the CORE KPI metrics and skips breakdowns, so it finishes fast; `full=true` (daily, and manual
 * Sync-now / reset) pulls every metric group + breakdowns. Either way the dashboard KPIs stay fresh.
 */
export function buildRefreshJobs(full: boolean): Jobs {
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
      // CORE metrics every hour (fast); the full 219-metric set only on the daily `full` pass.
      const groups = full ? undefined : [CORE_METRICS];
      try {
        for (const level of LEVELS) {
          await syncInsights(client, id, { level, days: INSIGHTS_REFRESH_DAYS, groups });
        }
        await markSync(id, "insights", null);
      } catch (e) {
        await markSync(id, "insights", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    breakdowns: async (client, id) => {
      if (!full) return; // breakdowns refresh on the daily full pass only (they power Audiences)
      try {
        for (const level of ["account", "campaign"] as const) {
          await syncBreakdowns(client, id, {
            groups: STANDARD_BREAKDOWN_GROUPS,
            days: BREAKDOWN_REFRESH_DAYS,
            level,
          });
        }
        // Asset breakdowns are ad-level only + very high cardinality → refresh window only.
        await syncBreakdowns(client, id, {
          groups: ASSET_BREAKDOWN_GROUPS,
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
        await syncLeadForms(client, id);
      } catch (e) {
        console.error(`[sync] objects ${id} failed:`, e instanceof Error ? e.message : e);
      }
    },
  };
}

/** Advance one chunk of every historical dataset (insights ×4 levels, breakdowns ×2) for one
 *  account. Insight history uses async report runs so it lands on Meta's async budget. */
export async function backfillAccount(
  client: InsightsClient,
  id: string,
  today: Date,
): Promise<boolean> {
  // Clamp the backfill floor to when the account was created — no point walking empty months
  // before it existed (a week-old account then finishes in ~1 chunk instead of days).
  const [acct] = await db
    .select({ created: schema.accounts.createdTime })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id));
  const createdDate = acct?.created ? acct.created.toISOString().slice(0, 10) : undefined;
  let advanced = false;
  for (const level of LEVELS) {
    if (
      await backfillStep(
        id,
        `insights:${level}`,
        BACKFILL_DAYS,
        today,
        (s, u) => syncInsightsRange(client, id, level, s, u, false, true),
        createdDate,
      )
    )
      advanced = true;
  }
  for (const level of ["account", "campaign"] as const) {
    if (
      await backfillStep(
        id,
        `breakdown:${level}`,
        BREAKDOWN_BACKFILL_DAYS,
        today,
        (s, u) =>
          syncBreakdowns(client, id, {
            groups: STANDARD_BREAKDOWN_GROUPS,
            level,
            since: s,
            until: u,
          }),
        createdDate,
      )
    )
      advanced = true;
  }
  return advanced;
}

/** Bounded-concurrency map: `n` workers pull from a shared queue until it drains. */
export async function mapPool<T>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
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
export async function runCycle(opts: { full?: boolean } = {}): Promise<void> {
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
    // Size pacing from the last observed access tier (persisted). Unknown/dev → conservative.
    const pacing = pacingFor(normalizeTier(await getStoredTier()));
    const client = buildClient(
      creds,
      new Limiter(pacing.refresh.concurrency, pacing.refresh.intervalMs),
    );
    // Record token health up front so a deleted/expired app is captured even when
    // the account enumeration below throws (otherwise the badge stays stale-green).
    // If the token is invalid/expired, ABORT loudly instead of running a hollow cycle that writes
    // no data yet reports success (that masked a ~13-day outage). token_health reflects it too.
    if (!(await recordTokenHealth(client))) {
      console.error(
        "[sync] token invalid/expired — aborting cycle (fix Meta credentials on Settings). No data was refreshed.",
      );
      return;
    }
    // Keep the API event log bounded — it's a recent-activity view, not an audit trail.
    await pruneSyncEvents().catch((e) => console.error("[sync] prune events failed:", e));
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
    const structured = await getStructuredAccountIds();
    const ordered = orderUnsyncedFirst(ids, structured);
    // Skip already-synced disabled accounts on the hourly CORE refresh: they produce no new data,
    // the backfill finishes their history, and the enumeration above keeps status current so they
    // rejoin instantly when re-enabled. The daily FULL pass still refreshes them.
    const disabled = opts.full
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ id: schema.accounts.id, status: schema.accounts.status })
              .from(schema.accounts)
          )
            .filter((a) => accountStatus(a.status) === "DISABLED")
            .map((a) => a.id),
        );
    const refreshIds = refreshAccountIds(ordered, disabled, structured, opts.full ?? false);
    const fresh = refreshIds.reduce((n, id) => (structured.has(id) ? n : n + 1), 0);
    const skipped = ordered.length - refreshIds.length;
    console.log(
      `[sync] ${opts.full ? "full" : "core"} refresh: ${refreshIds.length} accounts ` +
        `(${fresh} never synced → first${skipped ? `, ${skipped} disabled skipped` : ""})`,
    );
    await runOnce({ client, accountIds: refreshIds, jobs: buildRefreshJobs(opts.full ?? false) });
    // Persist the tier seen on this cycle's live headers so the next cycle sizes pacing correctly
    // (a downgrade after an app swap pulls concurrency back down automatically).
    await recordObservedTier(client.observedTier());
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

/**
 * Advance the historical backfill for every known account in bounded parallel
 * (tier-sized concurrency). Runs separately from the hourly refresh so deep history never delays
 * recent data, and stops at `deadlineMs` (the worker passes the time left until the next refresh).
 * Uses a wider-concurrency limiter than the refresh to overlap the async report polling latency.
 */
export async function runBackfillCycle(deadlineMs?: number): Promise<void> {
  const creds = await getCredentials();
  if (!creds) return;
  const pacing = pacingFor(normalizeTier(await getStoredTier()));
  const client = buildClient(creds, new Limiter(pacing.backfill.http, pacing.backfill.intervalMs));
  const ids = (await db.select({ id: schema.accounts.id }).from(schema.accounts)).map((r) => r.id);
  const pastDeadline = (): boolean => deadlineMs !== undefined && Date.now() >= deadlineMs;
  // Advance every account by one chunk per pass, looping until nothing is left to backfill or the
  // deadline hits (each pass no-ops cheaply for already-complete accounts). Parallel metric groups
  // + the wider limiter make a pass fast, so full history clears in a few passes instead of one
  // chunk per hourly cycle.
  let advanced = true;
  while (advanced && !pastDeadline()) {
    advanced = false;
    const today = new Date();
    await mapPool(ids, pacing.backfill.accounts, async (id) => {
      if (pastDeadline()) return;
      try {
        if (await backfillAccount(client, id, today)) advanced = true;
      } catch (e) {
        console.error(`[backfill] ${id} failed:`, e instanceof Error ? e.message : e);
      }
    });
  }
  await recordObservedTier(client.observedTier());
}
