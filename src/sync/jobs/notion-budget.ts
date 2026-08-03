import { setTimeout as sleep } from "node:timers/promises";
import { eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getNotionCredentials } from "@/lib/credentials";
import { NotionClient, type NotionPage, type NotionProp } from "@/notion/client";
import { LIVE_STATUSES, parseCampaignRow, resolvePropertyKey } from "@/notion/parse";
import { attributeCampaign, brandVocab, type BrandVocab } from "@/lib/attribution";
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";
import { effectiveAccountIds } from "./clients";

/**
 * Push the daily budget that is ACTUALLY in force on Meta back onto the Notion campaigns board.
 *
 * Meta exposes no account-level daily budget: it lives on the campaign (CBO) or on each ad set
 * (ABO), never both, so one level per campaign sums exactly. A board row can span several ad
 * accounts and several campaigns; every currently-ACTIVE one it owns is added up, which is what the
 * column is meant to show. Ownership is resolved the same way the dashboard resolves it — the
 * client-level attribution whitelist first (an account reused by a later client), then a name split
 * between sibling rows of one client that share an account — so a shared account is never counted
 * twice into two rows.
 */

/** The board column this job owns. */
export const BUDGET_COLUMN = "Daily Budget ($)";
/** Stamped onto the column name so the team can see at a glance that the values are machine-written. */
export const AUTO_MARKER = "🤖";
export const AUTO_BUDGET_COLUMN = `${AUTO_MARKER} ${BUDGET_COLUMN}`;

/** The column is denominated in dollars; another currency cannot be summed in without an FX rate. */
const COLUMN_CURRENCY = "USD";

/** Notion allows ~3 requests/second. Writes are sequential and paced under that. */
const WRITE_GAP_MS = 350;

export interface ActiveCampaign {
  id: string;
  accountId: string;
  name: string;
  dailyBudget: number | null; // account minor units (cents)
  lifetimeBudget: number | null;
}

export interface ActiveAdSet {
  campaignId: string;
  dailyBudget: number | null; // account minor units (cents)
}

export interface DailyBudgetSum {
  /** Major units (dollars) of every daily budget currently in force. */
  dollars: number;
  /** Campaigns that contributed a daily budget. */
  campaigns: number;
  /** ACTIVE campaigns carrying a LIFETIME budget: running, but with no daily figure to report. */
  lifetimeOnly: number;
}

/**
 * Daily budget in force across `campaigns`, in major units. A campaign holding its own daily budget
 * is CBO (its ad sets carry none); a campaign with no budget of its own is ABO and takes the sum of
 * its ad sets. Meta enforces that split, so nothing is double-counted.
 */
export function sumDailyBudget(campaigns: ActiveCampaign[], adSets: ActiveAdSet[]): DailyBudgetSum {
  let minor = 0;
  let lifetimeOnly = 0;
  const contributing = new Set<string>();
  const abo = new Set<string>();
  for (const c of campaigns) {
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
  return { dollars: Math.round(minor) / 100, campaigns: contributing.size, lifetimeOnly };
}

export interface RowPlan {
  /** Value to write, or null when this row is left alone. */
  dollars: number | null;
  skip: string | null;
}

/**
 * Whether to push a computed budget onto a row.
 *
 * ONLY rows whose engagement is currently live are machine-owned. A finished or paused engagement
 * still lists the ad accounts it used, and those accounts get recycled onto the next client — so
 * "what is running on this row's accounts today" is not that engagement's budget. Writing it would
 * both mislead and overwrite the only record of what was contracted. A live row that stopped
 * delivering is written down to 0, which is true and worth seeing. An unchanged value is never
 * rewritten, so `Last edited time` keeps meaning "a human touched this row".
 */
export function planRow(input: {
  status: string | null;
  current: number | null;
  sum: DailyBudgetSum | null;
}): RowPlan {
  const { status, current, sum } = input;
  if (status === null || !LIVE_STATUSES.includes(status))
    return { dollars: null, skip: "not a live engagement; keeping the recorded value" };
  if (!sum) return { dollars: null, skip: "no synced ad accounts on this row" };
  if (sum.dollars === 0 && sum.lifetimeOnly > 0)
    return {
      dollars: null,
      skip: `${sum.lifetimeOnly} active campaign(s) on a lifetime budget — no daily figure`,
    };
  if (current !== null && Math.abs(current - sum.dollars) < 0.005)
    return { dollars: null, skip: "unchanged" };
  return { dollars: sum.dollars, skip: null };
}

export interface NotionBudgetRow {
  pageId: string;
  title: string;
  status: string | null;
  /** Accounts this row was computed from (after attribution). */
  accountIds: string[];
  campaigns: number;
  current: number | null;
  written: number | null;
  skip: string | null;
}

export interface NotionBudgetResult {
  rows: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** Set when this run stamped the auto-update marker onto the column. */
  renamedTo: string | null;
  /** Non-fatal problem (e.g. the column rename was rejected) worth surfacing in health. */
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
  current: number | null;
  accountIds: string[];
}

/**
 * Recompute the board's daily-budget column from live Meta data and write back only what changed.
 * Returns null when Notion is not configured.
 */
export async function syncNotionDailyBudgets(
  client?: NotionClient,
): Promise<NotionBudgetResult | null> {
  const creds = await getNotionCredentials();
  if (!creds) return null;
  const notion = client ?? new NotionClient(creds.token);

  const [campaignRows, adSetRows, accountRows, clientRows] = await Promise.all([
    db
      .select({
        id: schema.campaigns.id,
        accountId: schema.campaigns.accountId,
        name: schema.campaigns.name,
        dailyBudget: schema.campaigns.dailyBudget,
        lifetimeBudget: schema.campaigns.lifetimeBudget,
      })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.effectiveStatus, "ACTIVE")),
    db
      .select({ campaignId: schema.adSets.campaignId, dailyBudget: schema.adSets.dailyBudget })
      .from(schema.adSets)
      .where(eq(schema.adSets.effectiveStatus, "ACTIVE")),
    db.select({ id: schema.accounts.id, currency: schema.accounts.currency }).from(schema.accounts),
    db.select().from(schema.clients).where(isNull(schema.clients.removedAt)),
  ]);

  const currencyOf = new Map(accountRows.map((a) => [a.id, a.currency]));
  const activeByAccount = new Map<string, ActiveCampaign[]>();
  for (const c of campaignRows) {
    const list = activeByAccount.get(c.accountId);
    if (list) list.push(c);
    else activeByAccount.set(c.accountId, [c]);
  }

  // pageId -> owning client. The cross-client whitelist is resolved lazily: it costs several queries
  // per client and only matters for clients that actually have something running.
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
    if (effective.some((a) => activeByAccount.has(a))) {
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
    renamedTo: null,
    warning: null,
    details: [],
  };

  for (const dsId of await notion.getDataSourceIds(creds.dbId)) {
    const props = await notion.getProperties(dsId);
    const columnName = resolvePropertyKey(Object.keys(props), BUDGET_COLUMN);
    if (!columnName) continue; // this data source has no budget column
    const column = props[columnName];
    if (column.type !== "number") {
      result.warning = `"${columnName}" is a ${column.type} column, not a number — skipped`;
      continue;
    }
    // Stamp the auto-updated marker once. Values matter more than the label, so a rejected rename
    // warns instead of aborting the push.
    if (!columnName.startsWith(AUTO_MARKER)) {
      try {
        await notion.renameProperty(dsId, columnName, AUTO_BUDGET_COLUMN);
        result.renamedTo = AUTO_BUDGET_COLUMN;
      } catch (e) {
        result.warning = `could not rename "${columnName}": ${e instanceof Error ? e.message : String(e)}`;
      }
    }

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
        current: numberCell(page, column.id),
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

    const writes: { row: BoardRow; sum: DailyBudgetSum | null; plan: RowPlan }[] = [];
    for (const row of orphans) {
      writes.push({
        row,
        sum: null,
        plan: { dollars: null, skip: "not in the synced client mapping — re-run the Notion sync" },
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
      const isLive = new Map(
        rows.map((r) => [r.pageId, r.status !== null && LIVE_STATUSES.includes(r.status)]),
      );
      for (const r of rows) {
        if (!isLive.get(r.pageId)) continue;
        for (const a of r.accountIds) {
          const list = pagesByAccount.get(a);
          if (list) list.push(r.pageId);
          else pagesByAccount.set(a, [r.pageId]);
        }
      }
      const vocabByPage = new Map<string, BrandVocab>(
        rows.map((r) => [r.pageId, brandVocab(r.pageId, r.title, [r.title])]),
      );
      const assigned = new Map<string, ActiveCampaign[]>();
      const ambiguous = new Set<string>();
      for (const [accountId, claimants] of pagesByAccount) {
        for (const campaign of activeByAccount.get(accountId) ?? []) {
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
          const plan = planRow({ status: row.status, current: row.current, sum: null });
          writes.push({ row, sum: null, plan });
          continue;
        }
        const mine = assigned.get(row.pageId) ?? [];
        const synced = row.accountIds.filter((a) => currencyOf.has(a));
        let sum: DailyBudgetSum | null = null;
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
          else sum = sumDailyBudget(mine, adSetRows);
        }
        const plan = skip
          ? { dollars: null, skip }
          : planRow({ status: row.status, current: row.current, sum });
        writes.push({ row, sum, plan });
      }
    }

    for (const { row, sum, plan } of writes) {
      result.rows += 1;
      const detail: NotionBudgetRow = {
        pageId: row.pageId,
        title: row.title,
        status: row.status,
        accountIds: row.accountIds,
        campaigns: sum?.campaigns ?? 0,
        current: row.current,
        written: null,
        skip: plan.skip,
      };
      if (plan.dollars === null) {
        if (plan.skip === "unchanged") result.unchanged += 1;
        else result.skipped += 1;
      } else {
        await notion.setPageNumber(row.pageId, column.id, plan.dollars);
        detail.written = plan.dollars;
        result.updated += 1;
        await sleep(WRITE_GAP_MS);
      }
      result.details.push(detail);
    }
  }

  return result;
}
