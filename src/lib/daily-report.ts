/**
 * Pure decision core of the daily performance report: which campaigns count, how they roll up to a
 * Notion engagement, and how spend / results / account health collapse to one line each.
 *
 * No database, no clock, no Telegram — `src/server/fns/daily-report.ts` supplies the rows and
 * `daily-report-render.ts` turns the result into message text. Split the same way as `checkin.ts`,
 * for the same reason: the rules worth testing are the ones in here.
 */
import type { AccountStatus } from "./types";
import type { LocalMark } from "./berlin-time";

/**
 * When the report fires, Europe/Berlin wall clock.
 *
 * 10:00 rather than an earlier hour because the report reads each account's OWN calendar day: Los
 * Angeles midnight is 09:00 Berlin in BOTH DST regimes (summer UTC-7 vs UTC+2, winter UTC-8 vs
 * UTC+1), so 10:00 is the earliest DST-robust time at which a US west-coast account's "yesterday" has
 * actually closed. Sending at 08:00 would silently truncate those accounts' last hours.
 */
export const DAILY_REPORT_AT: LocalMark = { hour: 10, minute: 0 };

/**
 * How many times a failed send is retried before the day is abandoned. The gate is re-entered every
 * ~30s, so this is seconds of retrying, not days — the point is to survive a transient Telegram 5xx
 * without hammering it until midnight.
 */
export const MAX_ATTEMPTS = 5;

/** An ad account as the roll-up needs it. `disableReason` is already humanised. */
export interface ReportAccount {
  id: string;
  currency: string;
  status: AccountStatus;
  /**
   * `canDeliver()`: status ACTIVE *and* prepaid headroom left.
   *
   * Not the same as `status === "ACTIVE"`, and the difference decides the badge. Meta stops delivery
   * at the account level when a prepaid `spend_cap` is exhausted and leaves the account reporting
   * ACTIVE, so a status-only check would call an engagement live when nothing under it can spend.
   */
  deliverable: boolean;
  disableReason: string | null;
}

/** One campaign, already attributed to its owning Notion row (null = nobody owns it). */
export interface ReportCampaign {
  id: string;
  accountId: string;
  clientId: string | null;
  clientName: string | null;
  /** Spend over the reported day, major units, in the ACCOUNT's currency. */
  spend: number;
  /** Objective-aware result count over the reported day. */
  results: number;
  /** The label that `results` counts, e.g. "Purchases". */
  resultLabel: string;
  /** `effective_status === "ACTIVE"` right now. */
  active: boolean;
}

/** Spend in one currency. Kept separate because this codebase has no FX conversion. */
export interface CurrencySpend {
  currency: string;
  amount: number;
}

/** A result count under one label. Several entries means the engagement mixes objectives. */
export interface ResultTally {
  label: string;
  count: number;
}

/**
 * What an engagement's ad accounts add up to. `OUT_OF_BUDGET` is its own state because it is the one
 * unhealthy case that is neither disabled nor paused — the account is fine and simply needs a top-up,
 * which is a different action from appealing a ban.
 */
export type EngagementDelivery = "ACTIVE" | "OUT_OF_BUDGET" | "DISABLED" | "PAUSED" | "PENDING";

/** One engagement's account state, already collapsed to the single thing worth printing. */
export interface AccountHealth {
  status: EngagementDelivery;
  /** Humanised disable reason when one is known, else null. */
  reason: string | null;
}

/** One rendered line's worth of data. */
export interface EngagementRow {
  clientId: string;
  name: string;
  /** Per currency, descending by amount. One entry in the normal single-currency case. */
  spend: CurrencySpend[];
  /**
   * Sum of every currency's amount. ORDERING ONLY — it adds unlike units, so it must never be
   * rendered. Mixed-currency engagements are rare and this keeps the sort total.
   */
  sortSpend: number;
  /** Descending by count; a single entry when every campaign shares an objective. */
  results: ResultTally[];
  health: AccountHealth;
  campaignCount: number;
}

/**
 * Whether a campaign belongs in the report.
 *
 * The union is deliberate. "Spent yesterday" alone would drop a campaign that spent and was paused
 * this morning, under-reporting the day; "currently ACTIVE" alone would drop that same campaign's
 * spend AND report a figure that is not about yesterday at all. Together, yesterday's money is always
 * accounted for and a live-but-silent campaign still shows up as 0.00.
 */
export function includeCampaign(c: ReportCampaign): boolean {
  return c.spend > 0 || c.active;
}

/**
 * Result counts grouped by label, descending.
 *
 * NEVER a single summed number: one engagement's campaigns can carry different objectives, and
 * `resultSpec()` gives each its own label, so adding them would report a lead as a purchase. When the
 * labels agree there is exactly one entry, which is the common case and renders as "83 Purchases".
 *
 * When every campaign scored zero, the label of the highest-spending campaign is kept so the line can
 * still say what it is that did not happen ("0 Purchases") instead of a bare "0".
 */
export function collapseResults(campaigns: ReportCampaign[]): ResultTally[] {
  const byLabel = new Map<string, number>();
  for (const c of campaigns) {
    if (c.results <= 0) continue;
    byLabel.set(c.resultLabel, (byLabel.get(c.resultLabel) ?? 0) + c.results);
  }
  if (byLabel.size === 0) {
    let label = "Results";
    let best = -1;
    for (const c of campaigns) {
      if (c.spend > best) {
        best = c.spend;
        label = c.resultLabel;
      }
    }
    return [{ label, count: 0 }];
  }
  return [...byLabel]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en"));
}

/**
 * Severity order for the case where NOTHING can deliver. DISABLED outranks the rest because it needs
 * an appeal; PENDING outranks PAUSED because a pending account is not yet usable, while a paused one
 * is a deliberate choice.
 */
const SEVERITY: Record<AccountStatus, number> = { DISABLED: 3, PENDING: 2, PAUSED: 1, ACTIVE: 0 };

/**
 * One engagement's account state: ACTIVE when ANY of its accounts can still deliver.
 *
 * Any-active-wins, NOT worst-wins. An agency engagement accumulates recycled and banned accounts as
 * it runs, so worst-wins reported almost every engagement as partly disabled — true, but it buried
 * the only question the line needs to answer: can this client still spend? One live account means
 * yes, and the count of dead siblings beside it is noise.
 *
 * "Can deliver" is `canDeliver()`, not `status === "ACTIVE"`. An account whose prepaid cap is spent
 * keeps reporting ACTIVE while delivering nothing, and under any-active-wins that single account
 * would otherwise mark the whole engagement healthy.
 *
 * When nothing can deliver, the state that needs the most different action wins: OUT_OF_BUDGET (top
 * it up) is distinguished from DISABLED (appeal it), because an account that is ACTIVE-but-exhausted
 * is not banned and saying "DISABLED" would send someone to the wrong screen.
 *
 * An account id with no row (never enumerated) counts as PENDING, never as deliverable — a missing
 * account is an unknown, and letting an unknown mark an engagement live would hide a real gap.
 */
export function engagementDelivery(
  accountIds: Iterable<string>,
  accounts: Map<string, ReportAccount>,
): AccountHealth {
  let worst: AccountStatus = "ACTIVE";
  let outOfBudget = false;
  let reason: string | null = null;
  let seen = false;
  for (const id of accountIds) {
    const a = accounts.get(id);
    if (a?.deliverable) return { status: "ACTIVE", reason: null };
    seen = true;
    const status = a?.status ?? "PENDING";
    // Status says ACTIVE yet it cannot deliver: the cap is exhausted, not the account banned.
    if (status === "ACTIVE") outOfBudget = true;
    else if (SEVERITY[status] > SEVERITY[worst]) {
      worst = status;
      reason = a?.disableReason ?? null;
    } else if (status === worst && reason === null) reason = a?.disableReason ?? null;
  }
  // No accounts at all behind the engagement's campaigns. Nothing is known to be broken, and
  // inventing a fault would be worse than saying nothing.
  if (!seen) return { status: "ACTIVE", reason: null };
  if (worst === "ACTIVE") return { status: outOfBudget ? "OUT_OF_BUDGET" : "ACTIVE", reason: null };
  return { status: worst, reason };
}

/**
 * Roll included campaigns up to one row per owning Notion engagement, sorted by spend descending.
 *
 * Campaigns with no owner are DROPPED, so the report's total is explicitly a total of named
 * engagements rather than of the day — the renderer says so. Attribution itself is not decided here:
 * `clientId` arrives already resolved through the one ownership ladder, because attributing by ad
 * account instead would give every claimant of a shared account its full spend.
 */
export function aggregateEngagements(
  campaigns: ReportCampaign[],
  accounts: Map<string, ReportAccount>,
): EngagementRow[] {
  const groups = new Map<string, { name: string; campaigns: ReportCampaign[] }>();
  for (const c of campaigns) {
    if (!includeCampaign(c)) continue;
    if (!c.clientId) continue;
    const g = groups.get(c.clientId);
    if (g) g.campaigns.push(c);
    else groups.set(c.clientId, { name: c.clientName ?? c.clientId, campaigns: [c] });
  }
  const rows: EngagementRow[] = [];
  for (const [clientId, g] of groups) {
    const byCurrency = new Map<string, number>();
    const accountIds = new Set<string>();
    for (const c of g.campaigns) {
      accountIds.add(c.accountId);
      const currency = accounts.get(c.accountId)?.currency ?? "USD";
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + c.spend);
    }
    const spend = [...byCurrency]
      // Rounded per currency, not on the sum: cents-level float drift otherwise shows up as a
      // trailing 0.01 that will not reconcile against Meta's own per-day figure.
      .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency, "en"));
    rows.push({
      clientId,
      name: g.name,
      spend,
      sortSpend: spend.reduce((n, s) => n + s.amount, 0),
      results: collapseResults(g.campaigns),
      health: engagementDelivery(accountIds, accounts),
      campaignCount: g.campaigns.length,
    });
  }
  // Name is the tie-break so a day where several engagements spent nothing still has a stable order
  // rather than one that follows Map insertion (i.e. whatever order Postgres returned).
  return rows.sort((a, b) => b.sortSpend - a.sortSpend || a.name.localeCompare(b.name, "en"));
}
