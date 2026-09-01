import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { addDays } from "@/lib/range";
import { fetchAlerts } from "@/server/fns/alerts";
import { fetchAccountDirectory } from "@/server/fns/clients";
import {
  ALERT_DROP_PCT,
  ALERT_IN_USE_DAYS,
  ALERT_LOW_FUNDS_USD,
  ALERT_MIN_BASELINE,
  ALERT_NO_SPEND_REPEAT_DAYS,
  ALERT_UNASSIGNED_DAYS,
  ALERT_UNASSIGNED_MIN_USD,
  classifyAccount,
  scanUnassignedSpend,
  type AccountAlert,
  type AccountAlertKind,
  type AccountAlertRow,
} from "@/sync/alerts";
import { WINDOW_PROPS, toolWindow, type AgentTool } from "./kit";

const round2 = (n: number): number => Math.round(n * 100) / 100;

const DROP_PCT = Math.round(ALERT_DROP_PCT * 100);

/**
 * Why each alert type fires, in the model's own vocabulary.
 *
 * Returned as DATA next to the rows rather than baked only into the tool description: the rows carry
 * a `type` and a bare `metric`, and without the rule beside them the model invents a threshold when
 * a user asks "why did this fire?". The strings are built from the exported constants in
 * `sync/alerts.ts`, so retuning a threshold there cannot leave this explanation stale.
 */
const ALERT_TYPE_DOC: Record<string, string> = {
  spend_drop: `Spend on the latest COMPLETE day (today is excluded — it is partial until the day ends and syncs) collapsed by ${DROP_PCT}% or more versus the account's trailing-7-day average daily spend. Only accounts averaging >= $${ALERT_MIN_BASELINE}/day are considered, so small accounts cannot trip it. Usual cause: a ban / shadow-ban, an exhausted prepaid cap, or everything paused. Repeats are suppressed — a persistent collapse alerts once per 7 days, not daily. \`metric\` = the drop as a fraction (0.97 = a 97% drop); severity is critical at >= 0.99, otherwise warning.`,
  account_disabled: `The ad account's Meta \`account_status\` is DISABLED (suspended by Meta). Always critical. A disabled account is deliberately NOT also reported as low_funds or no_spend — the disable already explains the silence. When the account comes back the alert row is deleted, so a later disable is a fresh event.`,
  low_funds: `An IN-USE account's remaining prepaid budget (Meta \`spend_cap\` − \`amount_spent\`, both scoped to the current cap cycle) has fallen to $${ALERT_LOW_FUNDS_USD} or less. \`metric\` = dollars remaining; severity is critical at <= $0 (delivery has already stopped), otherwise warning. Uncapped accounts (no spend_cap) can never fire this. The fix is a top-up: topping up moves the cap, and the next drain alerts again.`,
  no_spend: `An IN-USE, ACTIVE, still-FUNDED account spent $0 yesterday — an unexplained stoppage. \`metric\` is 0. Fires once per ${ALERT_NO_SPEND_REPEAT_DAYS} days per account, not every day. It is suppressed when low_funds already fired for the same account, because running out of money is not a mystery.`,
  unassigned_spend: `A campaign sits on a SHARED ad account that two or more clients claim, and no attribution rule could decide whose it is, so its spend is counted for NOBODY in every client figure and report. \`metric\` = the unassigned dollars over the last ${ALERT_UNASSIGNED_DAYS} days. Self-healing: assigning the campaign clears the alert. Use get_unassigned_spend for the live backlog with the candidate clients.`,
};

const SEVERITY_OK: Record<string, true> = { warning: true, critical: true };

/** Common scoping rules, returned with every payload so a "why?" never needs a second call. */
const THRESHOLDS = {
  spendDropPct: DROP_PCT,
  spendDropMinBaselineUsdPerDay: ALERT_MIN_BASELINE,
  lowFundsUsd: ALERT_LOW_FUNDS_USD,
  inUseDays: ALERT_IN_USE_DAYS,
  noSpendRepeatDays: ALERT_NO_SPEND_REPEAT_DAYS,
  unassignedMinUsd: ALERT_UNASSIGNED_MIN_USD,
  unassignedLookbackDays: ALERT_UNASSIGNED_DAYS,
  inUseRule: `"In use" = the account spent something in the last ${ALERT_IN_USE_DAYS} days. low_funds and no_spend are scoped to in-use accounts ONLY; without that scope dozens of long-dormant rented accounts fire every single day and the channel becomes noise.`,
};

/** True only when the caller actually asked for a date range, so the window filter stays opt-in. */
const hasWindowArg = (input: Record<string, unknown>): boolean =>
  Boolean(input.since || input.until || input.days || input.preset);

const clampLimit = (v: unknown, fallback: number, max: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
};

const tally = (values: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};

// The alert log is read newest-first and filtered in memory: one bounded read serves every filter
// combination, and the log is small (a few hundred rows on this book) so paging it would cost more
// than it saves.
const ALERT_SCAN = 300;

export const getAlerts: AgentTool = {
  label: "alerts",
  definition: {
    name: "get_alerts",
    description:
      "The ALERT LOG — what the hourly monitor has actually fired, newest first. This is HISTORY: a row means 'this fired on this date', not 'this is broken right now'. For the CURRENT state of the book use get_account_health instead (an account disabled in March still has a row here even though everyone already knows). Each row: `date` (the day evaluated), `type`, `severity` (warning | critical), `status` (open | acknowledged), `account` + `accountId`, the human `message` the Telegram channel received, and `metric` (its meaning depends on `type` — see the `alertTypes` block returned with every response). The response also carries `byType` / `bySeverity` counts over everything that matched, `alertTypes` (what each type means and the exact rule that fires it), and `thresholds` (the tuned numbers). Use those to answer 'why did this fire?' WITHOUT guessing — never invent a threshold. Filters are all optional: `severity`, `type`, a date range (only applied when you pass one — omit it to see the whole recent log), and `limit`. Alerts cover ad-account health and attribution only; they say nothing about whether the DATA is fresh — call get_data_freshness for that.",
    input_schema: {
      type: "object",
      properties: {
        severity: {
          type: "string",
          enum: ["warning", "critical"],
          description: "Only alerts at this severity. Omit for both.",
        },
        type: {
          type: "string",
          enum: ["spend_drop", "account_disabled", "low_funds", "no_spend", "unassigned_spend"],
          description: "Only alerts of this type. Omit for all types.",
        },
        limit: {
          type: "integer",
          description:
            "Max alert rows to return (default 25, max 60). The counts always cover ALL matches, so raise this only when the user wants the rows themselves.",
        },
        ...WINDOW_PROPS,
      },
    },
  },
  async run(input) {
    const severity = typeof input.severity === "string" ? input.severity.toLowerCase() : null;
    if (severity && !(severity in SEVERITY_OK))
      return {
        error: `severity must be "warning" or "critical" (got "${String(input.severity)}").`,
      };
    const type = typeof input.type === "string" ? input.type.toLowerCase() : null;
    if (type && !(type in ALERT_TYPE_DOC))
      return {
        error: `Unknown alert type "${String(input.type)}". Valid types: ${Object.keys(ALERT_TYPE_DOC).join(", ")}.`,
      };

    const limit = clampLimit(input.limit, 25, 60);
    const w = hasWindowArg(input) ? toolWindow(input) : null;
    const rows = await fetchAlerts(ALERT_SCAN);
    const matched = rows.filter(
      (r) =>
        (!w || (r.date >= w.since && r.date <= w.until)) &&
        (!severity || r.severity === severity) &&
        (!type || r.type === type),
    );
    const shown = matched.slice(0, limit);
    const byType = tally(matched.map((r) => r.type));

    return {
      scope: w
        ? { since: w.since, until: w.until }
        : `newest ${ALERT_SCAN} alerts on file, no date filter applied`,
      total: matched.length,
      showing: shown.length,
      ...(matched.length > shown.length
        ? { truncated: `showing the ${shown.length} newest of ${matched.length} matches` }
        : {}),
      byType,
      bySeverity: tally(matched.map((r) => r.severity)),
      alerts: shown.map((r) => ({
        date: r.date,
        type: r.type,
        severity: r.severity,
        status: r.status,
        account: r.accountName ?? r.accountId,
        accountId: r.accountId,
        message: r.message,
        ...(r.metric === null ? {} : { metric: round2(r.metric) }),
      })),
      // Only the types actually present: explaining a rule that fired nothing is pure token cost.
      alertTypes: Object.fromEntries(
        Object.keys(byType).map((k) => [k, ALERT_TYPE_DOC[k] ?? "unknown alert type"]),
      ),
      thresholds: THRESHOLDS,
    };
  },
};

/** One current problem, flattened for the payload. Money is major units, rounded. */
interface HealthRow {
  accountId: string;
  account: string;
  client: string;
  severity: "warning" | "critical";
  reason: string;
  spend7d: number;
  spendYesterday: number;
  remainingUsd?: number;
  disableReason?: string | null;
  disabledSince?: string | null;
  isDesignatedAccount?: boolean;
}

const KIND_ORDER: AccountAlertKind[] = ["account_disabled", "low_funds", "no_spend"];
const GROUP_CAP = 25;

export const getAccountHealth: AgentTool = {
  label: "account health",
  definition: {
    name: "get_account_health",
    description:
      "CURRENT ad-account health, grouped by problem — the live state of the book, not the alert log. Computed on demand: account status and client ownership come from the Notion→Meta account mapping, prepaid funding from Meta's `spend_cap`/`amount_spent` pair, and spend from our daily insights; those rows are then run through `classifyAccount`, the SAME pure classifier the hourly alert job uses, so the verdicts here match what alerting would say this minute. It reads only — it never fires a Telegram alert or writes an alert row. " +
      "Returns `problems` with three groups: `account_disabled` (suspended by Meta — carries `disableReason` and `disabledSince`, sorted by last-7-day spend so the ones that were actually earning come first), " +
      `\`low_funds\` (in-use accounts with $${ALERT_LOW_FUNDS_USD} or less prepaid budget left — carries \`remainingUsd\`, least headroom first; <= 0 means delivery has ALREADY stopped), and \`no_spend\` (in-use, ACTIVE, still-funded accounts that spent $0 yesterday — an unexplained stoppage). ` +
      "Every row carries `client`, `spend7d`, `spendYesterday`, `severity` and a plain-English `reason`; `counts` covers ALL matches even when a group is truncated, and `healthy` is how many checked accounts had no problem at all. " +
      `Mind the scoping rules (also returned in \`thresholds\`): low_funds and no_spend only consider accounts that spent inside the last ${ALERT_IN_USE_DAYS} days, and a DISABLED account is reported ONLY as disabled because the disable already explains the silence. Accounts no current client owns are skipped and counted in \`unmappedAccountsSkipped\`. ` +
      "Use this for 'which accounts are in trouble / need a top-up / stopped spending / are suspended'. Use get_alerts instead for the history of what fired and when, and list_accounts for the full directory including healthy accounts. `asOf` is YESTERDAY — spend is measured on complete days only, so nothing that happened today is in here.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["account_disabled", "low_funds", "no_spend"],
          description: "Only report this one problem. Omit for all three.",
        },
        client: {
          type: "string",
          description:
            "Case-insensitive substring of the owning client name — narrows the report to one client's accounts. Omit for the whole book.",
        },
      },
    },
  },
  async run(input) {
    const kind = typeof input.kind === "string" ? input.kind : null;
    if (kind && !KIND_ORDER.includes(kind as AccountAlertKind))
      return { error: `kind must be one of ${KIND_ORDER.join(", ")} (got "${kind}").` };
    const clientQuery =
      typeof input.client === "string" && input.client.trim()
        ? input.client.trim().toLowerCase()
        : null;

    // Yesterday, because today is partial: the last COMPLETE day is the only honest basis for
    // "stopped spending", and it is the day the alert job evaluates too.
    const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
    const inUseSince = addDays(yesterday, -(ALERT_IN_USE_DAYS - 1));

    const [dir, funds, spendRows] = await Promise.all([
      fetchAccountDirectory(),
      // Funding headroom is the one input no read fn exposes, and the pair is only meaningful
      // together: both sides come from Meta's CURRENT spend-cap cycle. Never substitute a lifetime
      // spend figure here (see server/account-lifetime-spend.ts) — it drives accounts negative.
      db
        .select({
          id: schema.accounts.id,
          spendCap: schema.accounts.spendCap,
          amountSpent: schema.accounts.amountSpent,
        })
        .from(schema.accounts),
      db
        .select({
          entityId: schema.insightsDaily.entityId,
          spend7d: sql<number>`coalesce(sum(${schema.insightsDaily.spend}), 0)`,
          spendYesterday: sql<number>`coalesce(sum(case when ${schema.insightsDaily.date} = ${yesterday}::date then ${schema.insightsDaily.spend} else 0 end), 0)`,
        })
        .from(schema.insightsDaily)
        .where(
          and(
            eq(schema.insightsDaily.level, "account"),
            gte(schema.insightsDaily.date, inUseSince),
            lte(schema.insightsDaily.date, yesterday),
          ),
        )
        .groupBy(schema.insightsDaily.entityId),
    ]);

    const fundsById = new Map(funds.map((f) => [f.id, f]));
    const spendById = new Map(spendRows.map((s) => [s.entityId, s]));
    const dirById = new Map(dir.accounts.map((a) => [a.id, a]));

    let unmapped = 0;
    const alerts: AccountAlert[] = [];
    const rowById = new Map<string, AccountAlertRow>();
    for (const a of dir.accounts) {
      // Only CURRENT client-owned accounts, matching the alert job: an unowned account is a mapping
      // gap, which list_accounts reports, not an account-health problem.
      if (!a.client) {
        unmapped++;
        continue;
      }
      if (clientQuery && !a.client.toLowerCase().includes(clientQuery)) continue;
      const f = fundsById.get(a.id);
      const s = spendById.get(a.id);
      const row: AccountAlertRow = {
        id: a.id,
        name: a.name,
        client: a.client,
        status: a.status,
        spendCap: f?.spendCap ?? null,
        amountSpent: f?.amountSpent ?? null,
        spend7d: Number(s?.spend7d ?? 0),
        spendYesterday: Number(s?.spendYesterday ?? 0),
      };
      rowById.set(a.id, row);
      alerts.push(...classifyAccount(row, yesterday));
    }

    if (clientQuery && rowById.size === 0)
      return {
        error: `No ad accounts owned by a client matching "${String(input.client)}". Try list_clients or search_entities to get the exact name.`,
      };

    const problems: Partial<Record<AccountAlertKind, HealthRow[]>> = {};
    const counts: Record<AccountAlertKind, number> = {
      account_disabled: 0,
      low_funds: 0,
      no_spend: 0,
    };
    for (const a of alerts) {
      counts[a.kind] += 1;
      if (kind && a.kind !== kind) continue;
      const row = rowById.get(a.accountId);
      const d = dirById.get(a.accountId);
      const base: HealthRow = {
        accountId: a.accountId,
        account: a.accountName,
        client: row?.client ?? "unknown",
        severity: a.severity,
        reason:
          a.kind === "account_disabled"
            ? "Disabled by Meta — delivering nothing."
            : a.kind === "low_funds"
              ? `Prepaid budget almost gone: $${(a.metric ?? 0).toFixed(2)} left of its spend cap.`
              : `Active and funded but spent $0 on ${yesterday}.`,
        spend7d: round2(row?.spend7d ?? 0),
        spendYesterday: round2(row?.spendYesterday ?? 0),
      };
      if (a.kind === "low_funds") base.remainingUsd = round2(a.metric ?? 0);
      if (a.kind === "account_disabled") {
        base.disableReason = d?.disableReason ?? null;
        base.disabledSince = d?.disabledSince ?? null;
      }
      base.isDesignatedAccount = d?.isActiveAccount ?? false;
      (problems[a.kind] ??= []).push(base);
    }

    // Worst first, per group: money at risk for a disable/stoppage, least headroom for funding.
    for (const k of KIND_ORDER) {
      const list = problems[k];
      if (!list) continue;
      list.sort((x, y) =>
        k === "low_funds" ? (x.remainingUsd ?? 0) - (y.remainingUsd ?? 0) : y.spend7d - x.spend7d,
      );
      if (list.length > GROUP_CAP) problems[k] = list.slice(0, GROUP_CAP);
    }

    const truncated = KIND_ORDER.filter((k) => counts[k] > (problems[k]?.length ?? 0)).map(
      (k) => `${k}: showing top ${problems[k]?.length ?? 0} of ${counts[k]} by spend`,
    );

    return {
      asOf: yesterday,
      inUseSince,
      scope: clientQuery
        ? `accounts owned by clients matching "${String(input.client)}"`
        : "whole book",
      accountsChecked: rowById.size,
      unmappedAccountsSkipped: unmapped,
      counts,
      healthy: rowById.size - new Set(alerts.map((a) => a.accountId)).size,
      problems,
      ...(truncated.length ? { truncated } : {}),
      thresholds: THRESHOLDS,
      mappingSyncedAt: dir.mappingSyncedAt,
      note: "Live classification, not the alert log — an account fixed since its alert fired will not appear here. Spend is measured on complete days up to `asOf` (yesterday); today is excluded.",
    };
  },
};

const UNASSIGNED_CAP = 40;

export const getUnassignedSpend: AgentTool = {
  label: "unassigned spend",
  definition: {
    name: "get_unassigned_spend",
    description:
      "The ATTRIBUTION BACKLOG: every campaign whose spend is currently counted for NOBODY. Each of these sits on a SHARED ad account that two or more clients claim, and no rule (Notion mapping, name attribution, manual override) could decide whose it is, so its spend is excluded from every client figure, every report and every total. The exclusion is deliberate — counting contested spend for each claimant was the old bug — but it means client spend is quietly SHORT by `totalSpend` until someone assigns these. " +
      `Returns \`count\`, \`totalSpend\`, \`accountsAffected\`, and one row per campaign: \`campaign\` + \`campaignId\`, \`accountName\` + \`accountId\`, \`spend\` (the unassigned dollars over the last ${ALERT_UNASSIGNED_DAYS} days, largest first) and \`claimants\` (the clients contesting that account — the candidates a human picks between). Campaigns under $${ALERT_UNASSIGNED_MIN_USD} are ignored as rounding dust. ` +
      "The FIX is an assignment: an ADMIN can resolve any row with assign_campaign_client (or on either client's page in the UI), after which that campaign's spend lands under the chosen client and the row disappears here by itself. If the user is not an admin, name the campaigns and their candidate clients and say an admin has to make the call — do not guess an owner. Use this whenever a client's totals look low, whenever a client disputes their spend, and whenever list_clients reports unassigned spend and the user asks what it consists of.",
    input_schema: {
      type: "object",
      properties: {
        min_spend: {
          type: "number",
          description:
            "Only campaigns with at least this much unassigned spend, in dollars. Use to cut the tail when the backlog is long.",
        },
        limit: {
          type: "integer",
          description: `Max campaign rows (default ${UNASSIGNED_CAP}, max ${UNASSIGNED_CAP}). Totals always cover everything.`,
        },
      },
    },
  },
  async run(input) {
    const minSpend = Number(input.min_spend);
    const floor = Number.isFinite(minSpend) && minSpend > 0 ? minSpend : 0;
    const limit = clampLimit(input.limit, UNASSIGNED_CAP, UNASSIGNED_CAP);

    const all = await scanUnassignedSpend();
    const items = floor > 0 ? all.filter((i) => i.spend >= floor) : all;
    const total = round2(items.reduce((n, i) => n + i.spend, 0));
    const shown = items.slice(0, limit);

    if (items.length === 0)
      return {
        count: 0,
        totalSpend: 0,
        lookbackDays: ALERT_UNASSIGNED_DAYS,
        campaigns: [],
        note:
          floor > 0
            ? `No unassigned campaign spent at least $${floor} in the last ${ALERT_UNASSIGNED_DAYS} days (${all.length} smaller ones exist).`
            : "Nothing unassigned — every campaign on a contested ad account is attributed to a client, so client totals are complete.",
      };

    return {
      count: items.length,
      totalSpend: total,
      lookbackDays: ALERT_UNASSIGNED_DAYS,
      minSpendUsd: floor > 0 ? floor : ALERT_UNASSIGNED_MIN_USD,
      accountsAffected: new Set(items.map((i) => i.accountId)).size,
      campaigns: shown.map((i) => ({
        campaign: i.campaign,
        campaignId: i.id,
        accountName: i.accountName ?? i.accountId,
        accountId: i.accountId,
        spend: round2(i.spend),
        claimants: i.claimants.map((c) => c.name),
      })),
      ...(items.length > shown.length
        ? { truncated: `showing the ${shown.length} largest of ${items.length}` }
        : {}),
      fix: "An admin assigns each campaign to one of its `claimants` with assign_campaign_client (or on either client's page). Until then this spend is in NO client's numbers.",
    };
  },
};

/** Alerting: what fired, which accounts are unhealthy, unassigned spend. */
export const alertTools: AgentTool[] = [getAlerts, getAccountHealth, getUnassignedSpend];
