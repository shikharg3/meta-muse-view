import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { accountStatus } from "@/server/agg";
import { addDays } from "@/lib/range";
import { loadCampaignOwnership } from "@/server/fns/campaign-attribution";
import { TelegramClient } from "@/telegram/client";

/** Spend-drop alert thresholds (tune here). */
export const ALERT_MIN_BASELINE = 50; // ignore accounts averaging < $50/day
export const ALERT_DROP_PCT = 0.95; // flag a >= 95% drop vs the trailing-7-day baseline

/** Account-alert thresholds (tune here). */
export const ALERT_LOW_FUNDS_USD = 100; // remaining prepaid budget that warrants a top-up warning
export const ALERT_IN_USE_DAYS = 7; // an account counts as "in use" if it spent inside this window
export const ALERT_NO_SPEND_REPEAT_DAYS = 7; // a persistent stoppage alerts once, not every day

/** Unassigned-spend thresholds (tune here). */
export const ALERT_UNASSIGNED_MIN_USD = 1; // ignore rounding-dust campaigns
export const ALERT_UNASSIGNED_DAYS = 90; // only campaigns that spent recently enough to act on

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

/**
 * Send a message to the configured Telegram channel; returns ok/error (never throws). Exported so
 * the check-in escalation reuses one Telegram path.
 */
export async function sendAlertChannelMessage(
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const e = env();
  if (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_ALERT_CHAT_ID)
    return {
      ok: false,
      error: "Telegram not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID.",
    };
  const res = await new TelegramClient(e.TELEGRAM_BOT_TOKEN).sendMessage({
    chatId: e.TELEGRAM_ALERT_CHAT_ID,
    text,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Push new alerts to the configured Telegram channel (no-op if unconfigured). */
async function notifyTelegram(
  alerts: { name: string; message: string }[],
  heading: string,
): Promise<void> {
  const text =
    `${heading}${alerts.length > 1 ? ` (${alerts.length})` : ""}:\n` +
    alerts.map((a) => `• ${a.message}`).join("\n");
  const r = await sendAlertChannelMessage(text);
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
  return sendAlertChannelMessage("✅ Test alert from MetaConsole — Telegram delivery is working.");
}

/**
 * Campaigns on a SHARED ad account that no rule could attribute, so their spend is counted for
 * nobody.
 *
 * This is the one alert about money the dashboard is deliberately NOT showing. Excluding contested
 * spend is right - counting it for every claimant was the bug - but the exclusion has to be loud, or
 * a campaign silently belongs to no one and every report is quietly short. Visibility was previously
 * limited to the one client page the campaign happened to sit under.
 *
 * Self-healing: alerts are reconciled each run, so assigning a campaign (in the UI, by override, or
 * because the name attributor can now place it) clears its alert without a separate resolve step.
 * Returns the number of NEW alerts raised.
 */
export interface UnassignedCampaign {
  id: string;
  campaign: string;
  accountId: string;
  accountName: string | null;
  spend: number;
  /** The clients contesting the account — the candidates an operator picks between. Ids included so
   *  a surface can link straight to the page the assignment happens on. */
  claimants: { id: string; name: string }[];
}

/**
 * Every campaign whose spend is currently attributed to nobody, book-wide.
 *
 * One ownership load for the whole book; resolving per client would cost a scope query each. Shared
 * by the alert and the assistant so both describe the same backlog.
 */
export async function scanUnassignedSpend(): Promise<UnassignedCampaign[]> {
  const since = addDays(new Date().toISOString().slice(0, 10), -ALERT_UNASSIGNED_DAYS);
  const rows = (await db.execute(sql`
    SELECT c.id, c.name, c.account_id, a.name AS account_name,
           sum(i.spend)::double precision AS spend
    FROM campaigns c
    JOIN insights_daily i ON i.level = 'campaign' AND i.entity_id = c.id
    LEFT JOIN accounts a ON a.id = c.account_id
    WHERE i.date >= ${since}::date
    GROUP BY c.id, c.name, c.account_id, a.name
    HAVING sum(i.spend) >= ${ALERT_UNASSIGNED_MIN_USD}
  `)) as unknown as {
    id: string;
    name: string;
    account_id: string;
    account_name: string | null;
    spend: number;
  }[];
  const ownership = await loadCampaignOwnership();
  const out: UnassignedCampaign[] = [];
  for (const r of rows) {
    const claimants = ownership.claimantsOf(r.account_id);
    // Only a CONTESTED account can leave a campaign unowned. An account no client claims at all is a
    // mapping gap, not an attribution one, and would drown this alert.
    if (claimants.length <= 1) continue;
    if (ownership.ownerOf({ id: r.id, name: r.name, accountId: r.account_id }) !== null) continue;
    out.push({
      id: r.id,
      campaign: r.name,
      accountId: r.account_id,
      accountName: r.account_name,
      spend: r.spend,
      claimants: [...claimants].sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return out.sort((a, b) => b.spend - a.spend);
}

/** Book-wide unassigned-spend total, for surfaces that only need the headline. */
export async function unassignedSpendSummary(): Promise<{
  count: number;
  spend: number;
  items: UnassignedCampaign[];
}> {
  const items = await scanUnassignedSpend();
  return {
    count: items.length,
    spend: Math.round(items.reduce((n, i) => n + i.spend, 0) * 100) / 100,
    items,
  };
}

export async function detectUnassignedSpendAlerts(
  opts: { silent?: boolean } = {},
): Promise<number> {
  const orphans = await scanUnassignedSpend();
  const wanted = new Map(orphans.map((r) => [`unassigned:${r.id}`, r]));
  // Drop alerts for campaigns that have since been assigned, so the list is the live backlog.
  const existing = await db
    .select({ id: schema.alerts.id })
    .from(schema.alerts)
    .where(eq(schema.alerts.type, "unassigned_spend"));
  const stale = existing.filter((e) => !wanted.has(e.id)).map((e) => e.id);
  if (stale.length) await db.delete(schema.alerts).where(inArray(schema.alerts.id, stale));

  const today = new Date().toISOString().slice(0, 10);
  const fresh: { name: string; message: string }[] = [];
  let inserted = 0;
  for (const [dedupe, r] of wanted) {
    const message =
      `${r.campaign} - $${r.spend.toFixed(2)} unassigned - ` +
      `${r.claimants.map((c) => c.name).join(" and ")} both claim ${r.accountName ?? r.accountId}; ` +
      `assign it on either client's page`;
    const res = await db
      .insert(schema.alerts)
      .values({
        id: dedupe,
        type: "unassigned_spend",
        accountId: r.accountId,
        accountName: r.accountName,
        message,
        metric: r.spend,
        severity: "warning",
        status: "open",
        date: today,
      })
      .onConflictDoNothing()
      .returning({ id: schema.alerts.id });
    if (!res.length) continue;
    inserted++;
    fresh.push({ name: r.campaign, message });
  }
  if (fresh.length && !opts.silent)
    await notifyTelegram(fresh, "🧩 Campaign spend not assigned to any client");
  return inserted;
}
