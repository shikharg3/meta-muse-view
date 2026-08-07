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
import { LIVE_STATUSES, parseCampaignRow, resolvePropertyKey } from "@/notion/parse";
import { attributeCampaign, brandVocab, type BrandVocab } from "@/lib/attribution";
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";
import { accountStatus } from "@/server/agg";
import { addDays } from "@/lib/range";
import { effectiveAccountIds } from "./clients";
import { forecastBudgetEnd, paceWindow, MIN_PACE_DAYS, PACE_DAYS } from "@/lib/budget-forecast";

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

/** Board columns this job owns. `End Date (Estimated)` is deliberately NOT one of them. */
export const BUDGET_COLUMN = "Daily Budget ($)";
export const SPEND_COLUMN = "Avg Daily Spend 7d ($)";
export const PROJECTED_END_COLUMN = "Projected End Date";
/** Stamped onto every column name so the team can see the values are machine-written. */
export const AUTO_MARKER = "🤖";
export const AUTO_BUDGET_COLUMN = `${AUTO_MARKER} ${BUDGET_COLUMN}`;
export const AUTO_SPEND_COLUMN = `${AUTO_MARKER} ${SPEND_COLUMN}`;
export const AUTO_PROJECTED_END_COLUMN = `${AUTO_MARKER} ${PROJECTED_END_COLUMN}`;

/** Complete days averaged for the spend column. Today is excluded — it is partial until it syncs. */
export const SPEND_WINDOW_DAYS = 7;

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
 * Whether to push a computed budget onto a row.
 *
 * A finished or paused engagement still lists the ad accounts it used, and those accounts get
 * recycled onto the next client — so what runs on them today is not that engagement's budget, and
 * writing it would overwrite the only record of what was contracted. A live row that stopped
 * delivering is written down to 0, which is true and worth seeing.
 */
export function planRow(input: {
  status: string | null;
  current: number | null;
  sum: DailyBudgetSum | null;
}): RowPlan {
  const { status, current, sum } = input;
  if (notLive(status))
    return { dollars: null, skip: "not a live engagement; keeping the recorded value" };
  if (!sum) return { dollars: null, skip: "no synced ad accounts on this row" };
  if (sum.dollars === 0 && sum.lifetimeOnly > 0)
    return {
      dollars: null,
      skip: `${sum.lifetimeOnly} active campaign(s) on a lifetime budget — no daily figure`,
    };
  if (same(current, sum.dollars)) return { dollars: null, skip: "unchanged" };
  return { dollars: sum.dollars, skip: null };
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
  if (notLive(status)) return { date: null, skip: "not a live engagement" };
  if (projected === null) return { date: null, skip: reason ?? "not forecastable" };
  if (current === projected) return { date: null, skip: "unchanged" };
  return { date: projected, skip: null };
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
  endCurrent: string | null;
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
  kind: "number" | "date",
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
      kind === "number" ? { number: { format: "dollar" } } : { date: {} },
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

  const [campaignRows, adSetRows, accountRows, clientRows, spendRows] = await Promise.all([
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
    db
      .select({ campaignId: schema.adSets.campaignId, dailyBudget: schema.adSets.dailyBudget })
      .from(schema.adSets)
      .where(eq(schema.adSets.effectiveStatus, "ACTIVE")),
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
  ]);

  const currencyOf = new Map(accountRows.map((a) => [a.id, a.currency]));
  const deliverable = new Set(accountRows.filter((a) => canDeliver(a)).map((a) => a.id));
  const spendByCampaign = new Map(spendRows.map((r) => [r.entityId, Number(r.spend ?? 0)]));

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
        endCurrent: endCol ? dateCell(page, endCol.column.id) : null,
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
      sum: DailyBudgetSum | null;
      budget: RowPlan;
      spend: RowPlan;
      end: DatePlan;
      assigned: number;
      spentSinceStart: number | null;
      dailyPace: number | null;
      daysRemaining: number | null;
    }
    const work: RowWork[] = [];
    const noMapping = "not in the synced client mapping — re-run the Notion sync";
    for (const row of orphans) {
      work.push({
        row,
        sum: null,
        budget: { dollars: null, skip: noMapping },
        spend: { dollars: null, skip: noMapping },
        end: { date: null, skip: noMapping },
        assigned: 0,
        spentSinceStart: null,
        dailyPace: null,
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
            sum: null,
            budget: planRow({ status: row.status, current: row.budgetCurrent, sum: null }),
            spend: planSpendRow({ status: row.status, current: row.spendCurrent, spend: null }),
            end: { date: null, skip: "not a live engagement" },
            assigned: 0,
            spentSinceStart: null,
            dailyPace: null,
            daysRemaining: null,
          });
          continue;
        }
        const mine = assigned.get(row.pageId) ?? [];
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
            sum = sumDailyBudget(mine, adSetRows);
            spend = avgDailySpend(mine.reduce((n, c) => n + (spendByCampaign.get(c.id) ?? 0), 0));
          }
        }

        // Projection: the row's contracted budget, minus what these campaigns spent SINCE the
        // engagement started, divided by their own recent pace. Lifetime spend would be wrong — these
        // ad accounts carry earlier engagements too — and so would an unclamped pace window.
        let spentSinceStart: number | null = null;
        let dailyPace: number | null = null;
        let end: DatePlan;
        const pw = paceWindow({ startDate: row.startDate, until });
        if (skip) {
          end = { date: null, skip };
        } else if (row.notionBudget == null) {
          end = { date: null, skip: "no Budget ($) on this row" };
        } else if (!row.startDate) {
          end = { date: null, skip: "no start date on this row" };
        } else if (!pw) {
          end = { date: null, skip: `engagement younger than ${MIN_PACE_DAYS} complete days` };
        } else {
          // Account rotation is the trap here: an engagement's money was spent on whichever accounts
          // it used over time, but the board row only lists the CURRENT ones. betonline.ag was moved
          // onto a fresh empty account mid-engagement, which would make spent-to-date read $0 against
          // a $10,800 budget instead of the true $1,131 remaining. So when the client has exactly one
          // live row, spend is summed over the client's whole effective account set (still filtered by
          // the cross-client whitelist). With several live rows the row's own accounts are the only
          // safe scope, since history cannot be apportioned between sibling brands.
          const spendAccounts = liveRowCount === 1 ? ctx.effective : row.accountIds;
          const ids = spendAccounts.flatMap((a) =>
            (byAccount.get(a) ?? [])
              .filter((c) => !ctx.owned || ctx.owned.has(c.id))
              .map((c) => c.id),
          );
          const [spentTotal, paceTotal] = await Promise.all([
            spendOf(ids, row.startDate, until),
            spendOf(ids, pw.from, until),
          ]);
          spentSinceStart = spentTotal;
          dailyPace = paceTotal / pw.days;
          const f = forecastBudgetEnd({
            total: row.notionBudget,
            spent: spentSinceStart,
            dailyPace,
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
            sum,
            budget: planRow({ status: row.status, current: row.budgetCurrent, sum }),
            spend: planSpendRow({ status: row.status, current: row.spendCurrent, spend }),
            end,
            assigned: mine.length,
            spentSinceStart,
            dailyPace,
            daysRemaining: f.daysRemaining,
          });
          continue;
        }
        work.push({
          row,
          sum,
          budget: skip
            ? { dollars: null, skip }
            : planRow({ status: row.status, current: row.budgetCurrent, sum }),
          spend: skip
            ? { dollars: null, skip }
            : planSpendRow({ status: row.status, current: row.spendCurrent, spend }),
          end,
          assigned: mine.length,
          spentSinceStart,
          dailyPace,
          daysRemaining: null,
        });
      }
    }

    for (const w of work) {
      const { row, sum, budget, spend, end } = w;
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
        assignedCampaigns: w.assigned,
        notionBudget: row.notionBudget,
        startDate: row.startDate,
        spentSinceStart: w.spentSinceStart,
        dailyPace: w.dailyPace,
        daysRemaining: w.daysRemaining,
        endCurrent: row.endCurrent,
        endProposed: end.date,
        endWritten: null,
        endSkip: end.skip,
      };
      for (const [plan, column, key] of [
        [budget, budgetCol.column, "budgetWritten"],
        [spend, spendCol?.column, "spendWritten"],
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
      if (end.date !== null && endCol) {
        if (!opts.dryRun) {
          await notion.setPageValue(row.pageId, endCol.column.id, { date: { start: end.date } });
          await sleep(WRITE_GAP_MS);
        }
        detail.endWritten = end.date;
        result.updated += 1;
      } else if (end.skip === "unchanged") result.unchanged += 1;
      else result.skipped += 1;
      result.details.push(detail);
    }
  }

  return result;
}
