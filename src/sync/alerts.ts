import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";

/** Spend-drop alert thresholds (tune here). */
export const ALERT_MIN_BASELINE = 50; // ignore accounts averaging < $50/day
export const ALERT_DROP_PCT = 0.95; // flag a >= 95% drop vs the trailing-7-day baseline

interface DropRow {
  account_id: string;
  account_name: string | null;
  avg_daily: number;
  latest: number;
  day: string;
}

/**
 * Detect accounts whose latest-day spend collapsed >= ALERT_DROP_PCT vs their
 * trailing 7-day baseline — a likely ban / shadow-ban signal. Idempotent: at most
 * one alert per account per day (dedup on id). Returns the count of new alerts.
 */
export async function detectSpendDropAlerts(): Promise<number> {
  const keep = 1 - ALERT_DROP_PCT;
  const result = await db.execute(sql`
    WITH asof AS (SELECT max(date) AS d FROM insights_daily WHERE level = 'account'),
    recent AS (
      SELECT entity_id, sum(spend) AS latest FROM insights_daily, asof
      WHERE level = 'account' AND date = asof.d GROUP BY entity_id
    ),
    base AS (
      SELECT entity_id, avg(spend) AS avg_daily FROM insights_daily, asof
      WHERE level = 'account' AND date >= asof.d - 7 AND date < asof.d GROUP BY entity_id
    )
    SELECT b.entity_id AS account_id, a.name AS account_name, b.avg_daily,
           coalesce(r.latest, 0) AS latest, (SELECT d FROM asof)::text AS day
    FROM base b
    LEFT JOIN recent r ON r.entity_id = b.entity_id
    LEFT JOIN accounts a ON a.id = b.entity_id
    WHERE b.avg_daily >= ${ALERT_MIN_BASELINE}
      AND coalesce(r.latest, 0) <= ${keep} * b.avg_daily
  `);
  const rows = result as unknown as DropRow[];

  let inserted = 0;
  for (const r of rows) {
    const day = String(r.day);
    const avg = Number(r.avg_daily);
    const latest = Number(r.latest);
    const drop = 1 - latest / Math.max(1, avg);
    const res = await db
      .insert(schema.alerts)
      .values({
        id: `spend_drop:${r.account_id}:${day}`,
        type: "spend_drop",
        accountId: r.account_id,
        accountName: r.account_name ?? r.account_id,
        message: `Spend collapsed to $${Math.round(latest)} on ${day} vs a $${Math.round(avg)}/day baseline (${Math.round(drop * 100)}% drop) — possible ban or shadow-ban.`,
        metric: drop,
        severity: drop >= 0.99 ? "critical" : "warning",
        status: "open",
        date: day,
      })
      .onConflictDoNothing()
      .returning({ id: schema.alerts.id });
    if (res.length) inserted++;
  }
  return inserted;
}
