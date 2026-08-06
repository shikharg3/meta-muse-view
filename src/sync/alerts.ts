import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { accountStatus } from "@/server/agg";
import { addDays } from "@/lib/range";

/** Spend-drop alert thresholds (tune here). */
export const ALERT_MIN_BASELINE = 50; // ignore accounts averaging < $50/day
export const ALERT_DROP_PCT = 0.95; // flag a >= 95% drop vs the trailing-7-day baseline

/** Account-alert thresholds (tune here). */
export const ALERT_LOW_FUNDS_USD = 100; // remaining prepaid budget that warrants a top-up warning
export const ALERT_IN_USE_DAYS = 7; // an account counts as "in use" if it spent inside this window
export const ALERT_NO_SPEND_REPEAT_DAYS = 7; // a persistent stoppage alerts once, not every day

interface DropRow {
  account_id: string;
  account_name: string | null;
  avg_daily: number;
  latest: number;
  day: string;
}

/**
 * Detect accounts whose spend on the latest COMPLETE day (today is excluded — it's partial until
 * the day finishes + syncs, which otherwise flags every active account) collapsed >= ALERT_DROP_PCT
 * vs their trailing-7-day baseline — a likely ban / shadow-ban signal. Suppresses repeats: an
 * account already flagged in the last 7 days is skipped, so a persistent collapse alerts once, not
 * every day. Returns the count of new alerts.
 */
export async function detectSpendDropAlerts(): Promise<number> {
  const keep = 1 - ALERT_DROP_PCT;
  const result = await db.execute(sql`
    WITH asof AS (
      SELECT max(date) AS d FROM insights_daily WHERE level = 'account' AND date < CURRENT_DATE
    ),
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
      AND NOT EXISTS (
        SELECT 1 FROM alerts al
        WHERE al.account_id = b.entity_id AND al.type = 'spend_drop'
          AND al.date >= (SELECT d FROM asof) - 7
      )
  `);
  const rows = result as unknown as DropRow[];

  let inserted = 0;
  const fresh: { name: string; message: string }[] = [];
  for (const r of rows) {
    const day = String(r.day);
    const avg = Number(r.avg_daily);
    const latest = Number(r.latest);
    const drop = 1 - latest / Math.max(1, avg);
    const name = r.account_name ?? r.account_id;
    const message = `Spend collapsed to $${Math.round(latest)} on ${day} vs a $${Math.round(avg)}/day baseline (${Math.round(drop * 100)}% drop) — possible ban or shadow-ban.`;
    const res = await db
      .insert(schema.alerts)
      .values({
        id: `spend_drop:${r.account_id}:${day}`,
        type: "spend_drop",
        accountId: r.account_id,
        accountName: name,
        message,
        metric: drop,
        severity: drop >= 0.99 ? "critical" : "warning",
        status: "open",
        date: day,
      })
      .onConflictDoNothing()
      .returning({ id: schema.alerts.id });
    if (res.length) {
      inserted++;
      fresh.push({ name, message });
    }
  }
  if (fresh.length)
    await notifyTelegram(
      fresh.map((f) => ({ name: f.name, message: `${f.name} — ${f.message}` })),
      "🚨 Spend-drop alert",
    );
  return inserted;
}

/** Send a message to the configured Telegram channel; returns ok/error (never throws). */
async function sendTelegram(text: string): Promise<{ ok: boolean; error?: string }> {
  const e = env();
  if (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_ALERT_CHAT_ID)
    return {
      ok: false,
      error: "Telegram not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID.",
    };
  try {
    const res = await fetch(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: e.TELEGRAM_ALERT_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok)
      return { ok: false, error: `Telegram ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Push new alerts to the configured Telegram channel (no-op if unconfigured). */
async function notifyTelegram(
  alerts: { name: string; message: string }[],
  heading: string,
): Promise<void> {
  const text =
    `${heading}${alerts.length > 1 ? ` (${alerts.length})` : ""}:\n` +
    alerts.map((a) => `• ${a.message}`).join("\n");
  const r = await sendTelegram(text);
  if (!r.ok) console.error("[alerts] telegram notify failed:", r.error);
}

export type AccountAlertKind = "account_disabled" | "low_funds" | "no_spend";

const KIND_HEADING: Record<AccountAlertKind, string> = {
  account_disabled: "🚫 Ad account disabled",
  low_funds: "💸 Ad account almost out of budget",
  no_spend: "⏸️ No spend yesterday",
};

/** One account, joined to its owning client and its recent spend. Major units for money. */
export interface AccountAlertRow {
  id: string;
  name: string | null;
  client: string;
  /** Meta `account_status`, raw as stored. */
  status: string | null;
  /** Lifetime prepaid ceiling in MINOR units; null/0 = uncapped. */
  spendCap: number | null;
  amountSpent: number | null;
  spend7d: number;
  spendYesterday: number;
}

export interface AccountAlert {
  kind: AccountAlertKind;
  accountId: string;
  accountName: string;
  message: string;
  /** Stable key: one alert per real event, not one per run. */
  dedupe: string;
  severity: "warning" | "critical";
  metric: number | null;
}

/**
 * Which alerts an account currently warrants. Pure, so the thresholds and the scoping rules are
 * testable without a database.
 *
 * Everything is scoped to accounts that are actually IN USE (they spent inside
 * `ALERT_IN_USE_DAYS`). Without that scope these alerts are unusable noise: on this book of business
 * an unscoped "no spend yesterday" fires for 40 accounts every day and "out of budget" for 31, most
 * of them long-dormant rented accounts nobody is watching.
 */
export function classifyAccount(row: AccountAlertRow, yesterday: string): AccountAlert[] {
  const out: AccountAlert[] = [];
  const name = row.name ?? row.id;
  const label = `${row.client} - ${name} - ${row.id}`;
  const status = accountStatus(row.status);
  const cap = row.spendCap ?? 0;
  // null = uncapped, so there is no funding limit to run out of.
  const remaining = cap > 0 ? (cap - (row.amountSpent ?? 0)) / 100 : null;
  const inUse = row.spend7d > 0;

  if (status === "DISABLED") {
    // Keyed without a date: one alert per disable episode. `detectAccountAlerts` clears the row when
    // the account comes back, so a later disable alerts again.
    out.push({
      kind: "account_disabled",
      accountId: row.id,
      accountName: name,
      message: label,
      dedupe: `account_disabled:${row.id}`,
      severity: "critical",
      metric: null,
    });
    return out; // a disabled account cannot also be "out of budget" or "not spending" — that is noise
  }
  if (status !== "ACTIVE") return out; // pending/unsettled: not actionable by this team

  if (inUse && remaining !== null && remaining <= ALERT_LOW_FUNDS_USD) {
    out.push({
      kind: "low_funds",
      accountId: row.id,
      accountName: name,
      // Keyed by the cap: a top-up moves the cap, so the next drain alerts again.
      dedupe: `low_funds:${row.id}:${cap}`,
      message: `${label} - $${remaining.toFixed(2)} remaining`,
      severity: remaining <= 0 ? "critical" : "warning",
      metric: remaining,
    });
  }

  // Only when the account COULD have spent: if it is out of funding the low-funds alert already
  // explains the silence, and two alerts for one cause is how people learn to ignore alerts.
  const funded = remaining === null || remaining > 1;
  if (inUse && funded && row.spendYesterday === 0) {
    out.push({
      kind: "no_spend",
      accountId: row.id,
      accountName: name,
      message: `${label} - No spend alert`,
      dedupe: `no_spend:${row.id}:${yesterday}`,
      severity: "warning",
      metric: 0,
    });
  }
  return out;
}

interface RawAccountAlertRow {
  id: string;
  name: string | null;
  client: string;
  status: string | null;
  spend_cap: number | null;
  amount_spent: number | null;
  spend7d: number;
  spend_yesterday: number;
}

/**
 * Detect disabled accounts, accounts nearly out of prepaid budget, and active accounts that stopped
 * spending. Only accounts mapped to a CURRENT client are considered.
 *
 * `silent` records a kind's current state without notifying. Used once on rollout: the book of
 * business already contains 74 disabled and 10 nearly-drained accounts, and delivering that history
 * as ~84 Telegram messages would teach everyone to mute the channel on day one. Returns the count of
 * new alerts per kind.
 */
export async function detectAccountAlerts(
  opts: { silent?: AccountAlertKind[] } = {},
): Promise<Record<AccountAlertKind, number>> {
  const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
  // Both dates are computed here and passed as explicit ::date values. `CURRENT_DATE - $n` leaves the
  // bound parameter untyped, which Postgres rejects as an ambiguous operator.
  const inUseSince = addDays(yesterday, -(ALERT_IN_USE_DAYS - 1));
  const result = await db.execute(sql`
    WITH owner AS (
      SELECT DISTINCT acct, name FROM (
        SELECT c.name,
               jsonb_array_elements_text(
                 coalesce(c.notion_account_ids, '[]'::jsonb) || coalesce(c.manual_add_ids, '[]'::jsonb)
               ) AS acct,
               coalesce(c.manual_remove_ids, '[]'::jsonb) AS rm
        FROM clients c WHERE c.removed_at IS NULL
      ) x
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(x.rm) r WHERE r = x.acct)
    ),
    s7 AS (
      SELECT entity_id, sum(spend) AS v FROM insights_daily
      WHERE level = 'account' AND date >= ${inUseSince}::date AND date <= ${yesterday}::date
      GROUP BY entity_id
    ),
    sy AS (
      SELECT entity_id, sum(spend) AS v FROM insights_daily
      WHERE level = 'account' AND date = ${yesterday}::date GROUP BY entity_id
    )
    SELECT a.id, a.name, o.name AS client, a.status, a.spend_cap, a.amount_spent,
           coalesce(s7.v, 0) AS spend7d, coalesce(sy.v, 0) AS spend_yesterday
    FROM accounts a
    JOIN owner o ON o.acct = a.id
    LEFT JOIN s7 ON s7.entity_id = a.id
    LEFT JOIN sy ON sy.entity_id = a.id
  `);
  const rows = result as unknown as RawAccountAlertRow[];

  const counts: Record<AccountAlertKind, number> = {
    account_disabled: 0,
    low_funds: 0,
    no_spend: 0,
  };
  const candidates: AccountAlert[] = [];
  const recovered: string[] = [];
  for (const r of rows) {
    const row: AccountAlertRow = {
      id: r.id,
      name: r.name,
      client: r.client,
      status: r.status,
      spendCap: r.spend_cap == null ? null : Number(r.spend_cap),
      amountSpent: r.amount_spent == null ? null : Number(r.amount_spent),
      spend7d: Number(r.spend7d),
      spendYesterday: Number(r.spend_yesterday),
    };
    if (accountStatus(row.status) === "ACTIVE") recovered.push(row.id);
    candidates.push(...classifyAccount(row, yesterday));
  }

  // An account that came back clears its disabled alert, so the next disable is a fresh event.
  if (recovered.length)
    await db
      .delete(schema.alerts)
      .where(
        and(
          eq(schema.alerts.type, "account_disabled"),
          inArray(schema.alerts.accountId, recovered),
        ),
      );

  // A persistent stoppage should alert once, matching spend-drop behaviour.
  const stops = candidates.filter((c) => c.kind === "no_spend");
  const recentlyWarned = new Set<string>();
  if (stops.length) {
    const since = addDays(yesterday, -ALERT_NO_SPEND_REPEAT_DAYS);
    const prior = await db
      .select({ accountId: schema.alerts.accountId })
      .from(schema.alerts)
      .where(and(eq(schema.alerts.type, "no_spend"), gte(schema.alerts.date, since)));
    for (const p of prior) recentlyWarned.add(p.accountId);
  }

  const fresh: Record<AccountAlertKind, { name: string; message: string }[]> = {
    account_disabled: [],
    low_funds: [],
    no_spend: [],
  };
  for (const c of candidates) {
    if (c.kind === "no_spend" && recentlyWarned.has(c.accountId)) continue;
    const res = await db
      .insert(schema.alerts)
      .values({
        id: c.dedupe,
        type: c.kind,
        accountId: c.accountId,
        accountName: c.accountName,
        message: c.message,
        metric: c.metric,
        severity: c.severity,
        status: "open",
        date: yesterday,
      })
      .onConflictDoNothing()
      .returning({ id: schema.alerts.id });
    if (!res.length) continue;
    counts[c.kind] += 1;
    fresh[c.kind].push({ name: c.accountName, message: c.message });
  }

  for (const kind of Object.keys(fresh) as AccountAlertKind[]) {
    if (opts.silent?.includes(kind)) continue;
    if (fresh[kind].length) await notifyTelegram(fresh[kind], KIND_HEADING[kind]);
  }
  return counts;
}

export interface AlertSettings {
  minBaseline: number;
  dropPct: number;
  lowFundsUsd: number;
  inUseDays: number;
  telegramConfigured: boolean;
}

/** Current alert configuration for the settings panel (no secrets leaked). */
export function alertSettings(): AlertSettings {
  const e = env();
  return {
    minBaseline: ALERT_MIN_BASELINE,
    dropPct: ALERT_DROP_PCT,
    lowFundsUsd: ALERT_LOW_FUNDS_USD,
    inUseDays: ALERT_IN_USE_DAYS,
    telegramConfigured: Boolean(e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_ALERT_CHAT_ID),
  };
}

/** Send a test message to verify Telegram delivery. */
export function sendTestAlert(): Promise<{ ok: boolean; error?: string }> {
  return sendTelegram("✅ Test alert from MetaConsole — Telegram delivery is working.");
}
