import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getNotionCredentials } from "@/lib/credentials";
import {
  NotionClient,
  type NotionPage,
  type NotionProp,
  type NotionPropSchema,
} from "@/notion/client";
import {
  ACCOUNT_STATUS_COLUMN,
  LIVE_STATUSES,
  parseCampaignRow,
  resolvePropertyKey,
} from "@/notion/parse";
import {
  deriveStatus,
  isMachineStatus,
  MACHINE_STATUSES,
  type MachineStatus,
  type StatusAccount,
  type StatusAd,
  type StatusAdSet,
  type StatusCampaign,
} from "@/lib/delivery-status";
import { attributeCampaign, brandVocab, type BrandVocab } from "@/lib/attribution";
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";
import { accountStatus } from "@/server/agg";
import { addDays } from "@/lib/range";
import { effectiveAccountIds } from "./clients";
import { forecastBudgetEnd, paceWindow, PACE_DAYS } from "@/lib/budget-forecast";
import { clickDestinations, groupByLandingPage } from "@/lib/creative-links";

/**
 * Maintain three auto-updated columns on the Notion campaigns board: the daily budget that can
 * ACTUALLY be spent, what was actually spent per day recently, and when the engagement budget is
 * projected to run out.
 *
 * Meta exposes no account-level daily budget: it lives on the campaign (CBO) or on each ad set
 * (ABO), never both, so one level per campaign sums exactly. A board row can span many ad accounts
 * and campaigns; every one it owns is added up.
 *
 * The trap this job exists to avoid: **a campaign's `effective_status` says nothing about whether its
 * ad account can spend.** Meta enforces two stops one level up — the account being DISABLED, and a
 * prepaid `spend_cap` being exhausted — and campaigns on such accounts keep reporting ACTIVE
 * forever. On rented, prepaid accounts (the common case here) that made a naive sum overstate the
 * budget by up to 71×. Both stops are checked from data already synced hourly.
 *
 * The end-date projection has its own trap: ad accounts are recycled between engagements, so
 * LIFETIME spend on a row's accounts is far larger than the engagement budget (betonline.ag: $27k
 * lifetime against a $10.8k budget). Spend is therefore counted only from the row's own start date,
 * which is what makes `Budget ($) − spent` a true remaining figure.
 *
 * It writes a SEPARATE column and never touches Notion's `End Date (Estimated)`, for two reasons:
 * that column is what was *planned*, and comparing plan against projection is the overrun signal the
 * dashboard is built on; and `clubClients` picks each client's current engagement by latest end date,
 * so writing computed dates there would feed back into which row supplies the budget the projection
 * is derived from.
 *
 * Ownership reuses the dashboard's attribution: the client-level whitelist first (an account reused
 * by a later client), then a name split between sibling rows of one client that share an account, so
 * a shared account is never counted twice.
 */

/** Board columns this job owns. `End Date (Estimated)` and `Budget ($)` are deliberately NOT among
 *  them — the first records what was planned, the second what was contracted. Both are human-owned. */
export const BUDGET_COLUMN = "Daily Budget ($)";
export const SPEND_COLUMN = "Avg Daily Spend 7d ($)";
export const FUNDS_COLUMN = "Funds Remaining ($)";
export const PROJECTED_END_COLUMN = "Projected End Date";
export const DESTINATION_COLUMN = "Destination URL";
export const BUDGET_REMAINING_COLUMN = "Budget Remaining ($)";
/** Stamped onto every column name so the team can see the values are machine-written. */
export const AUTO_MARKER = "🤖";
export const AUTO_BUDGET_COLUMN = `${AUTO_MARKER} ${BUDGET_COLUMN}`;
export const AUTO_SPEND_COLUMN = `${AUTO_MARKER} ${SPEND_COLUMN}`;
export const AUTO_FUNDS_COLUMN = `${AUTO_MARKER} ${FUNDS_COLUMN}`;
export const AUTO_PROJECTED_END_COLUMN = `${AUTO_MARKER} ${PROJECTED_END_COLUMN}`;
export const AUTO_DESTINATION_COLUMN = `${AUTO_MARKER} ${DESTINATION_COLUMN}`;
export const AUTO_BUDGET_REMAINING_COLUMN = `${AUTO_MARKER} ${BUDGET_REMAINING_COLUMN}`;
/**
 * Marked like the rest, because the machine does write it — but unlike the rest it is SHARED: the
 * machine owns the five delivery states and the team keeps the four commercial ones, so the marker
 * here means "machine-maintained", not "hands off". See `src/lib/delivery-status.ts` for the split.
 */
export const AUTO_ACCOUNT_STATUS_COLUMN = `${AUTO_MARKER} ${ACCOUNT_STATUS_COLUMN}`;
/**
 * Where delivered spend actually landed. A SEPARATE column from the board's `Geo's`, which records
 * the brief - prose, ranked preferences, even budget splits - and stays human-owned forever.
 *
 * The name is load-bearing. `ensureColumn` resolves by `keyShape`, which strips punctuation and the
 * emoji marker, and it RENAMES whatever it matches. `keyShape("Geo's") === keyShape("🤖 Geo's")`, so
 * naming this column after the brief would rename the brief and start overwriting it. The window is
 * in the name for the same reason it is in `Avg Daily Spend 7d ($)`: a percentage split is
 * meaningless without one.
 */
export const GEO_COLUMN = "Geo Delivered 14d";
export const AUTO_GEO_COLUMN = `${AUTO_MARKER} ${GEO_COLUMN}`;

/** Notion rejects a rich_text value over 2000 characters. */
const TEXT_CELL_LIMIT = 2000;

/**
 * The destinations for one row, as the cell text: one URL per line, most-spending first.
 *
 * Only what a click actually opens (see `clickDestinations`), de-duplicated to one entry per landing
 * page so a tracker carrying per-ad utm parameters does not fill the cell with the same page twice.
 * Over the cell limit the list is truncated with a count, never silently cut mid-URL.
 */
export function destinationCell(urls: string[]): string {
  const lines: string[] = [];
  for (const u of urls) {
    const next = lines.length ? `${lines.join("\n")}\n${u}` : u;
    if (next.length > TEXT_CELL_LIMIT) {
      const note = `… +${urls.length - lines.length} more`;
      while (lines.length && `${lines.join("\n")}\n${note}`.length > TEXT_CELL_LIMIT) lines.pop();
      lines.push(note);
      break;
    }
    lines.push(u);
  }
  return lines.join("\n");
}

/** Complete days averaged for the spend column. Today is excluded — it is partial until it syncs. */
export const SPEND_WINDOW_DAYS = 7;

/** Days a contracted engagement budget is spread over to get its target daily spend. */
export const TARGET_BUDGET_DAYS = 30;

/**
 * The daily spend this engagement is TARGETING: its contracted budget spread over a month.
 *
 * This is a goal, not an observation. It deliberately does not consult Meta — what the campaigns are
 * set to spend today is a separate fact, and the trailing actual sits in the spend column next to it,
 * so the two can be compared. Null when the row records no budget to spread.
 */
export function targetDailyBudget(notionBudget: number | null): number | null {
  if (notionBudget === null || !(notionBudget > 0)) return null;
  return Math.round((notionBudget / TARGET_BUDGET_DAYS) * 100) / 100;
}

/** Remaining spend-cap headroom below which an account is treated as unable to deliver. Meta reports
 *  a 1-cent cap on blocked accounts, so a bare `> 0` test would let those through. */
const HEADROOM_MIN_USD = 1;

/** The columns are denominated in dollars; another currency cannot be summed in without an FX rate. */
const COLUMN_CURRENCY = "USD";

/** Notion allows ~3 requests/second. Writes are sequential and paced under that. */
const WRITE_GAP_MS = 350;

export interface AccountDelivery {
  /** Meta `account_status`, raw as stored (numeric code or mapped label). */
  status: string | null;
  /** Lifetime spend ceiling in minor units; null/0 = uncapped. */
  spendCap: number | null;
  /** Lifetime spend to date in minor units. */
  amountSpent: number | null;
}

/**
 * Can this account still spend today? Campaign status cannot answer this: Meta stops delivery at the
 * account level when the account is disabled or its prepaid cap is exhausted, and leaves the
 * campaigns underneath reporting ACTIVE.
 */
export function canDeliver(a: AccountDelivery): boolean {
  if (accountStatus(a.status) !== "ACTIVE") return false;
  const cap = a.spendCap ?? 0;
  if (cap <= 0) return true; // uncapped
  return (cap - (a.amountSpent ?? 0)) / 100 > HEADROOM_MIN_USD;
}

/**
 * Whether to push the funded-money figure onto a row. This is `spend_cap − amount_spent` summed over
 * the accounts the row can actually spend from — the number that decides when delivery stops, and the
 * input the projected end date is derived from.
 */
export function planFundsRow(input: {
  status: string | null;
  current: number | null;
  funds: number | null;
}): RowPlan {
  const { status, current, funds } = input;
  if (notLive(status))
    return { dollars: null, skip: "not a live engagement; keeping the recorded value" };
  if (funds === null) return { dollars: null, skip: "funds not determinable" };
  if (same(current, funds)) return { dollars: null, skip: "unchanged" };
  return { dollars: funds, skip: null };
}
/**
 * Whether to push the contract's remaining budget onto a row: `Budget ($)` minus what this engagement
 * has spent since its start date.
 *
 * A different question from `Funds Remaining ($)`, and both are worth having. This is commercial — how
 * much of what the client agreed to is left — while funds are operational: money actually sitting in
 * the ad accounts, which is what stops delivery. They diverge whenever an account is topped up beyond
 * the contract or recycled from an earlier engagement.
 *
 * Spend is counted from the engagement's OWN start date, never lifetime: these ad accounts carry
 * previous clients, and lifetime spend would report almost every engagement as exhausted.
 *
 * A negative result is written as-is. Overspending the contract is exactly what this column exists to
 * make visible, and clamping it to zero would hide the overrun.
 */
export function planBudgetRemainingRow(input: {
  status: string | null;
  current: number | null;
  remaining: number | null;
}): RowPlan {
  const { status, current, remaining } = input;
  if (notLive(status))
    return { dollars: null, skip: "not a live engagement; keeping the recorded value" };
  if (remaining === null) return { dollars: null, skip: "budget remaining not determinable" };
  if (same(current, remaining)) return { dollars: null, skip: "unchanged" };
  return { dollars: remaining, skip: null };
}

/**
 * Contracted budget minus spend since the engagement started, or null when either side is unknown.
 * Rounded to cents so the cell matches a hand calculation.
 */
export function budgetRemaining(
  notionBudget: number | null,
  spentSinceStart: number | null,
): number | null {
  if (notionBudget === null || spentSinceStart === null) return null;
  return Math.round((notionBudget - spentSinceStart) * 100) / 100;
}

export interface AttributedCampaign {
  id: string;
  accountId: string;
  name: string;
  dailyBudget: number | null; // account minor units (cents)
  lifetimeBudget: number | null;
  /** `effective_status === "ACTIVE"`. */
  active: boolean;
  /** Its ad account can still spend today (see `canDeliver`). */
  deliverable: boolean;
}

export interface ActiveAdSet {
  campaignId: string;
  dailyBudget: number | null; // account minor units (cents)
}

export interface DailyBudgetSum {
  /** Major units (dollars) of daily budget that can actually be spent. */
  dollars: number;
  /** Campaigns that contributed. */
  campaigns: number;
  /** ACTIVE campaigns carrying a LIFETIME budget: running, but with no daily figure to report. */
  lifetimeOnly: number;
  /** ACTIVE campaigns excluded because their account is disabled or out of prepaid funding. */
  blocked: number;
}

/**
 * Daily budget in force across `campaigns`, in major units. A campaign holding its own daily budget
 * is CBO (its ad sets carry none); a campaign with no budget of its own is ABO and takes the sum of
 * its ad sets. Meta enforces that split, so nothing is double-counted. Campaigns that are not ACTIVE,
 * or whose account cannot spend, contribute nothing.
 */
export function sumDailyBudget(
  campaigns: AttributedCampaign[],
  adSets: ActiveAdSet[],
): DailyBudgetSum {
  let minor = 0;
  let lifetimeOnly = 0;
  let blocked = 0;
  const contributing = new Set<string>();
  const abo = new Set<string>();
  for (const c of campaigns) {
    if (!c.active) continue;
    if (!c.deliverable) {
      blocked += 1;
      continue;
    }
    if (c.dailyBudget != null) {
      minor += c.dailyBudget;
      contributing.add(c.id);
    } else if (c.lifetimeBudget != null) {
      lifetimeOnly += 1;
    } else {
      abo.add(c.id);
    }
  }
  for (const s of adSets) {
    if (s.dailyBudget == null || !abo.has(s.campaignId)) continue;
    minor += s.dailyBudget;
    contributing.add(s.campaignId);
  }
  return {
    dollars: Math.round(minor) / 100,
    campaigns: contributing.size,
    lifetimeOnly,
    blocked,
  };
}

/** Average daily spend over the window, rounded to cents. */
export function avgDailySpend(totalSpend: number, days: number = SPEND_WINDOW_DAYS): number {
  return Math.round((totalSpend / days) * 100) / 100;
}

export interface RowPlan {
  /** Value to write, or null when this row is left alone. */
  dollars: number | null;
  skip: string | null;
}

/** Only rows whose engagement is currently live are machine-owned. */
const notLive = (status: string | null): boolean =>
  status === null || !LIVE_STATUSES.includes(status);

/** An unchanged cell is never rewritten, so `Last edited time` keeps meaning "a human edited this". */
const same = (current: number | null, value: number): boolean =>
  current !== null && Math.abs(current - value) < 0.005;

/**
 * The `Account Status` to WRITE for one row, or null to leave the cell alone.
 *
 * Ownership is read straight off the current value, which is why the machine and human value sets
 * must stay disjoint. The gate is deliberately NOT `notLive`: `On Boarding` and `Budget Finished -
 * Top Up` are human-owned but ARE in `LIVE_STATUSES`, so a `notLive` gate would happily overwrite the
 * team's own record on those rows. Only membership of the machine set decides ownership.
 *
 * The empty-cell branch below is unreachable from the job today: a row with no status is `notLive`,
 * and non-live rows are excluded from account→row attribution upstream, so they arrive with no
 * campaigns and derive nothing. The feature MAINTAINS a status, it does not BOOTSTRAP one — a human
 * sets a machine value once, and the sync keeps it true from then on.
 */
export function statusForRow(args: {
  accounts: StatusAccount[];
  campaigns: StatusCampaign[];
  adSets: StatusAdSet[];
  ads: StatusAd[];
  current: string | null;
  override: string | null;
}): MachineStatus | null {
  // A human-owned value is the team's record and beats everything, including a pinned override.
  if (args.current !== null && !isMachineStatus(args.current)) return null;
  const next = isMachineStatus(args.override)
    ? args.override
    : deriveStatus({
        accounts: args.accounts,
        campaigns: args.campaigns,
        adSets: args.adSets,
        ads: args.ads,
      });
  return next === null || next === args.current ? null : next;
}

/**
 * Whether to push the target daily budget onto a row.
 *
 * A finished or paused engagement is left alone: its contracted budget belongs to a closed period and
 * the recorded figure is the only account of it.
 */
export function planRow(input: {
  status: string | null;
  current: number | null;
  target: number | null;
}): RowPlan {
  const { status, current, target } = input;
  if (notLive(status))
    return { dollars: null, skip: "not a live engagement; keeping the recorded value" };
  if (target === null)
    return {
      dollars: null,
      skip: `no Budget ($) on this row to spread over ${TARGET_BUDGET_DAYS} days`,
    };
  if (same(current, target)) return { dollars: null, skip: "unchanged" };
  return { dollars: target, skip: null };
}

/**
 * Whether to push the trailing average daily spend onto a row. Unlike the budget, spend is historical
 * fact: it counts every campaign the row owns, including ones on accounts that have since been
 * disabled or run out of funding.
 */
export function planSpendRow(input: {
  status: string | null;
  current: number | null;
  spend: number | null;
}): RowPlan {
  const { status, current, spend } = input;
  if (notLive(status))
    return { dollars: null, skip: "not a live engagement; keeping the recorded value" };
  if (spend === null) return { dollars: null, skip: "no synced ad accounts on this row" };
  if (same(current, spend)) return { dollars: null, skip: "unchanged" };
  return { dollars: spend, skip: null };
}

export interface DatePlan {
  date: string | null;
  /** Blank an existing value: a live row we can no longer project must not keep a stale date. */
  clear: boolean;
  skip: string | null;
}

/**
 * Whether to push a projected burn-out date onto a row. `reason` is the forecaster's own explanation
 * for having no date (no budget, no recent spend, pace too low), surfaced verbatim so a blank cell is
 * always explainable.
 */
export function planEndDate(input: {
  status: string | null;
  current: string | null;
  projected: string | null;
  reason: string | null;
}): DatePlan {
  const { status, current, projected, reason } = input;
  if (notLive(status)) return { date: null, clear: false, skip: "not a live engagement" };
  if (projected === null)
    // A live row whose projection has become unsupportable gets its date blanked rather than left
    // showing a figure nothing stands behind any more.
    return { date: null, clear: current !== null, skip: reason ?? "not forecastable" };
  if (current === projected) return { date: null, clear: false, skip: "unchanged" };
  return { date: projected, clear: false, skip: null };
}

export interface NotionBudgetRow {
  pageId: string;
  title: string;
  status: string | null;
  /** Accounts this row was computed from (after attribution). */
  accountIds: string[];
  campaigns: number;
  /** ACTIVE campaigns whose account cannot spend (disabled or out of prepaid funding). */
  blocked: number;
  budgetCurrent: number | null;
  budgetWritten: number | null;
  budgetSkip: string | null;
  spendCurrent: number | null;
  spendWritten: number | null;
  spendSkip: string | null;
  fundsCurrent: number | null;
  fundsWritten: number | null;
  fundsSkip: string | null;
  remainingCurrent: number | null;
  remainingWritten: number | null;
  remainingSkip: string | null;
  /** `Budget ($)` minus spend since the engagement's start date; negative when overspent. */
  budgetRemaining: number | null;
  /** spend_cap - amount_spent across the accounts this row can actually spend from. */
  fundsRemaining: number | null;
  /** Campaigns attributed to this row, whatever their status — the pool spend is summed over. */
  assignedCampaigns: number;
  /** Inputs behind the projection, kept so a written date can be audited without re-running. */
  notionBudget: number | null;
  startDate: string | null;
  spentSinceStart: number | null;
  dailyPace: number | null;
  daysRemaining: number | null;
  endCurrent: string | null;
  /** The date the projection produced, even when no column existed to write it to (dry runs). */
  endProposed: string | null;
  endWritten: string | null;
  /** Destination cell as it stood, what was written (null = untouched), and why when skipped. */
  destCurrent: string;
  destWritten: string | null;
  destSkip: string | null;
  /** Derived delivery status written to `Account Status`, or null when the cell was left alone. */
  statusWritten: MachineStatus | null;
  /** True when a stale date was blanked because the row can no longer be projected. */
  endCleared: boolean;
  endSkip: string | null;
}

export interface NotionBudgetResult {
  rows: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** Columns this run renamed or created. */
  columnsTouched: string[];
  /** Non-fatal problem worth surfacing in health. */
  warning: string | null;
  details: NotionBudgetRow[];
}

interface RawPage {
  pageId: string;
  title: string;
  accountIds: string[];
}

/** Contributing board rows stored on a client, narrowed from jsonb. */
function rawPages(raw: unknown): RawPage[] {
  if (!Array.isArray(raw)) return [];
  const out: RawPage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { pageId, title, accountIds } = entry as {
      pageId?: unknown;
      title?: unknown;
      accountIds?: unknown;
    };
    if (typeof pageId !== "string") continue;
    out.push({
      pageId,
      title: typeof title === "string" ? title : "",
      accountIds: Array.isArray(accountIds) ? accountIds.filter((a) => typeof a === "string") : [],
    });
  }
  return out;
}

/** A page property's stable id (present on every value Notion returns). */
const propId = (p: NotionProp): string | null => (typeof p.id === "string" ? p.id : null);

/** Read a page's number cell by column id, so a renamed column still resolves. */
function numberCell(page: NotionPage, id: string): number | null {
  for (const p of Object.values(page.properties ?? {})) {
    if (propId(p) !== id) continue;
    return typeof p.number === "number" ? p.number : null;
  }
  return null;
}

/** Read a page's date cell (start only) by column id. */
function dateCell(page: NotionPage, id: string): string | null {
  for (const p of Object.values(page.properties ?? {})) {
    if (propId(p) !== id) continue;
    const d = p.date as { start?: unknown } | null | undefined;
    return typeof d?.start === "string" ? d.start.slice(0, 10) : null;
  }
  return null;
}

export interface TextPlan {
  /** Cell text to write, or null when nothing should be written. */
  text: string | null;
  skip: string | null;
}

/**
 * The destination cell for one row: where its live ads actually send people.
 *
 * Non-live rows are never written (their ads are not running, and the recorded value is history).
 * A live row with no live ads has its cell cleared, because a stale destination is worse than an
 * empty one — it reads as "we are sending traffic here" when nothing is running.
 */
export function planDestinations(input: {
  status: string | null;
  current: string;
  urls: string[];
}): TextPlan {
  const { status, current, urls } = input;
  if (notLive(status)) return { text: null, skip: "not a live engagement" };
  const text = destinationCell(urls);
  if (!text) {
    // Clearing beats leaving a stale page that reads as "traffic goes here" when nothing is running.
    return current.trim()
      ? { text: "", skip: null }
      : { text: null, skip: "no live ads with a link" };
  }
  if (text === current.trim()) return { text: null, skip: "unchanged" };
  return { text, skip: null };
}

/**
 * Why a row's geo cannot be derived, or null when it can.
 *
 * Deliberately NOT the cascade the dollar columns use. That one also refuses a foreign account
 * currency (`COLUMN_CURRENCY`), because summing money across currencies needs an FX rate. A
 * percentage split does not, so a row whose accounts are denominated elsewhere still gets a cell -
 * and currency is therefore absent from this signature rather than merely unused in it.
 */
export function geoSkipReason(input: {
  ambiguous: boolean;
  accountIds: string[];
  syncedAccountIds: string[];
}): string | null {
  const { ambiguous, accountIds, syncedAccountIds } = input;
  if (ambiguous) return "campaigns on a shared account could not be split by name";
  if (accountIds.length === 0) return "no ad accounts on this row";
  if (syncedAccountIds.length === 0) return "row's ad accounts are not visible to the Meta token";
  return null;
}

/** Read a page's rich-text cell by column id, flattened to plain text. */
function textCell(page: NotionPage, id: string): string {
  for (const p of Object.values(page.properties ?? {})) {
    if (propId(p) !== id) continue;
    const parts = (p.rich_text ?? []) as { plain_text?: unknown }[];
    return parts
      .map((t) => (typeof t.plain_text === "string" ? t.plain_text : ""))
      .join("")
      .trim();
  }
  return "";
}

interface ClientCtx {
  id: string;
  pageIds: string[];
  manualRemove: Set<string>;
  effective: string[];
  /** Campaign whitelist from cross-client attribution; null = no restriction needed. */
  owned: Set<string> | null;
}

interface BoardRow {
  pageId: string;
  title: string;
  status: string | null;
  budgetCurrent: number | null;
  spendCurrent: number | null;
  fundsCurrent: number | null;
  remainingCurrent: number | null;
  endCurrent: string | null;
  destCurrent: string;
  accountIds: string[];
  /** The row's OWN engagement budget and start date, straight off the board. */
  notionBudget: number | null;
  startDate: string | null;
}

/** Resolve a column by name, creating it when absent, and stamp the auto-update marker on it. */
async function ensureColumn(
  notion: NotionClient,
  dsId: string,
  props: Record<string, NotionPropSchema>,
  plainName: string,
  markedName: string,
  kind: "number" | "date" | "rich_text",
  touched: string[],
  dryRun: boolean,
): Promise<{ column: NotionPropSchema; error: string | null } | null> {
  const existing = resolvePropertyKey(Object.keys(props), plainName);
  if (!existing) {
    if (dryRun) {
      touched.push(`would create "${markedName}"`);
      return null; // no id to write against, so this column reports as skipped
    }
    const created = await notion.createProperty(
      dsId,
      markedName,
      kind === "number"
        ? { number: { format: "dollar" } }
        : kind === "date"
          ? { date: {} }
          : { rich_text: {} },
      kind === "number" ? { number: {} } : undefined,
    );
    if (!created) return null;
    touched.push(`created "${markedName}"`);
    return { column: created, error: null };
  }
  const column = props[existing];
  if (column.type !== kind)
    return { column, error: `"${existing}" is a ${column.type} column, not a ${kind}` };
  if (!existing.startsWith(AUTO_MARKER)) {
    if (dryRun) {
      touched.push(`would rename "${existing}" → "${markedName}"`);
      return { column, error: null };
    }
    try {
      await notion.renameProperty(dsId, existing, markedName);
      touched.push(`renamed "${existing}" → "${markedName}"`);
    } catch (e) {
      return {
        column,
        error: `could not rename "${existing}": ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return { column, error: null };
}

/**
 * Recompute all three auto-updated columns from live Meta data and write back only what changed.
 * Returns null when Notion is not configured.
 *
 * `dryRun` computes and reports everything without touching Notion (columns are still resolved, but
 * nothing is created, renamed or written). This job mutates a board the whole team works in, so being
 * able to inspect a run before it lands is worth the branch.
 */
export async function syncNotionDailyBudgets(
  client?: NotionClient,
  opts: { dryRun?: boolean } = {},
): Promise<NotionBudgetResult | null> {
  const creds = await getNotionCredentials();
  if (!creds) return null;
  const notion = client ?? new NotionClient(creds.token);

  const today = new Date().toISOString().slice(0, 10);
  const until = addDays(today, -1); // last complete day
  const since = addDays(until, -(SPEND_WINDOW_DAYS - 1));
  const paceSince = addDays(until, -(PACE_DAYS - 1));

  /**
   * Campaign-level spend for a set of campaigns over a closed window. Campaign level reconciles
   * exactly with account level on this data, so it is safe to sum here and it keeps the figure
   * attribution-aware (a recycled account's other campaigns are excluded by the caller).
   */
  const spendOf = async (campaignIds: string[], from: string, to: string): Promise<number> => {
    if (campaignIds.length === 0) return 0;
    const [r] = await db
      .select({ s: sql<number>`coalesce(sum(${schema.insightsDaily.spend}), 0)` })
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, "campaign"),
          inArray(schema.insightsDaily.entityId, campaignIds),
          gte(schema.insightsDaily.date, from),
          lte(schema.insightsDaily.date, to),
        ),
      );
    return Number(r?.s ?? 0);
  };

  const [campaignRows, adSetRows, accountRows, clientRows, spendRows, adLinkRows, allAdRows] =
    await Promise.all([
      db
        .select({
          id: schema.campaigns.id,
          accountId: schema.campaigns.accountId,
          name: schema.campaigns.name,
          dailyBudget: schema.campaigns.dailyBudget,
          lifetimeBudget: schema.campaigns.lifetimeBudget,
          effectiveStatus: schema.campaigns.effectiveStatus,
        })
        .from(schema.campaigns),
      // NOT filtered to ACTIVE: the status ladder has to tell "no ad set is active" apart from "no ad
      // set has synced", and only the unfiltered set can. Budget summing filters in memory instead.
      db
        .select({
          id: schema.adSets.id,
          campaignId: schema.adSets.campaignId,
          dailyBudget: schema.adSets.dailyBudget,
          effectiveStatus: schema.adSets.effectiveStatus,
        })
        .from(schema.adSets),
      db
        .select({
          id: schema.accounts.id,
          currency: schema.accounts.currency,
          status: schema.accounts.status,
          spendCap: schema.accounts.spendCap,
          amountSpent: schema.accounts.amountSpent,
        })
        .from(schema.accounts),
      db.select().from(schema.clients).where(isNull(schema.clients.removedAt)),
      db
        .select({
          entityId: schema.insightsDaily.entityId,
          spend: sql<number>`sum(${schema.insightsDaily.spend})`,
        })
        .from(schema.insightsDaily)
        .where(
          and(
            eq(schema.insightsDaily.level, "campaign"),
            gte(schema.insightsDaily.date, since),
            lte(schema.insightsDaily.date, until),
          ),
        )
        .groupBy(schema.insightsDaily.entityId),
      // ACTIVE ads only: a paused ad's destination is not a page anyone is being sent to. Meta's
      // effective_status already folds in the parent ad set and campaign, so an ACTIVE ad is live.
      db
        .select({
          campaignId: schema.adSets.campaignId,
          spend: schema.insightsDaily.spend,
          objectStorySpec: schema.adCreatives.objectStorySpec,
          assetFeedSpec: schema.adCreatives.assetFeedSpec,
        })
        .from(schema.ads)
        .innerJoin(schema.adSets, eq(schema.adSets.id, schema.ads.adSetId))
        .innerJoin(schema.adCreatives, eq(schema.adCreatives.id, schema.ads.creativeId))
        .leftJoin(
          schema.insightsDaily,
          and(
            eq(schema.insightsDaily.level, "ad"),
            eq(schema.insightsDaily.entityId, schema.ads.id),
            gte(schema.insightsDaily.date, since),
          ),
        )
        .where(eq(schema.ads.effectiveStatus, "ACTIVE")),
      // Every ad, status included: "all ads rejected" needs the complement of the ACTIVE set above,
      // and an empty result has to stay distinguishable from "all disapproved".
      db
        .select({
          adSetId: schema.ads.adSetId,
          effectiveStatus: schema.ads.effectiveStatus,
        })
        .from(schema.ads),
    ]);

  const currencyOf = new Map(accountRows.map((a) => [a.id, a.currency]));
  const deliverable = new Set(accountRows.filter((a) => canDeliver(a)).map((a) => a.id));
  const accountById = new Map(accountRows.map((a) => [a.id, a]));
  const spendByCampaign = new Map(spendRows.map((r) => [r.entityId, Number(r.spend ?? 0)]));
  // sumDailyBudget assumes every ad set it is handed is live; the status ladder needs all of them.
  const activeAdSetRows = adSetRows.filter((s) => s.effectiveStatus === "ACTIVE");
  // Shaped once for the whole cycle: both are whole-table projections that depend on no board row, and
  // rebuilding them per row allocated on the order of 10^5 throwaway objects for an identical result.
  const ladderAdSets: StatusAdSet[] = adSetRows.map((s) => ({
    id: s.id,
    campaignId: s.campaignId,
    active: s.effectiveStatus === "ACTIVE",
  }));
  const ladderAds: StatusAd[] = allAdRows.map((a) => ({
    adSetId: a.adSetId,
    disapproved: a.effectiveStatus === "DISAPPROVED",
  }));

  const byAccount = new Map<string, AttributedCampaign[]>();
  for (const c of campaignRows) {
    const campaign: AttributedCampaign = {
      id: c.id,
      accountId: c.accountId,
      name: c.name,
      dailyBudget: c.dailyBudget,
      lifetimeBudget: c.lifetimeBudget,
      active: c.effectiveStatus === "ACTIVE",
      deliverable: deliverable.has(c.accountId),
    };
    const list = byAccount.get(c.accountId);
    if (list) list.push(campaign);
    else byAccount.set(c.accountId, [campaign]);
  }

  // campaign -> its live ads' click destinations, with the recent spend behind each so a row's cell
  // leads with the page actually receiving the traffic.
  const destSpendByCampaign = new Map<string, Map<string, number>>();
  for (const r of adLinkRows) {
    const urls = clickDestinations(r);
    if (urls.length === 0) continue;
    let byUrl = destSpendByCampaign.get(r.campaignId);
    if (!byUrl) destSpendByCampaign.set(r.campaignId, (byUrl = new Map()));
    // An ad rotating several destinations gives no per-URL split, so its spend counts for each.
    for (const u of urls) byUrl.set(u, (byUrl.get(u) ?? 0) + Number(r.spend ?? 0));
  }

  // Total daily draw on each account by EVERY campaign spending from it, whoever owns them. A prepaid
  // balance is consumed by everything drawing on it, so an engagement's claim on that balance is its
  // share of the draw. Two live engagements on one account then project to the same day — the day the
  // pot actually empties — instead of both being refused a date.
  const poolDaily = new Map<string, number>();
  for (const [a, cs] of byAccount) poolDaily.set(a, sumDailyBudget(cs, activeAdSetRows).dollars);

  // pageId -> owning client. The cross-client whitelist is resolved lazily: it costs several queries
  // per client and only matters for clients that actually have campaigns on their accounts.
  const ctxByPage = new Map<string, ClientCtx>();
  for (const c of clientRows) {
    const effective = effectiveAccountIds(c);
    const ctx: ClientCtx = {
      id: c.id,
      pageIds: rawPages(c.raw).map((p) => p.pageId),
      manualRemove: new Set((c.manualRemoveIds as string[] | null) ?? []),
      effective,
      owned: null,
    };
    if (effective.some((a) => byAccount.has(a))) {
      const whitelist = await ownedCampaignIds(c.id, effective);
      ctx.owned = whitelist ? new Set(whitelist) : null;
    }
    for (const pid of ctx.pageIds) ctxByPage.set(pid, ctx);
  }

  const result: NotionBudgetResult = {
    rows: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    columnsTouched: [],
    warning: null,
    details: [],
  };

  for (const dsId of await notion.getDataSourceIds(creds.dbId)) {
    const props = await notion.getProperties(dsId);
    // Only maintain data sources that already carry the budget column — that is the campaigns board.
    if (!resolvePropertyKey(Object.keys(props), BUDGET_COLUMN)) continue;

    const budgetCol = await ensureColumn(
      notion,
      dsId,
      props,
      BUDGET_COLUMN,
      AUTO_BUDGET_COLUMN,
      "number",
      result.columnsTouched,
      opts.dryRun ?? false,
    );
    if (!budgetCol) continue;
    if (budgetCol.error) {
      result.warning = budgetCol.error;
      if (budgetCol.column.type !== "number") continue;
    }
    const spendCol = await ensureColumn(
      notion,
      dsId,
      props,
      SPEND_COLUMN,
      AUTO_SPEND_COLUMN,
      "number",
      result.columnsTouched,
      opts.dryRun ?? false,
    );
    if (spendCol?.error) result.warning = spendCol.error;
    const fundsCol = await ensureColumn(
      notion,
      dsId,
      props,
      FUNDS_COLUMN,
      AUTO_FUNDS_COLUMN,
      "number",
      result.columnsTouched,
      opts.dryRun ?? false,
    );
    if (fundsCol?.error) result.warning = fundsCol.error;
    const remainingCol = await ensureColumn(
      notion,
      dsId,
      props,
      BUDGET_REMAINING_COLUMN,
      AUTO_BUDGET_REMAINING_COLUMN,
      "number",
      result.columnsTouched,
      opts.dryRun ?? false,
    );
    if (remainingCol?.error) result.warning = remainingCol.error;
    const endCol = await ensureColumn(
      notion,
      dsId,
      props,
      PROJECTED_END_COLUMN,
      AUTO_PROJECTED_END_COLUMN,
      "date",
      result.columnsTouched,
      opts.dryRun ?? false,
    );
    if (endCol?.error) result.warning = endCol.error;
    const destCol = await ensureColumn(
      notion,
      dsId,
      props,
      DESTINATION_COLUMN,
      AUTO_DESTINATION_COLUMN,
      "rich_text",
      result.columnsTouched,
      opts.dryRun ?? false,
    );
    if (destCol?.error) result.warning = destCol.error;

    // Resolved by name rather than through ensureColumn, which would CREATE the column when absent —
    // wrong for a status property, whose options and groups the API cannot fully configure. Options
    // are appended before the rename so `statusKey` still names the column Notion knows.
    const statusKey = resolvePropertyKey(Object.keys(props), ACCOUNT_STATUS_COLUMN);
    let statusCol = statusKey ? props[statusKey] : undefined;
    if (statusKey && statusCol && !opts.dryRun) {
      // A schema-bootstrap failure must degrade the status feature only. Left unguarded these awaits
      // sit before every write in the loop, so one Notion hiccup would cost the whole board its
      // budget, spend, funds, date and destination values for the day.
      try {
        const added = await notion.addStatusOptions(dsId, statusKey, [...MACHINE_STATUSES]);
        if (added.length > 0) result.columnsTouched.push(`added options: ${added.join(", ")}`);
        if (!statusKey.startsWith(AUTO_MARKER)) {
          // Safe because Notion references properties by id everywhere that matters, and the read
          // side resolves this column by shape rather than by exact name.
          await notion.renameProperty(dsId, statusKey, AUTO_ACCOUNT_STATUS_COLUMN);
          result.columnsTouched.push(`renamed "${statusKey}" → "${AUTO_ACCOUNT_STATUS_COLUMN}"`);
        }
      } catch (e) {
        result.warning = `Account Status could not be prepared (${e instanceof Error ? e.message : String(e)}); status left untouched`;
        statusCol = undefined;
      }
    } else if (statusKey && statusCol && opts.dryRun && !statusKey.startsWith(AUTO_MARKER)) {
      result.columnsTouched.push(`would rename "${statusKey}" → "${AUTO_ACCOUNT_STATUS_COLUMN}"`);
    } else if (!statusKey) {
      result.warning = `no "${ACCOUNT_STATUS_COLUMN}" column on this board; status left untouched`;
    }

    // Pinned statuses, loaded once per data source rather than per row.
    const overrideByPage = new Map(
      (await db.select().from(schema.notionStatusOverrides)).map((o) => [o.pageId, o.status]),
    );
    const pages = await notion.queryDataSource(dsId);
    const byClient = new Map<string, BoardRow[]>();
    const orphans: BoardRow[] = [];
    for (const page of pages) {
      const parsed = parseCampaignRow(page);
      if (!parsed) continue; // untitled row: not a campaign
      const ctx = ctxByPage.get(page.id);
      const own = [...new Set([...parsed.activeIds, ...parsed.otherIds])];
      const row: BoardRow = {
        pageId: page.id,
        title: parsed.title,
        status: parsed.status,
        budgetCurrent: numberCell(page, budgetCol.column.id),
        spendCurrent: spendCol ? numberCell(page, spendCol.column.id) : null,
        fundsCurrent: fundsCol ? numberCell(page, fundsCol.column.id) : null,
        remainingCurrent: remainingCol ? numberCell(page, remainingCol.column.id) : null,
        endCurrent: endCol ? dateCell(page, endCol.column.id) : null,
        destCurrent: destCol ? textCell(page, destCol.column.id) : "",
        // The row's own contracted budget and engagement start — never the clubbed client's, so a
        // client with several engagements projects each one from its own numbers.
        notionBudget: parsed.budget,
        startDate: parsed.startDate,
        // A client with a single row owns its manual add/remove overrides unambiguously; with several
        // rows only the removals can be applied, since an addition names no row.
        accountIds:
          ctx && ctx.pageIds.length === 1
            ? ctx.effective
            : own.filter((a) => !ctx?.manualRemove.has(a)),
      };
      if (!ctx) orphans.push(row);
      else {
        const list = byClient.get(ctx.id);
        if (list) list.push(row);
        else byClient.set(ctx.id, [row]);
      }
    }

    interface RowWork {
      row: BoardRow;
      remainingPlan: RowPlan;
      budgetRemaining: number | null;
      dest: TextPlan;
      sum: DailyBudgetSum | null;
      status: MachineStatus | null;
      budget: RowPlan;
      spend: RowPlan;
      funds: RowPlan;
      end: DatePlan;
      assigned: number;
      spentSinceStart: number | null;
      dailyPace: number | null;
      fundsRemaining: number | null;
      daysRemaining: number | null;
    }
    const work: RowWork[] = [];
    const noMapping = "not in the synced client mapping — re-run the Notion sync";
    for (const row of orphans) {
      work.push({
        row,
        // Unmapped rows have no attributed campaigns, so the ladder has nothing to reason from.
        status: null,
        dest: { text: null, skip: noMapping },
        sum: null,
        budget: { dollars: null, skip: noMapping },
        spend: { dollars: null, skip: noMapping },
        funds: { dollars: null, skip: noMapping },
        remainingPlan: { dollars: null, skip: noMapping },
        budgetRemaining: null,
        end: { date: null, clear: false, skip: noMapping },
        assigned: 0,
        spentSinceStart: null,
        dailyPace: null,
        fundsRemaining: null,
        daysRemaining: null,
      });
    }

    for (const rows of byClient.values()) {
      const ctx = ctxByPage.get(rows[0].pageId);
      if (!ctx) continue;
      // An account listed by several rows of one client belongs to whichever of them is CURRENTLY
      // live. Successive engagements of the same brand ("betonline.ag (BOL)" then "betonline.ag
      // (July 2026)") are indistinguishable by name, and today's campaigns are the live row's. Only
      // when several LIVE rows share one account is it a genuine brand split.
      const pagesByAccount = new Map<string, string[]>();
      const isLive = new Map(rows.map((r) => [r.pageId, !notLive(r.status)]));
      for (const r of rows) {
        if (!isLive.get(r.pageId)) continue;
        for (const a of r.accountIds) {
          const list = pagesByAccount.get(a);
          if (list) list.push(r.pageId);
          else pagesByAccount.set(a, [r.pageId]);
        }
      }
      const liveRowCount = rows.reduce((n, r) => (isLive.get(r.pageId) ? n + 1 : n), 0);
      const vocabByPage = new Map<string, BrandVocab>(
        rows.map((r) => [r.pageId, brandVocab(r.pageId, r.title, [r.title])]),
      );
      const assigned = new Map<string, AttributedCampaign[]>();
      const ambiguous = new Set<string>();
      for (const [accountId, claimants] of pagesByAccount) {
        for (const campaign of byAccount.get(accountId) ?? []) {
          if (ctx.owned && !ctx.owned.has(campaign.id)) continue; // belongs to another client
          let target: string | null = claimants[0] ?? null;
          if (claimants.length > 1) {
            target = attributeCampaign(
              campaign.name,
              claimants
                .map((p) => vocabByPage.get(p))
                .filter((v): v is BrandVocab => v !== undefined),
            );
            if (!target) {
              for (const p of claimants) ambiguous.add(p);
              continue;
            }
          }
          if (!target) continue;
          const list = assigned.get(target);
          if (list) list.push(campaign);
          else assigned.set(target, [campaign]);
        }
      }

      for (const row of rows) {
        // Non-live engagements are never written, so nothing needs computing for them.
        if (!isLive.get(row.pageId)) {
          work.push({
            row,
            // A non-live row is excluded from account→row attribution upstream, so it has no
            // campaigns to derive from — and a human-owned or empty status is not the machine's to
            // write anyway.
            status: null,
            dest: { text: null, skip: "not a live engagement" },
            sum: null,
            budget: planRow({ status: row.status, current: row.budgetCurrent, target: null }),
            spend: planSpendRow({ status: row.status, current: row.spendCurrent, spend: null }),
            funds: planFundsRow({ status: row.status, current: row.fundsCurrent, funds: null }),
            remainingPlan: planBudgetRemainingRow({
              status: row.status,
              current: row.remainingCurrent,
              remaining: null,
            }),
            budgetRemaining: null,
            end: { date: null, clear: false, skip: "not a live engagement" },
            assigned: 0,
            spentSinceStart: null,
            dailyPace: null,
            fundsRemaining: null,
            daysRemaining: null,
          });
          continue;
        }
        const mine = assigned.get(row.pageId) ?? [];
        // Derived for every live row, independent of whether any numeric column can be computed: a
        // row whose budget is unresolvable still has a delivery state worth reporting.
        const statusNext = statusForRow({
          accounts: row.accountIds.flatMap((a) => {
            const acct = accountById.get(a);
            return acct
              ? [
                  {
                    disabled: accountStatus(acct.status) === "DISABLED",
                    deliverable: canDeliver(acct),
                  },
                ]
              : [];
          }),
          campaigns: mine.map((c) => ({ id: c.id, active: c.active })),
          adSets: ladderAdSets,
          ads: ladderAds,
          current: row.status,
          override: overrideByPage.get(row.pageId) ?? null,
        });
        // Destinations come from the row's OWN attributed campaigns, so a shared account never leaks
        // another engagement's landing page onto this row. Ranked by the spend behind each page.
        const destSpend = new Map<string, number>();
        for (const c of mine) {
          if (!c.active) continue;
          for (const [u, sp] of destSpendByCampaign.get(c.id) ?? [])
            destSpend.set(u, (destSpend.get(u) ?? 0) + sp);
        }
        // Target daily spend: the row's own contracted budget spread over a month. Independent of what
        // Meta has in force, which is what the spend column is there to compare against.
        const target = targetDailyBudget(row.notionBudget);
        const dest = planDestinations({
          status: row.status,
          current: row.destCurrent,
          // The PAGE, not the tracker string: a creative's URL carries unresolved Meta macros
          // ({{campaign.name}}, {user_id}) substituted at click time, so the raw query is not what
          // anyone lands on. Distinct pages still read as distinct lines.
          urls: groupByLandingPage([...destSpend].sort((a, b) => b[1] - a[1]).map(([u]) => u)).map(
            (g) => g.page,
          ),
        });
        const synced = row.accountIds.filter((a) => currencyOf.has(a));
        let sum: DailyBudgetSum | null = null;
        let spend: number | null = null;
        let skip: string | null = null;
        if (ambiguous.has(row.pageId)) {
          skip = "campaigns on a shared account could not be split by name";
        } else if (row.accountIds.length === 0) {
          skip = "no ad accounts on this row";
        } else if (synced.length === 0) {
          skip = "row's ad accounts are not visible to the Meta token";
        } else {
          const foreign = [
            ...new Set(mine.map((c) => currencyOf.get(c.accountId) ?? COLUMN_CURRENCY)),
          ].filter((cur) => cur !== COLUMN_CURRENCY);
          if (foreign.length > 0)
            skip = `account currency ${foreign.join("/")} cannot be summed into a ${COLUMN_CURRENCY} column`;
          else {
            sum = sumDailyBudget(mine, activeAdSetRows);
            spend = avgDailySpend(mine.reduce((n, c) => n + (spendByCampaign.get(c.id) ?? 0), 0));
          }
        }

        // Projection: money FUNDED into the row's ad accounts — their lifetime spend cap minus their
        // lifetime spend — divided by the daily budget in force. Both sides are Meta ground truth
        // synced hourly: the funds are literally what stops delivery when they reach zero, and the
        // daily budget is what the campaigns are set to draw against them each day.
        //
        // The divisor used to be trailing ACTUAL spend. That made the date jump with day-to-day noise
        // and withheld it entirely from an engagement younger than MIN_PACE_DAYS, or one whose freshly
        // rotated-on account had no spend history of its own. A contracted daily budget needs neither
        // a history nor a start date.
        let dailyPace: number | null = null;
        let fundsRemaining: number | null = null;
        let end: DatePlan;
        const pw = paceWindow({ startDate: row.startDate, until });

        // Spend measured once, for the row's own campaigns, from its own start date. Needed by the
        // contract column whether or not a projection is possible, so it is not computed inside the
        // projection's branches. The pace window stays clamped to the start date, since recycled
        // accounts would otherwise average in the previous client's spend.
        let spentSinceStart: number | null = null;
        if (!skip) {
          const paceAccounts = liveRowCount === 1 ? ctx.effective : row.accountIds;
          const ids = paceAccounts.flatMap((a) =>
            (byAccount.get(a) ?? [])
              .filter((c) => !ctx.owned || ctx.owned.has(c.id))
              .map((c) => c.id),
          );
          const [spentTotal, paceTotal] = await Promise.all([
            row.startDate ? spendOf(ids, row.startDate, until) : Promise.resolve(null),
            pw ? spendOf(ids, pw.from, until) : Promise.resolve(null),
          ]);
          spentSinceStart = spentTotal;
          dailyPace = pw && paceTotal !== null ? paceTotal / pw.days : null;
        }
        const remaining = budgetRemaining(row.notionBudget, spentSinceStart);

        // Money left is what is FUNDED into the ad accounts, not what was contracted. Notion's
        // `Budget ($)` records the contract and is not updated when an account is topped up:
        // betonline.ag showed $1,131 left against its contract while the account it had just been
        // rotated onto held $6,678 of real, spendable funds. It also goes NEGATIVE once a recycled
        // account's history exceeds the contract (wildcasino.ag: $10,350 contracted, $12,596 spent,
        // yet $3,720 still sitting in the accounts). `spend_cap − amount_spent` is ground truth,
        // synced hourly, and it is exactly what stops delivery when it hits zero.
        const funded = row.accountIds.flatMap((a) => {
          const acct = accountById.get(a);
          return acct && canDeliver(acct) ? [acct] : [];
        });
        const uncapped = funded.some((a) => (a.spendCap ?? 0) <= 0);
        if (!uncapped && funded.length > 0) {
          // Each account's balance counts only in proportion to what THIS row draws from it, so an
          // account funding two live engagements is never counted twice.
          let claim = 0;
          for (const a of funded) {
            const balance = (a.spendCap ?? 0) - (a.amountSpent ?? 0);
            if (balance <= 0) continue;
            const pool = poolDaily.get(a.id) ?? 0;
            const own = sumDailyBudget(
              mine.filter((c) => c.accountId === a.id),
              activeAdSetRows,
            ).dollars;
            if (pool <= 0 || own <= 0) continue; // this row draws nothing here
            claim += (balance / 100) * Math.min(1, own / pool);
          }
          fundsRemaining = Math.round(claim * 100) / 100;
        }

        if (skip) {
          end = { date: null, clear: false, skip };
        } else if (uncapped) {
          end = {
            date: null,
            clear: false,
            skip: "an account has no spend cap, so funds are unbounded",
          };
        } else if (funded.length === 0) {
          end = {
            date: null,
            clear: false,
            skip: "no account on this row can spend (disabled or unfunded)",
          };
        } else if (target === null) {
          end = {
            date: null,
            clear: false,
            skip: `no Budget ($) on this row, so there is no target daily spend to divide by`,
          };
        } else {
          // Actual spend is measured above and still feeds the Avg Daily Spend column, letting anyone
          // sanity-check this projection against reality — but it does not set the runway.
          const f = forecastBudgetEnd({
            total: fundsRemaining,
            spent: 0,
            // The same figure the Daily Budget column shows, so anyone can divide the two cells on
            // the row and land on this date.
            dailyPace: target,
            today,
          });
          end = planEndDate({
            status: row.status,
            current: row.endCurrent,
            projected: f.projectedEndDate,
            reason: f.reason,
          });
          work.push({
            row,
            dest,
            sum,
            status: statusNext,
            budget: planRow({ status: row.status, current: row.budgetCurrent, target }),
            spend: planSpendRow({ status: row.status, current: row.spendCurrent, spend }),
            funds: planFundsRow({
              status: row.status,
              current: row.fundsCurrent,
              funds: fundsRemaining,
            }),
            remainingPlan: planBudgetRemainingRow({
              status: row.status,
              current: row.remainingCurrent,
              remaining,
            }),
            budgetRemaining: remaining,
            end,
            assigned: mine.length,
            spentSinceStart,
            dailyPace,
            fundsRemaining,
            daysRemaining: f.daysRemaining,
          });
          continue;
        }
        // Every no-projection path above bypassed planEndDate, so apply its clearing rule here too:
        // a live row must not keep a date the current basis cannot support.
        if (end.date === null && !end.clear && !notLive(row.status) && row.endCurrent !== null)
          end = { ...end, clear: true };
        work.push({
          row,
          dest,
          sum,
          status: statusNext,
          // Not gated on `skip`: the target comes from the row's own contracted budget, so it is
          // writable even when the row's ad accounts are invisible to the token or absent entirely.
          budget: planRow({ status: row.status, current: row.budgetCurrent, target }),
          spend: skip
            ? { dollars: null, skip }
            : planSpendRow({ status: row.status, current: row.spendCurrent, spend }),
          funds: planFundsRow({
            status: row.status,
            current: row.fundsCurrent,
            funds: fundsRemaining,
          }),
          remainingPlan: planBudgetRemainingRow({
            status: row.status,
            current: row.remainingCurrent,
            remaining,
          }),
          budgetRemaining: remaining,
          end,
          assigned: mine.length,
          spentSinceStart,
          dailyPace,
          fundsRemaining,
          daysRemaining: null,
        });
      }
    }

    for (const w of work) {
      const { row, sum, budget, spend, funds, end, dest, status, remainingPlan } = w;
      result.rows += 1;
      const detail: NotionBudgetRow = {
        pageId: row.pageId,
        title: row.title,
        status: row.status,
        accountIds: row.accountIds,
        campaigns: sum?.campaigns ?? 0,
        blocked: sum?.blocked ?? 0,
        budgetCurrent: row.budgetCurrent,
        budgetWritten: null,
        budgetSkip: budget.skip,
        spendCurrent: row.spendCurrent,
        spendWritten: null,
        spendSkip: spend.skip,
        fundsCurrent: row.fundsCurrent,
        fundsWritten: null,
        remainingCurrent: row.remainingCurrent,
        remainingWritten: null,
        remainingSkip: remainingPlan.skip,
        budgetRemaining: w.budgetRemaining,
        fundsSkip: funds.skip,
        fundsRemaining: w.fundsRemaining,
        assignedCampaigns: w.assigned,
        notionBudget: row.notionBudget,
        startDate: row.startDate,
        spentSinceStart: w.spentSinceStart,
        dailyPace: w.dailyPace,
        daysRemaining: w.daysRemaining,
        endCurrent: row.endCurrent,
        endProposed: end.date,
        endWritten: null,
        endCleared: false,
        endSkip: end.skip,
        destCurrent: row.destCurrent,
        destWritten: null,
        destSkip: dest.skip,
        statusWritten: null,
      };
      for (const [plan, column, key] of [
        [budget, budgetCol.column, "budgetWritten"],
        [spend, spendCol?.column, "spendWritten"],
        [funds, fundsCol?.column, "fundsWritten"],
        [remainingPlan, remainingCol?.column, "remainingWritten"],
      ] as const) {
        if (plan.dollars === null || !column) {
          if (plan.skip === "unchanged") result.unchanged += 1;
          else result.skipped += 1;
          continue;
        }
        if (!opts.dryRun) {
          await notion.setPageValue(row.pageId, column.id, { number: plan.dollars });
          await sleep(WRITE_GAP_MS);
        }
        detail[key] = plan.dollars;
        result.updated += 1;
      }
      if (
        budget.dollars === null &&
        !notLive(row.status) &&
        row.budgetCurrent !== null &&
        budget.skip?.startsWith("no Budget ($)")
      ) {
        // The column means "contracted budget / 30". With no contract there is nothing to mean, and a
        // leftover figure from the previous basis would read as a target nobody set.
        if (!opts.dryRun) {
          await notion.setPageValue(row.pageId, budgetCol.column.id, { number: null });
          await sleep(WRITE_GAP_MS);
        }
        detail.budgetSkip = "cleared: no Budget ($) on this row";
        result.updated += 1;
      }
      if (
        remainingPlan.dollars === null &&
        remainingCol &&
        !notLive(row.status) &&
        row.remainingCurrent !== null &&
        remainingPlan.skip === "budget remaining not determinable"
      ) {
        // A live row that can no longer be computed must not keep a figure from when it could: the
        // contract may have been cleared, or the start date removed.
        if (!opts.dryRun) {
          await notion.setPageValue(row.pageId, remainingCol.column.id, { number: null });
          await sleep(WRITE_GAP_MS);
        }
        detail.remainingSkip = "cleared: budget remaining not determinable";
        result.updated += 1;
      }
      if (
        funds.dollars === null &&
        fundsCol &&
        !notLive(row.status) &&
        row.fundsCurrent !== null &&
        funds.skip === "funds not determinable"
      ) {
        if (!opts.dryRun) {
          await notion.setPageValue(row.pageId, fundsCol.column.id, { number: null });
          await sleep(WRITE_GAP_MS);
        }
        detail.fundsSkip = "cleared: funds not attributable to this row";
        result.updated += 1;
      }
      if ((end.date !== null || end.clear) && endCol) {
        if (!opts.dryRun) {
          await notion.setPageValue(row.pageId, endCol.column.id, {
            date: end.date === null ? null : { start: end.date },
          });
          await sleep(WRITE_GAP_MS);
        }
        detail.endWritten = end.date;
        detail.endCleared = end.clear;
        result.updated += 1;
      } else if (end.skip === "unchanged") result.unchanged += 1;
      else result.skipped += 1;
      if (dest.text !== null && destCol) {
        if (!opts.dryRun) {
          await notion.setPageValue(row.pageId, destCol.column.id, {
            rich_text: dest.text ? [{ type: "text", text: { content: dest.text } }] : [],
          });
          await sleep(WRITE_GAP_MS);
        }
        detail.destWritten = dest.text;
        result.updated += 1;
      } else if (dest.skip === "unchanged") result.unchanged += 1;
      else result.skipped += 1;
      // Deliberately outside the `isLive` gate the numeric columns use: ownership was already decided
      // by `statusForRow` from the cell's own value, and a null here means "leave it alone".
      if (status !== null && statusCol) {
        if (!opts.dryRun) {
          await notion.setPageValue(row.pageId, statusCol.id, { status: { name: status } });
          await sleep(WRITE_GAP_MS);
        }
        detail.statusWritten = status;
        result.updated += 1;
      }
      result.details.push(detail);
    }
  }

  return result;
}
