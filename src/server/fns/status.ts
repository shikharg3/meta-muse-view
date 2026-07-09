import { sql, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireAdmin } from "./auth";
import { getRecentSyncEvents, getServiceHealth, type ServiceHealth } from "@/sync/state";
import { BACKFILL_DAYS, BREAKDOWN_BACKFILL_DAYS } from "@/sync/cycle";
import { normalizeTier, type AccessTier } from "@/meta/rate-limit";

export interface DatasetProgress {
  remainingChunks: number; // 90-day chunk-advances left to reach the retention floor
  deepest: string | null; // oldest date any account has reached
  shallowest: string | null; // oldest date the least-deep account has reached
  pctComplete: number; // 0-100, average coverage of the target window
}

export interface SyncEventView {
  at: string;
  kind: string;
  code: number;
  accountId: string | null;
  message: string;
  pressure: number | null;
  retryAfterMin: number | null;
}

export interface SyncStatusView {
  accounts: { total: number; structured: number; insighted: number; errored: number };
  refresh: { lastAt: string | null; oldestAt: string | null };
  backfill: { insights: DatasetProgress; breakdown: DatasetProgress };
  rateLimit: {
    eventsLast24h: number;
    tokenValid: boolean | null;
    tokenCheckedAt: string | null;
    tier: AccessTier | null;
  };
  notion: ServiceHealth | null;
  events: SyncEventView[];
  errors: { accountId: string; error: string; at: string | null }[];
}

interface ProgressRow {
  remaining: number;
  deepest: string | null;
  shallowest: string | null;
  pct: number;
}

export async function backfillProgress(
  prefix: string,
  targetDays: number,
): Promise<DatasetProgress> {
  const rows = (await db.execute(sql`
    SELECT
      coalesce(sum(greatest(0, ceil((backfilled_through - (current_date - ${targetDays}::int))::numeric / 90))), 0)::int AS remaining,
      min(backfilled_through)::text AS deepest,
      max(backfilled_through)::text AS shallowest,
      coalesce(avg(least(1, greatest(0, (current_date - backfilled_through))::numeric / ${targetDays}::int)), 0)::float AS pct
    FROM sync_checkpoints WHERE dataset LIKE ${prefix}
  `)) as unknown as ProgressRow[];
  const r = rows[0];
  return {
    remainingChunks: Number(r?.remaining ?? 0),
    deepest: r?.deepest ?? null,
    shallowest: r?.shallowest ?? null,
    pctComplete: Math.round(Number(r?.pct ?? 0) * 100),
  };
}

/** Aggregate sync health for the admin Sync page: coverage, refresh recency, backfill depth + ETA
 *  inputs, and the rate-limit picture. Admin-only. */
export async function fetchSyncStatus(): Promise<SyncStatusView> {
  await requireAdmin();

  const cov = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM accounts)::int AS total,
      (SELECT count(*) FROM sync_state WHERE last_structure_sync IS NOT NULL)::int AS structured,
      (SELECT count(*) FROM sync_state WHERE last_insights_sync IS NOT NULL)::int AS insighted,
      (SELECT count(*) FROM sync_state WHERE status = 'error')::int AS errored
  `)) as unknown as { total: number; structured: number; insighted: number; errored: number }[];

  const ref = (await db.execute(sql`
    SELECT max(last_insights_sync) AS last, min(last_insights_sync) AS oldest
    FROM sync_state WHERE last_insights_sync IS NOT NULL
  `)) as unknown as { last: Date | null; oldest: Date | null }[];

  const [insights, breakdown, events, token, errorRows] = await Promise.all([
    backfillProgress("insights:%", BACKFILL_DAYS),
    backfillProgress("breakdown:%", BREAKDOWN_BACKFILL_DAYS),
    getRecentSyncEvents(25),
    db
      .select({
        valid: schema.tokenHealth.isValid,
        at: schema.tokenHealth.checkedAt,
        tier: schema.tokenHealth.tier,
      })
      .from(schema.tokenHealth)
      .orderBy(desc(schema.tokenHealth.checkedAt))
      .limit(1),
    db.select().from(schema.syncState).where(eq(schema.syncState.status, "error")),
  ]);

  const dayAgo = Date.now() - 24 * 3_600_000;
  const c = cov[0];
  const r = ref[0];
  const notion = await getServiceHealth("notion");
  return {
    accounts: {
      total: Number(c?.total ?? 0),
      structured: Number(c?.structured ?? 0),
      insighted: Number(c?.insighted ?? 0),
      errored: Number(c?.errored ?? 0),
    },
    refresh: {
      lastAt: r?.last ? new Date(r.last).toISOString() : null,
      oldestAt: r?.oldest ? new Date(r.oldest).toISOString() : null,
    },
    backfill: { insights, breakdown },
    rateLimit: {
      eventsLast24h: events.filter((e) => e.at.getTime() >= dayAgo).length,
      tokenValid: token[0]?.valid ?? null,
      tokenCheckedAt: token[0]?.at ? token[0].at.toISOString() : null,
      tier: normalizeTier(token[0]?.tier ?? null),
    },
    notion,
    events: events.map((e) => ({
      at: e.at.toISOString(),
      kind: e.kind,
      code: e.code,
      accountId: e.accountId,
      message: e.message,
      pressure: e.pressure,
      retryAfterMin: e.retryAfterMin,
    })),
    errors: errorRows
      .filter((s) => s.lastError)
      .map((s) => ({
        accountId: s.accountId,
        error: s.lastError as string,
        at: (s.lastInsightsSync ?? s.lastStructureSync)?.toISOString() ?? null,
      })),
  };
}
