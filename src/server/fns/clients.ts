import { and, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import {
  deriveKpis,
  windowStart,
  canonicalEvents,
  accountStatus,
  type ClientEvent,
} from "@/server/agg";
import { addDays, type DateWindow } from "@/lib/range";
import { fetchCampaigns, objectiveResults, disabledSinceMap } from "./dashboard";
import { effectiveAccountIds, getClientRow } from "@/sync/jobs/clients";
import type { Campaign, Kpis, AccountStatus } from "@/lib/types";
import { disableReasonLabel } from "@/lib/format";
import { brandTitles, boardRowsWithoutOwners } from "@/notion/parse";
import { currentUser, audit } from "@/server/fns/auth";
import { isAdmin } from "@/lib/auth/users";
import {
  clientCampaignScope,
  ownedCampaignIds,
  loadCampaignOwnership,
  type CampaignRef,
} from "./campaign-attribution";
import { forecastBudgetEnd, PACE_DAYS } from "@/lib/budget-forecast";

const num = (v: unknown): number => Number(v ?? 0);
/** Server-side calendar day (UTC), the reference point for budget pacing. */
const todayYmd = (): string => new Date().toISOString().slice(0, 10);

export interface ClientSummary {
  id: string;
  name: string;
  status: string | null;
  accountCount: number;
  syncedAt: string | null;
  removedAt: string | null; // set when the client is no longer on the Notion board (data retained)
  /** Notion campaign-row (brand) titles grouped under this client, excluding the client's own name.
   * Populated for agency clients that group several brands under one Client-Account entity. */
  brands: string[];
}

export interface ClientAccountRow {
  id: string;
  name: string | null; // null = not in the current BM sync (old/external account)
  source: "notion" | "manual";
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  hasData: boolean;
  status: AccountStatus | null; // Meta account_status; null = account not in the current BM sync
  disableReason: string | null; // human-readable Meta disable_reason; null when active/unknown
  amountSpent: number | null; // lifetime spend (account currency, minor units)
}

/**
 * Spend on a shared account that no rule could attribute, kept out of every client's totals.
 *
 * Excluding it is right — counting it for all claimants was the bug — but it must stay visible, or a
 * campaign silently belongs to nobody. Carries the enriched rows plus the candidate owners so it can
 * be listed and assigned in place.
 */
export interface UnattributedCampaigns {
  campaigns: Campaign[];
  /** Total unassigned spend over the window. */
  spend: number;
  /** accountId -> the clients claiming that account, i.e. the candidate owners. */
  candidates: Record<string, { id: string; name: string }[]>;
}

export interface ClientDetail {
  id: string;
  name: string;
  status: string | null;
  kpis: Kpis;
  accounts: ClientAccountRow[];
  campaigns: Campaign[];
  /** All de-duplicated conversion/engagement events for this client over the window. */
  events: ClientEvent[];
  /** Campaigns on this client's SHARED ad accounts that no rule could assign, so they are counted for
   *  nobody. Never silently drop spend: surface it so an operator can settle the owner. */
  unattributed: UnattributedCampaigns;
  /** The Notion board rows behind this client, for admin status overrides. */
  notionRows: { pageId: string; title: string; status: string | null }[];
  /** Engagement budget from Notion + spend against it (null total = not tracked), with a
   *  pace-based forecast of when the budget runs out. */
  budget: {
    total: number | null;
    spent: number;
    remaining: number | null;
    startDate: string | null;
    /** Notion's estimated end date — what was *planned*, kept for context only. */
    plannedEndDate: string | null;
    /** Forecast burn-out date (YYYY-MM-DD) from the recent pace; null when not forecastable. */
    projectedEndDate: string | null;
    /** $/day the forecast used: spend over the last 14 complete days ÷ 14. */
    dailyPace: number;
    daysRemaining: number | null;
    /** Short reason there is no projectedEndDate (shown instead of a blank dash). */
    forecastReason: string | null;
  };
}

export async function fetchClients(): Promise<ClientSummary[]> {
  const rows = await db.select().from(schema.clients);
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      accountCount: effectiveAccountIds(r).length,
      syncedAt: r.syncedAt?.toISOString() ?? null,
      removedAt: r.removedAt?.toISOString() ?? null,
      brands: brandTitles(r.raw).filter((t) => t.toLowerCase() !== r.name.toLowerCase()),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ClientRanked extends ClientSummary {
  spend: number;
  impressions: number;
  results: number;
  resultLabel: string;
}

/**
 * All clients with spend + objective-aware results over the window, sorted by
 * spend. Computed in a constant number of queries (NOT per-client) so ranking
 * questions ("which client spent the most") never fan out into many calls.
 */
export async function fetchClientsRanked(w: DateWindow): Promise<ClientRanked[]> {
  const rows = await db.select().from(schema.clients);
  if (rows.length === 0) return [];
  const [acct, results] = await Promise.all([
    db
      .select({
        entityId: schema.insightsDaily.entityId,
        spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
        impressions: sql<number>`coalesce(sum(${schema.insightsDaily.impressions}),0)`,
      })
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, "account"),
          gte(schema.insightsDaily.date, w.since),
          lte(schema.insightsDaily.date, w.until),
        ),
      )
      .groupBy(schema.insightsDaily.entityId),
    objectiveResults(w).then((r) => r.account),
  ]);
  const spendBy = new Map(acct.map((a) => [a.entityId, a]));
  return rows
    .map((r) => {
      const ids = effectiveAccountIds(r);
      let spend = 0;
      let impressions = 0;
      let resultVal = 0;
      const labelSpend = new Map<string, number>();
      for (const id of ids) {
        const t = spendBy.get(id);
        const s = num(t?.spend);
        spend += s;
        impressions += num(t?.impressions);
        const rr = results.get(id);
        if (rr) {
          resultVal += rr.value;
          labelSpend.set(rr.label, (labelSpend.get(rr.label) ?? 0) + s);
        }
      }
      let resultLabel = "Results";
      let best = -1;
      for (const [l, sp] of labelSpend)
        if (sp > best) {
          best = sp;
          resultLabel = l;
        }
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        accountCount: ids.length,
        syncedAt: r.syncedAt?.toISOString() ?? null,
        removedAt: r.removedAt?.toISOString() ?? null,
        brands: brandTitles(r.raw).filter((t) => t.toLowerCase() !== r.name.toLowerCase()),
        spend,
        impressions,
        results: resultVal,
        resultLabel,
      };
    })
    .sort((a, b) => b.spend - a.spend);
}

export async function fetchClientDetail(
  id: string,
  w: DateWindow,
  opts: { accountIds?: string[] } = {},
): Promise<ClientDetail | null> {
  const row = await getClientRow(id);
  if (!row) return null;
  // Optional scope (e.g. one Notion campaign row's accounts) — always ∩ the client's effective set.
  const effective = effectiveAccountIds(row);
  const scope = opts.accountIds;
  const accountIds = scope?.length ? effective.filter((a) => scope.includes(a)) : effective;
  const notionIds = (row.notionAccountIds as string[] | null) ?? [];

  // Ownership is per campaign, not per account: shared accounts are split by brand name / manual
  // override, and an override can also pull a campaign in from an account this client doesn't own.
  const attribution = await clientCampaignScope(id, accountIds);
  const allAccountIds = [...new Set([...accountIds, ...attribution.extraAccountIds])];

  if (allAccountIds.length === 0) {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      kpis: deriveKpis({
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        revenue: 0,
        reach: 0,
      }),
      accounts: [],
      campaigns: [],
      events: [],
      unattributed: { campaigns: [], spend: 0, candidates: {} },
      notionRows: boardRowsWithoutOwners(row.raw),
      budget: budgetOf(row, 0, 0, todayYmd()),
    };
  }

  // Accounts needing campaign-level totals (account-level rows can't be split).
  const splitSet = new Set(attribution.splitAccountIds);
  const accountLevelIds = allAccountIds.filter((a) => !splitSet.has(a));
  const noRows = Promise.resolve([] as (typeof schema.insightsDaily.$inferSelect)[]);

  const [accountRows, accountTotals, campaignTotals] = await Promise.all([
    db.select().from(schema.accounts).where(inArray(schema.accounts.id, allAccountIds)),
    accountLevelIds.length
      ? db
          .select()
          .from(schema.insightsDaily)
          .where(
            and(
              eq(schema.insightsDaily.level, "account"),
              inArray(schema.insightsDaily.entityId, accountLevelIds),
              gte(schema.insightsDaily.date, w.since),
              lte(schema.insightsDaily.date, w.until),
            ),
          )
      : noRows,
    attribution.splitAccountIds.length
      ? db
          .select()
          .from(schema.insightsDaily)
          .where(
            and(
              eq(schema.insightsDaily.level, "campaign"),
              inArray(schema.insightsDaily.accountId, attribution.splitAccountIds),
              notInArray(schema.insightsDaily.entityId, attribution.excludedCampaignIds),
              gte(schema.insightsDaily.date, w.since),
              lte(schema.insightsDaily.date, w.until),
            ),
          )
      : noRows,
  ]);

  const accName = new Map(accountRows.map((a) => [a.id, a.name]));
  const accStatus = new Map(accountRows.map((a) => [a.id, accountStatus(a.status)]));
  const accInfo = new Map(accountRows.map((a) => [a.id, a]));

  // Per-account sums + overall KPI totals. Account-level rows key on entityId (the account itself);
  // campaign-level rows key on their parent accountId.
  const perAccount = new Map<string, { spend: number; impressions: number; clicks: number }>();
  const totals = { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, reach: 0 };
  const addRow = (key: string, r: typeof schema.insightsDaily.$inferSelect) => {
    const acc = perAccount.get(key) ?? { spend: 0, impressions: 0, clicks: 0 };
    acc.spend += num(r.spend);
    acc.impressions += num(r.impressions);
    acc.clicks += num(r.clicks);
    perAccount.set(key, acc);
    totals.spend += num(r.spend);
    totals.impressions += num(r.impressions);
    totals.clicks += num(r.clicks);
    totals.conversions += num(r.conversions);
    totals.revenue += num(r.conversionValues);
    totals.reach += num(r.reach);
  };
  for (const r of accountTotals) addRow(r.entityId, r);
  for (const r of campaignTotals) addRow(r.accountId, r);
  const insightRows = [...accountTotals, ...campaignTotals];

  const accounts: ClientAccountRow[] = allAccountIds.map((aid) => {
    const t = perAccount.get(aid);
    const k = deriveKpis({
      spend: t?.spend ?? 0,
      impressions: t?.impressions ?? 0,
      clicks: t?.clicks ?? 0,
      conversions: 0,
      revenue: 0,
      reach: 0,
    });
    return {
      id: aid,
      name: accName.get(aid) ?? null,
      source: notionIds.includes(aid) ? "notion" : "manual",
      spend: k.spend,
      impressions: k.impressions,
      clicks: k.clicks,
      ctr: k.ctr,
      cpc: k.cpc,
      hasData: Boolean(t),
      status: accStatus.get(aid) ?? null,
      disableReason: disableReasonLabel(accInfo.get(aid)?.disableReason ?? null),
      amountSpent: accInfo.get(aid)?.amountSpent ?? null,
    };
  });

  // Nested campaign→ad set→ad tree scoped to this client's accounts (drill-down), minus campaigns
  // on contested accounts that belong to the other client.
  const excluded = new Set(attribution.excludedCampaignIds);
  const unowned = new Set(attribution.unattributedCampaignIds);
  const enriched = (await fetchCampaigns(w, allAccountIds)).sort((a, b) => b.spend - a.spend);
  const campaigns = enriched.filter((c) => !excluded.has(c.id));
  // Same enriched rows, so the unassigned ones can be listed and assigned without a second query.
  const unattributed: UnattributedCampaigns = {
    campaigns: enriched.filter((c) => unowned.has(c.id)),
    spend: 0,
    candidates: attribution.claimantsByAccount,
  };
  unattributed.spend =
    Math.round(unattributed.campaigns.reduce((n, c) => n + c.spend, 0) * 100) / 100;
  // Spend against the current engagement budget = spend since its start date, plus the recent burn
  // rate the end-date forecast is built from. Both use the same attribution-aware split: account-
  // level rows for accounts we own outright, campaign-level rows for contested ones.
  const spendBetween = async (since: string, until?: string): Promise<number> => {
    const inRange = until
      ? and(gte(schema.insightsDaily.date, since), lte(schema.insightsDaily.date, until))
      : gte(schema.insightsDaily.date, since);
    const [acctSpend, campSpend] = await Promise.all([
      accountLevelIds.length
        ? db
            .select({ s: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)` })
            .from(schema.insightsDaily)
            .where(
              and(
                eq(schema.insightsDaily.level, "account"),
                inArray(schema.insightsDaily.entityId, accountLevelIds),
                inRange,
              ),
            )
        : Promise.resolve([{ s: 0 }]),
      attribution.splitAccountIds.length
        ? db
            .select({ s: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)` })
            .from(schema.insightsDaily)
            .where(
              and(
                eq(schema.insightsDaily.level, "campaign"),
                inArray(schema.insightsDaily.accountId, attribution.splitAccountIds),
                notInArray(schema.insightsDaily.entityId, attribution.excludedCampaignIds),
                inRange,
              ),
            )
        : Promise.resolve([{ s: 0 }]),
    ]);
    return num(acctSpend[0]?.s) + num(campSpend[0]?.s);
  };

  const today = todayYmd();
  const [budgetSpent, paceSpend] = await Promise.all([
    row.startDate ? spendBetween(String(row.startDate)) : Promise.resolve(0),
    // Last PACE_DAYS *complete* days — today is partial, so it would drag the average down.
    spendBetween(addDays(today, -PACE_DAYS), addDays(today, -1)),
  ]);

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    kpis: deriveKpis(totals),
    accounts,
    campaigns,
    events: canonicalEvents(insightRows),
    unattributed,
    notionRows: boardRowsWithoutOwners(row.raw),
    // Divide by the whole window, not by the days that happened to have rows: a day with no
    // insights row is a real zero-spend day and must pull the pace down.
    budget: budgetOf(row, budgetSpent, paceSpend / PACE_DAYS, today),
  };
}

function budgetOf(
  row: typeof schema.clients.$inferSelect,
  spent: number,
  dailyPace: number,
  today: string,
): ClientDetail["budget"] {
  const total = row.budget ?? null;
  const f = forecastBudgetEnd({ total, spent, dailyPace, today });
  return {
    total,
    spent,
    remaining: total != null ? total - spent : null,
    startDate: row.startDate ? String(row.startDate) : null,
    plannedEndDate: row.endDate ? String(row.endDate) : null,
    projectedEndDate: f.projectedEndDate,
    dailyPace: f.dailyPace,
    daysRemaining: f.daysRemaining,
    forecastReason: f.reason,
  };
}

const ACT_RE = /^act_\d{6,}$/;

/** Normalize loose user input ("123456789", "act_123456789") to act_<digits>. */
export function normalizeAccountId(input: string): string | null {
  const m = input.trim().match(/\d{6,}/);
  if (!m) return null;
  const id = `act_${m[0]}`;
  return ACT_RE.test(id) ? id : null;
}

export async function updateClientAccounts(
  clientId: string,
  action: "add" | "remove",
  accountId: string,
): Promise<{ ok: boolean; error?: string }> {
  const me = await currentUser();
  if (!me || !isAdmin(me.role)) return { ok: false, error: "Admins only." };
  const id = normalizeAccountId(accountId);
  if (!id) return { ok: false, error: "Invalid account id" };
  const row = await getClientRow(clientId);
  if (!row) return { ok: false, error: "Unknown client" };

  const notion = new Set((row.notionAccountIds as string[] | null) ?? []);
  const add = new Set((row.manualAddIds as string[] | null) ?? []);
  const remove = new Set((row.manualRemoveIds as string[] | null) ?? []);

  if (action === "add") {
    // Re-adding a notion-sourced account just clears its removal override.
    remove.delete(id);
    if (!notion.has(id)) add.add(id);
  } else {
    if (add.has(id)) add.delete(id);
    else remove.add(id);
  }

  await db
    .update(schema.clients)
    .set({ manualAddIds: [...add], manualRemoveIds: [...remove] })
    .where(eq(schema.clients.id, clientId));
  await audit(
    `client.account.${action}`,
    `${action} ${id} ${action === "add" ? "to" : "from"} ${row.name}`,
  );
  return { ok: true };
}

export interface CampaignBudget {
  id: string;
  name: string | null;
  status: string | null;
  spent: number; // lifetime spend, $
  dailyBudget: number | null; // $/day, null if not set on the campaign
  recentDaily: number; // avg $/day over the last 7 days
}

/**
 * Per-campaign budget + pacing for a client's accounts (the recurring "basic
 * questions"). Meta-derivable fields only — campaigns here use daily budgets with
 * no lifetime cap or stop date, so "remaining"/"end date" aren't computable from Meta.
 */
export async function fetchClientBudgets(clientId: string): Promise<CampaignBudget[]> {
  const row = await getClientRow(clientId);
  const ids = row ? effectiveAccountIds(row) : [];
  if (ids.length === 0) return [];
  // Attribution-filtered like every other client-scoped figure: a shared account's other client must
  // not appear in this client's pacing table (and an unassigned campaign belongs in neither).
  const owned = await ownedCampaignIds(clientId, ids);
  if (owned?.length === 0) return [];
  const camps = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      status: schema.campaigns.status,
      dailyBudget: schema.campaigns.dailyBudget,
    })
    .from(schema.campaigns)
    .where(owned ? inArray(schema.campaigns.id, owned) : inArray(schema.campaigns.accountId, ids));
  if (camps.length === 0) return [];
  const since = windowStart(7);
  const spend = await db
    .select({
      entityId: schema.insightsDaily.entityId,
      total: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
      recent: sql<number>`coalesce(sum(${schema.insightsDaily.spend}) filter (where ${schema.insightsDaily.date} >= ${since}),0)`,
    })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.level, "campaign"),
        inArray(
          schema.insightsDaily.entityId,
          camps.map((c) => c.id),
        ),
      ),
    )
    .groupBy(schema.insightsDaily.entityId);
  const byId = new Map(spend.map((s) => [s.entityId, s]));
  return camps
    .map((c) => {
      const s = byId.get(c.id);
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        spent: num(s?.total),
        dailyBudget: c.dailyBudget != null ? Number(c.dailyBudget) / 100 : null,
        recentDaily: num(s?.recent) / 7,
      };
    })
    .sort((a, b) => b.spent - a.spent);
}

/** Clients with their effective account ids — for the global header filter. */
export async function fetchClientFilterOptions(): Promise<
  { id: string; name: string; accountIds: string[] }[]
> {
  const rows = await db.select().from(schema.clients);
  return rows
    .filter((r) => r.removedAt == null)
    .map((r) => ({ id: r.id, name: r.name, accountIds: effectiveAccountIds(r) }))
    .filter((c) => c.accountIds.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A client's campaigns across its effective accounts — for the report campaign filter.
 *
 * Attribution-filtered: on an account shared with another client the picker must not offer (and
 * pre-select) the other client's campaigns, or the report builder shows names whose spend the report
 * itself correctly refuses to count.
 */
export async function fetchClientCampaigns(
  clientId: string,
): Promise<{ id: string; name: string }[]> {
  const row = await getClientRow(clientId);
  if (!row) return [];
  const accounts = effectiveAccountIds(row);
  if (accounts.length === 0) return [];
  const owned = await ownedCampaignIds(clientId, accounts);
  const rows = await db
    .select({ id: schema.campaigns.id, name: schema.campaigns.name })
    .from(schema.campaigns)
    .where(
      owned
        ? inArray(schema.campaigns.id, owned.length ? owned : [""])
        : inArray(schema.campaigns.accountId, accounts),
    )
    .orderBy(schema.campaigns.name);
  return rows;
}

export interface ActiveCampaign {
  name: string;
  account: string;
  /** Meta account status — DISABLED = suspended/disabled by Meta (with reason). */
  accountStatus: AccountStatus;
  accountDisableReason: string | null;
  client: string | null;
  /** Campaign status (ACTIVE / PAUSED / …). */
  status: string | null;
  spend: number;
  /** Window spend / number of days in the window. */
  dailyAvgSpend: number;
  /** Daily target budget ($): the campaign CBO daily budget, else summed active ad-set budgets (ABO); null if neither is set. */
  dailyBudget: number | null;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  results: number;
  resultLabel: string;
  /** De-duplicated conversions (purchases, registrations, leads, …) for the campaign over the window. */
  events: ClientEvent[];
}

/**
 * Every campaign that spent > $0 over the window, enriched for the recurring "give me a full
 * breakdown of the active campaigns" ask: owning account (+ its Meta status), current client, daily
 * average + daily target (budget) spend, core KPIs, and the full conversion breakdown — all in ONE
 * call so the assistant never loops get_client_stats per client. Client resolves through
 * non-archived rows only so stale board entities don't surface.
 */
export async function fetchActiveCampaigns(w: DateWindow): Promise<ActiveCampaign[]> {
  const active = (await fetchCampaigns(w))
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend);
  if (active.length === 0) return [];
  const ids = active.map((c) => c.id);
  const acctIds = [...new Set(active.map((c) => c.accountId))];
  const [clientRows, acctRows, insightRows, campBudgets, adsetBudgets] = await Promise.all([
    db.select().from(schema.clients),
    db
      .select({
        id: schema.accounts.id,
        status: schema.accounts.status,
        disableReason: schema.accounts.disableReason,
      })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, acctIds)),
    db
      .select({
        entityId: schema.insightsDaily.entityId,
        clicks: schema.insightsDaily.clicks,
        actions: schema.insightsDaily.actions,
        actionValues: schema.insightsDaily.actionValues,
      })
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, "campaign"),
          inArray(schema.insightsDaily.entityId, ids),
          gte(schema.insightsDaily.date, w.since),
          lte(schema.insightsDaily.date, w.until),
        ),
      ),
    db
      .select({ id: schema.campaigns.id, dailyBudget: schema.campaigns.dailyBudget })
      .from(schema.campaigns)
      .where(inArray(schema.campaigns.id, ids)),
    db
      .select({
        campaignId: schema.adSets.campaignId,
        dailyBudget: schema.adSets.dailyBudget,
        effectiveStatus: schema.adSets.effectiveStatus,
      })
      .from(schema.adSets)
      .where(inArray(schema.adSets.campaignId, ids)),
  ]);
  // An account reused across clients over time is claimed by several current clients, so a campaign
  // must be attributed by NAME there — "first claimant wins" would credit it to the wrong client.
  // The one shared ownership ladder (override -> name -> sole ACTIVE claimant -> nobody). This used
  // to fall back to the FIRST claimant of a contested account, which put another client's name on the
  // campaign and ignored manual overrides entirely.
  const ownership = await loadCampaignOwnership();
  const clientForCampaign = (cp: CampaignRef): string | null => {
    const ownerId = ownership.ownerOf(cp);
    return ownerId ? ownership.nameOf(ownerId) : null;
  };
  const acctById = new Map(acctRows.map((a) => [a.id, a]));
  const clicksById = new Map<string, number>();
  const rowsById = new Map<string, { actions: unknown; actionValues: unknown }[]>();
  for (const r of insightRows) {
    clicksById.set(r.entityId, (clicksById.get(r.entityId) ?? 0) + num(r.clicks));
    const arr = rowsById.get(r.entityId) ?? [];
    arr.push({ actions: r.actions, actionValues: r.actionValues });
    rowsById.set(r.entityId, arr);
  }
  const campBudgetById = new Map(campBudgets.map((c) => [c.id, c.dailyBudget]));
  const adsetSumById = new Map<string, number>();
  for (const s of adsetBudgets) {
    if (s.dailyBudget == null) continue;
    if (s.effectiveStatus && s.effectiveStatus !== "ACTIVE") continue; // only budgets eligible to spend
    adsetSumById.set(s.campaignId, (adsetSumById.get(s.campaignId) ?? 0) + Number(s.dailyBudget));
  }
  const days = Math.max(1, Math.round((Date.parse(w.until) - Date.parse(w.since)) / 864e5) + 1);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return active.map((c) => {
    const acct = acctById.get(c.accountId);
    const status = accountStatus(acct?.status);
    const cents =
      campBudgetById.get(c.id) ?? (adsetSumById.has(c.id) ? adsetSumById.get(c.id) : null);
    return {
      name: c.name,
      account: c.accountName,
      accountStatus: status,
      accountDisableReason:
        status === "DISABLED" ? disableReasonLabel(acct?.disableReason ?? null) : null,
      client: clientForCampaign(c),
      status: c.status,
      spend: round2(c.spend),
      dailyAvgSpend: round2(c.spend / days),
      dailyBudget: cents != null ? round2(Number(cents) / 100) : null,
      impressions: c.impressions,
      clicks: clicksById.get(c.id) ?? 0,
      ctr: round2(c.ctr),
      cpc: round2(c.cpc),
      results: c.results,
      resultLabel: c.resultLabel,
      events: canonicalEvents(rowsById.get(c.id) ?? []),
    };
  });
}

export interface AccountDirectoryRow {
  id: string;
  name: string | null;
  status: AccountStatus; // ACTIVE | PAUSED | DISABLED | PENDING (DISABLED = suspended by Meta)
  disableReason: string | null;
  disabledSince: string | null; // date it flipped to DISABLED (YYYY-MM-DD), or null if not synced
  client: string | null; // client that owns this account, if mapped
  clientStatus: string | null; // that client's Notion board status (Live/Paused/…)
  // True when this account sits in the owning client's Notion "Active Account ID" column (the
  // designated account), vs an "Other ad accounts" entry or a manually-added account.
  isActiveAccount: boolean;
}

export interface AccountDirectory {
  // When the Notion client→account mapping was last synced; board edits after this aren't reflected.
  mappingSyncedAt: string | null;
  accounts: AccountDirectoryRow[];
  // Designated Active Account IDs (from live clients) our Meta token can't see — not returned by
  // /me/adaccounts, so we have NO status for them (they need assigning to the system user).
  unsyncedActiveAccounts: { client: string; clientStatus: string | null; accountId: string }[];
}

/**
 * Every ad account with its Meta status (DISABLED = suspended/disabled, with reason) joined to the
 * CURRENT (non-removed) client that owns it and that client's Notion board status — one call for
 * cross-referencing Notion status against account suspension. Removed "ghost" client rows never own
 * accounts here (they would mask a live account with a stale status like "Full Budget Finished").
 * `mappingSyncedAt` exposes how fresh the Notion mapping is so a just-made board edit can be flagged.
 */
export async function fetchAccountDirectory(): Promise<AccountDirectory> {
  const [accts, clients] = await Promise.all([
    db
      .select({
        id: schema.accounts.id,
        name: schema.accounts.name,
        status: schema.accounts.status,
        disableReason: schema.accounts.disableReason,
      })
      .from(schema.accounts),
    db.select().from(schema.clients),
  ]);
  // Only CURRENT clients own accounts; a removed ghost row must not mask the live owner's status.
  const live = clients.filter((c) => c.removedAt == null);
  const owner = new Map<string, { name: string; status: string | null; isActive: boolean }>();
  for (const c of live) {
    const activeSet = new Set((c.notionActiveAccountIds as string[] | null) ?? []);
    for (const aid of effectiveAccountIds(c)) {
      if (!owner.has(aid))
        owner.set(aid, { name: c.name, status: c.status ?? null, isActive: activeSet.has(aid) });
    }
  }
  const mappingSyncedAt = live.reduce<Date | null>(
    (max, c) => (c.syncedAt && (!max || c.syncedAt > max) ? c.syncedAt : max),
    null,
  );
  const disabledSince = await disabledSinceMap(
    accts.filter((a) => accountStatus(a.status) === "DISABLED").map((a) => a.id),
  );
  const acctIds = new Set(accts.map((a) => a.id));
  const unsyncedActiveAccounts: {
    client: string;
    clientStatus: string | null;
    accountId: string;
  }[] = [];
  for (const c of live) {
    for (const aid of (c.notionActiveAccountIds as string[] | null) ?? []) {
      if (!acctIds.has(aid))
        unsyncedActiveAccounts.push({
          client: c.name,
          clientStatus: c.status ?? null,
          accountId: aid,
        });
    }
  }
  return {
    mappingSyncedAt: mappingSyncedAt?.toISOString() ?? null,
    unsyncedActiveAccounts,
    accounts: accts.map((a) => {
      const status = accountStatus(a.status);
      const o = owner.get(a.id);
      return {
        id: a.id,
        name: a.name,
        status,
        disableReason: status === "DISABLED" ? disableReasonLabel(a.disableReason) : null,
        disabledSince: status === "DISABLED" ? (disabledSince.get(a.id) ?? null) : null,
        client: o?.name ?? null,
        clientStatus: o?.status ?? null,
        isActiveAccount: o?.isActive ?? false,
      };
    }),
  };
}

/**
 * Manually assign a campaign to a client (or clear the assignment, restoring automatic attribution).
 * Admin-only and audited: it silently changes which client a campaign's spend lands under.
 */
export async function setCampaignClient(
  campaignId: string,
  clientId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const me = await currentUser();
  if (!me || !isAdmin(me.role)) return { ok: false, error: "Admins only." };
  const [campaign] = await db
    .select({ id: schema.campaigns.id, name: schema.campaigns.name })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  if (!campaign) return { ok: false, error: "Unknown campaign." };

  if (clientId === null) {
    await db
      .delete(schema.campaignClientOverrides)
      .where(eq(schema.campaignClientOverrides.campaignId, campaignId));
    await audit("campaign.client_reset", `cleared override on "${campaign.name}"`);
    return { ok: true };
  }
  const target = await getClientRow(clientId);
  if (!target) return { ok: false, error: "Unknown client." };
  await db
    .insert(schema.campaignClientOverrides)
    .values({ campaignId, clientId, setBy: me.email })
    .onConflictDoUpdate({
      target: schema.campaignClientOverrides.campaignId,
      set: { clientId, setBy: me.email, createdAt: new Date() },
    });
  await audit("campaign.client_set", `moved "${campaign.name}" to ${target.name}`);
  return { ok: true };
}

/** Current manual campaign→client assignments, for surfacing "moved here" in the UI. */
export async function listCampaignOverrides(): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.campaignClientOverrides);
  return Object.fromEntries(rows.map((r) => [r.campaignId, r.clientId]));
}
