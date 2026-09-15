import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { audit } from "@/server/fns/auth";

/**
 * The two states an alert can be in. `alerts.status` defaults to `"open"` and every writer in
 * `sync/alerts.ts` inserts with `onConflictDoNothing`, so clearing one is durable: the next sync
 * cycle re-evaluates the same dedupe key, finds the row, and leaves the status alone.
 */
export const ALERT_STATUSES = ["open", "acknowledged"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export interface AlertRow {
  id: string;
  type: string;
  accountId: string;
  accountName: string | null;
  message: string;
  metric: number | null;
  severity: string;
  status: string;
  date: string;
  createdAt: string;
}

/**
 * Most recent alerts, newest first.
 *
 * `limit` is the caller's page size — the feed has no cursor, so a UI that wants more asks for a
 * bigger page and can tell it has reached the end when it gets back fewer rows than it asked for.
 */
export async function fetchAlerts(limit = 100, status?: AlertStatus): Promise<AlertRow[]> {
  const rows = await db
    .select()
    .from(schema.alerts)
    .where(status ? eq(schema.alerts.status, status) : undefined)
    .orderBy(desc(schema.alerts.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    accountId: r.accountId,
    accountName: r.accountName,
    message: r.message,
    metric: r.metric,
    severity: r.severity,
    status: r.status,
    date: String(r.date),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}

/**
 * Clear alerts, or put them back. Accepts a list so a whole category can be cleared in one call
 * rather than N round trips.
 *
 * Audited: the feed is shared, so "who decided this was handled" is worth keeping. Returns the
 * number of rows actually changed, which is how the caller learns that an id no longer exists —
 * the feed is capped and an old alert can age out of the page the user was looking at.
 */
export async function setAlertStatus(
  ids: string[],
  status: AlertStatus,
): Promise<{ ok: true; updated: number }> {
  if (ids.length === 0) return { ok: true, updated: 0 };
  const changed = await db
    .update(schema.alerts)
    .set({ status })
    .where(inArray(schema.alerts.id, ids))
    .returning({ id: schema.alerts.id });
  if (changed.length > 0) {
    await audit(
      status === "acknowledged" ? "alert.acknowledge" : "alert.reopen",
      changed.length === 1 ? changed[0].id : `${changed.length} alerts`,
    );
  }
  return { ok: true, updated: changed.length };
}
