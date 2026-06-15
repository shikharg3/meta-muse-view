import { desc } from "drizzle-orm";
import { db, schema } from "@/db/client";

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

/** Most recent alerts, newest first. */
export async function fetchAlerts(limit = 100): Promise<AlertRow[]> {
  const rows = await db
    .select()
    .from(schema.alerts)
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
