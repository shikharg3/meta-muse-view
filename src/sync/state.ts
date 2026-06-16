import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { InsightsClient } from "@/meta/types";

type Phase = "structure" | "insights";

/** True until the account completes its first insights sync (drives the initial backfill). */
export async function isFirstInsightsSync(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ last: schema.syncState.lastInsightsSync })
    .from(schema.syncState)
    .where(eq(schema.syncState.accountId, accountId));
  return !row?.last;
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

export async function recordTokenHealth(client: InsightsClient): Promise<void> {
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
