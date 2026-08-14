import { and, eq, isNotNull, desc, lt } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { InsightsClient, MetaApiEvent } from "@/meta/types";

type Phase = "structure" | "insights";

/** True until the account completes its first insights sync (drives the initial backfill). */
export async function isFirstInsightsSync(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ last: schema.syncState.lastInsightsSync })
    .from(schema.syncState)
    .where(eq(schema.syncState.accountId, accountId));
  return !row?.last;
}

/**
 * Account ids that have completed at least one structure sync. Used to push never-synced
 * accounts (e.g. newly added ones) to the front of the cycle so they get baseline data
 * immediately instead of waiting behind every existing account's refresh.
 */
export async function getStructuredAccountIds(): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.syncState.accountId })
    .from(schema.syncState)
    .where(isNotNull(schema.syncState.lastStructureSync));
  return new Set(rows.map((r) => r.id));
}

export async function markSync(
  accountId: string,
  phase: Phase,
  error: string | null,
): Promise<void> {
  const ok = error === null;
  const stamp = new Date();
  const advanceStructure = ok && phase === "structure";
  const advanceInsights = ok && phase === "insights";
  const insertVals = {
    accountId,
    status: ok ? "ok" : "error",
    lastError: error,
    lastStructureSync: advanceStructure ? stamp : null,
    lastInsightsSync: advanceInsights ? stamp : null,
  };
  await db
    .insert(schema.syncState)
    .values(insertVals)
    .onConflictDoUpdate({
      target: schema.syncState.accountId,
      set: {
        status: insertVals.status,
        lastError: insertVals.lastError,
        ...(advanceStructure ? { lastStructureSync: stamp } : {}),
        ...(advanceInsights ? { lastInsightsSync: stamp } : {}),
      },
    });
}

export async function recordTokenHealth(client: InsightsClient): Promise<boolean> {
  let isValid = false;
  let scopes: string[] = [];
  let note: string | null = null;
  try {
    const d = await client.debugToken();
    isValid = d.is_valid;
    scopes = d.scopes;
  } catch (e) {
    note = e instanceof Error ? e.message : String(e);
  }
  await db
    .insert(schema.tokenHealth)
    .values({ id: "singleton", checkedAt: new Date(), isValid, scopes, note })
    .onConflictDoUpdate({
      target: schema.tokenHealth.id,
      set: { checkedAt: new Date(), isValid, scopes, note },
    });
  return isValid;
}

/** Persist the access tier observed from live BUC headers so the next cycle can size its pacing. */
export async function recordObservedTier(tier: string | null): Promise<void> {
  if (!tier) return;
  await db.update(schema.tokenHealth).set({ tier }).where(eq(schema.tokenHealth.id, "singleton"));
}

/** Last observed access tier (null when never seen), read before a cycle to choose pacing. */
export async function getStoredTier(): Promise<string | null> {
  const [row] = await db
    .select({ tier: schema.tokenHealth.tier })
    .from(schema.tokenHealth)
    .where(eq(schema.tokenHealth.id, "singleton"));
  return row?.tier ?? null;
}

export interface ServiceHealth {
  ok: boolean;
  checkedAt: string | null;
  note: string | null;
}

/** Upsert a background service's sync health (e.g. "notion") so a silent failure surfaces in the UI. */
export async function recordServiceHealth(
  service: string,
  ok: boolean,
  note: string | null,
): Promise<void> {
  const vals = { service, ok, checkedAt: new Date(), note };
  await db
    .insert(schema.serviceHealth)
    .values(vals)
    .onConflictDoUpdate({ target: schema.serviceHealth.service, set: vals });
}

/** Read a service's last recorded health, or null when it has never run. */
export async function getServiceHealth(service: string): Promise<ServiceHealth | null> {
  const [row] = await db
    .select()
    .from(schema.serviceHealth)
    .where(eq(schema.serviceHealth.service, service));
  if (!row) return null;
  return {
    ok: row.ok,
    checkedAt: row.checkedAt ? row.checkedAt.toISOString() : null,
    note: row.note ?? null,
  };
}

/**
 * Milliseconds since a service last recorded anything, or null when it never has.
 *
 * The point is that this clock lives in Postgres, so it survives a process restart. An in-memory
 * timestamp cannot space out work across deployments — which is exactly the gap that let a run of
 * restarts fire one Meta sweep each.
 */
export async function msSinceLastCycle(service: string): Promise<number | null> {
  const [row] = await db
    .select({ checkedAt: schema.serviceHealth.checkedAt })
    .from(schema.serviceHealth)
    .where(eq(schema.serviceHealth.service, service));
  if (!row?.checkedAt) return null;
  return Date.now() - row.checkedAt.getTime();
}

export interface Checkpoint {
  backfilledThrough: string | null;
  cursor: string | null;
}

/** Read a dataset's backfill checkpoint for an account (null = never started). */
export async function getCheckpoint(
  accountId: string,
  dataset: string,
): Promise<Checkpoint | null> {
  const [row] = await db
    .select({
      backfilledThrough: schema.syncCheckpoints.backfilledThrough,
      cursor: schema.syncCheckpoints.cursor,
    })
    .from(schema.syncCheckpoints)
    .where(
      and(
        eq(schema.syncCheckpoints.accountId, accountId),
        eq(schema.syncCheckpoints.dataset, dataset),
      ),
    );
  return row ? { backfilledThrough: row.backfilledThrough, cursor: row.cursor } : null;
}

/** Upsert a dataset's backfill checkpoint; only the provided fields change. */
export async function setCheckpoint(
  accountId: string,
  dataset: string,
  patch: Partial<Checkpoint>,
): Promise<void> {
  await db
    .insert(schema.syncCheckpoints)
    .values({
      accountId,
      dataset,
      backfilledThrough: patch.backfilledThrough ?? null,
      cursor: patch.cursor ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.syncCheckpoints.accountId, schema.syncCheckpoints.dataset],
      set: {
        ...(patch.backfilledThrough !== undefined
          ? { backfilledThrough: patch.backfilledThrough }
          : {}),
        ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
        updatedAt: new Date(),
      },
    });
}

/** Fields Meta has rejected for a request key — loaded once into the client's in-memory cache. */
export async function getFieldBlocklist(memoKey: string): Promise<string[]> {
  const [row] = await db
    .select({ fields: schema.metaFieldBlocklist.fields })
    .from(schema.metaFieldBlocklist)
    .where(eq(schema.metaFieldBlocklist.memoKey, memoKey));
  return Array.isArray(row?.fields) ? (row.fields as string[]) : [];
}

/** Persist the full set of rejected fields for a request key (the caller maintains the union). */
export async function saveFieldBlocklist(memoKey: string, fields: string[]): Promise<void> {
  await db
    .insert(schema.metaFieldBlocklist)
    .values({ memoKey, fields, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.metaFieldBlocklist.memoKey,
      set: { fields, updatedAt: new Date() },
    });
}

/** Persist a notable API event (rate-limit throttle or hard failure) for admin visibility. */
export async function recordSyncEvent(e: MetaApiEvent): Promise<void> {
  await db.insert(schema.syncEvents).values({
    id: crypto.randomUUID(),
    at: new Date(e.at),
    kind: e.kind,
    code: e.code,
    accountId: e.accountId || null,
    message: e.message.slice(0, 500),
    retryAfterMin: e.retryAfterMin,
    pressure: e.pressure,
  });
}

/** Most recent API events, newest first. */
export function getRecentSyncEvents(limit = 50) {
  return db.select().from(schema.syncEvents).orderBy(desc(schema.syncEvents.at)).limit(limit);
}

/** Drop API events older than `days` so the log stays bounded. */
export async function pruneSyncEvents(days = 7): Promise<void> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  await db.delete(schema.syncEvents).where(lt(schema.syncEvents.at, cutoff));
}
