import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireAdmin, audit } from "./auth";
import { isMachineStatus, MACHINE_STATUSES, type MachineStatus } from "@/lib/delivery-status";

export interface StatusOverrideView {
  pageId: string;
  status: MachineStatus;
  setBy: string | null;
  createdAt: string;
}

/**
 * Every override currently in force, newest first. Admin-only.
 *
 * A row whose stored status is not a machine-owned value is dropped rather than surfaced: the set of
 * machine values is the contract, and a stale row from a renamed value would otherwise be offered
 * back to the UI as if it were still writable.
 */
export async function fetchStatusOverrides(): Promise<StatusOverrideView[]> {
  await requireAdmin();
  const rows = await db.select().from(schema.notionStatusOverrides);
  return rows
    .flatMap((r) =>
      isMachineStatus(r.status)
        ? [
            {
              pageId: r.pageId,
              status: r.status,
              setBy: r.setBy,
              createdAt: r.createdAt.toISOString(),
            },
          ]
        : [],
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Pin one board row to a machine-owned status.
 *
 * Rejects human-owned values: those are set by editing Notion directly, and accepting one here would
 * put a value in both ownership sets — which is what lets the sync read ownership straight off the
 * board value with no provenance tracking.
 */
export async function setStatusOverride(data: {
  pageId: string;
  status: string;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const pageId = data.pageId.trim();
  if (!pageId) return { ok: false, error: "No page id" };
  if (!isMachineStatus(data.status)) {
    return {
      ok: false,
      error: `Only machine-owned statuses can be pinned: ${MACHINE_STATUSES.join(", ")}`,
    };
  }
  await db
    .insert(schema.notionStatusOverrides)
    .values({ pageId, status: data.status, setBy: user.email })
    .onConflictDoUpdate({
      target: schema.notionStatusOverrides.pageId,
      set: { status: data.status, setBy: user.email, createdAt: new Date() },
    });
  await audit("accountStatus.override", `pinned ${pageId} to ${data.status}`);
  return { ok: true };
}

/** Hand a row back to the derivation. */
export async function clearStatusOverride(data: { pageId: string }): Promise<{ ok: true }> {
  await requireAdmin();
  await db
    .delete(schema.notionStatusOverrides)
    .where(eq(schema.notionStatusOverrides.pageId, data.pageId));
  await audit("accountStatus.override", `cleared override on ${data.pageId}`);
  return { ok: true };
}
