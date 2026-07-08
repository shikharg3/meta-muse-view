import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import {
  deriveKpis,
  windowStart,
  canonicalEvents,
  accountStatus,
  type ClientEvent,
} from "@/server/agg";
import { type DateWindow } from "@/lib/range";
import { fetchCampaigns, objectiveResults, disabledSinceMap } from "./dashboard";
import { effectiveAccountIds, getClientRow } from "@/sync/jobs/clients";
import type { Campaign, Kpis, AccountStatus } from "@/lib/types";
import { disableReasonLabel } from "@/lib/format";
import { currentUser, audit } from "@/server/fns/auth";

const num = (v: unknown): number => Number(v ?? 0);

export interface ClientSummary {
  id: string;
  name: string;
  status: string | null;
  accountCount: number;
  syncedAt: string | null;
  removedAt: string | null; // set when the client is no longer on the Notion board (data retained)
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

export interface ClientDetail {
  id: string;
  name: string;
  status: string | null;
  kpis: Kpis;
  accounts: ClientAccountRow[];
  campaigns: Campaign[];
  /** All de-duplicated conversion/engagement events for this client over the window. */
  events: ClientEvent[];
  /** Engagement budget from Notion + spend against it (null total = not tracked). */
  budget: {
    total: number | null;
    spent: number;
    remaining: number | null;
    startDate: string | null;
    endDate: string | null;
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
        spend,
        impressions,
        results: resultVal,
        resultLabel,
      };
    })
    .sort((a, b) => b.spend - a.spend);
}

export async function fetchClientDetail(id: string, w: DateWindow): Promise<ClientDetail | null> {
  const row = await getClientRow(id);
  if (!row) return null;
  const accountIds = effectiveAccountIds(row);
  const notionIds = (row.notionAccountIds as string[] | null) ?? [];

  if (accountIds.length === 0) {
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
      budget: {
        total: row.budget ?? null,
        spent: 0,
        remaining: row.budget ?? null,
        startDate: row.startDate ? String(row.startDate) : null,
        endDate: row.endDate ? String(row.endDate) : null,
      },
    };
  }

  const [accountRows, accountTotals] = await Promise.all([
    db.select().from(schema.accounts).where(inArray(schema.accounts.id, accountIds)),
    db
      .select()
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, "account"),
          inArray(schema.insightsDaily.entityId, accountIds),
          gte(schema.insightsDaily.date, w.since),
          lte(schema.insightsDaily.date, w.until),
        ),
      ),
  ]);

  const accName = new Map(accountRows.map((a) => [a.id, a.name]));
  const accStatus = new Map(accountRows.map((a) => [a.id, accountStatus(a.status)]));
  const accInfo = new Map(accountRows.map((a) => [a.id, a]));

  // Per-account sums + overall KPI totals.
  const perAccount = new Map<string, { spend: number; impressions: number; clicks: number }>();
  const totals = { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, reach: 0 };
  for (const r of accountTotals) {
    const acc = perAccount.get(r.entityId) ?? { spend: 0, impressions: 0, clicks: 0 };
    acc.spend += num(r.spend);
    acc.impressions += num(r.impressions);
    acc.clicks += num(r.clicks);
    perAccount.set(r.entityId, acc);
    totals.spend += num(r.spend);
    totals.impressions += num(r.impressions);
    totals.clicks += num(r.clicks);
    totals.conversions += num(r.conversions);
    totals.revenue += num(r.conversionValues);
    totals.reach += num(r.reach);
  }

  const accounts: ClientAccountRow[] = accountIds.map((aid) => {
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

  // Nested campaign→ad set→ad tree scoped to this client's accounts (drill-down).
  const campaigns = (await fetchCampaigns(w, accountIds)).sort((a, b) => b.spend - a.spend);
  // Spend against the current engagement budget = spend since its start date.
  let budgetSpent = 0;
  if (row.startDate) {
    const [bs] = await db
      .select({ s: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)` })
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, "account"),
          inArray(schema.insightsDaily.entityId, accountIds),
          gte(schema.insightsDaily.date, String(row.startDate)),
        ),
      );
    budgetSpent = num(bs?.s);
  }

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    kpis: deriveKpis(totals),
    accounts,
    campaigns,
    events: canonicalEvents(accountTotals),
    budget: {
      total: row.budget ?? null,
      spent: budgetSpent,
      remaining: row.budget != null ? row.budget - budgetSpent : null,
      startDate: row.startDate ? String(row.startDate) : null,
      endDate: row.endDate ? String(row.endDate) : null,
    },
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
  if (me?.role !== "admin") return { ok: false, error: "Admins only." };
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
  const camps = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      status: schema.campaigns.status,
      dailyBudget: schema.campaigns.dailyBudget,
    })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.accountId, ids));
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

/** A client's campaigns across its effective accounts — for the report campaign filter. */
export async function fetchClientCampaigns(
  clientId: string,
): Promise<{ id: string; name: string }[]> {
  const row = await getClientRow(clientId);
  if (!row) return [];
  const accounts = effectiveAccountIds(row);
  if (accounts.length === 0) return [];
  return db
    .select({ id: schema.campaigns.id, name: schema.campaigns.name })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.accountId, accounts))
    .orderBy(schema.campaigns.name);
}

/**
 * Every campaign that spent > $0 over the window, mapped to its owning ad account and CURRENT
 * client — powers the chat "which campaigns were active" question. Returns ALL active campaigns
 * (not a top-N), and resolves the client through non-archived rows only so stale board entities
 * (e.g. a client that churned but whose campaigns now belong to another) don't surface.
 */
export async function fetchActiveCampaigns(w: DateWindow): Promise<
  {
    name: string;
    account: string;
    client: string | null;
    status: string | null;
    spend: number;
    impressions: number;
    ctr: number;
    cpc: number;
    results: number;
    resultLabel: string;
  }[]
> {
  const campaigns = await fetchCampaigns(w);
  const clients = (await db.select().from(schema.clients)).filter((c) => c.removedAt == null);
  const clientByAccount = new Map<string, string>();
  for (const cl of clients)
    for (const a of effectiveAccountIds(cl))
      if (!clientByAccount.has(a)) clientByAccount.set(a, cl.name);
  return campaigns
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .map((c) => ({
      name: c.name,
      account: c.accountName,
      client: clientByAccount.get(c.accountId) ?? null,
      status: c.status,
      spend: c.spend,
      impressions: c.impressions,
      ctr: c.ctr,
      cpc: c.cpc,
      results: c.results,
      resultLabel: c.resultLabel,
    }));
}

export interface AccountDirectoryRow {
  id: string;
  name: string | null;
  status: AccountStatus; // ACTIVE | PAUSED | DISABLED | PENDING (DISABLED = suspended by Meta)
  disableReason: string | null;
  disabledSince: string | null; // date it flipped to DISABLED (YYYY-MM-DD), or null if not synced
  client: string | null; // client that owns this account, if mapped
  clientStatus: string | null; // that client's Notion board status (Live/Paused/…)
}

/**
 * Every ad account with its Meta status (DISABLED = suspended/disabled, with reason) joined to the
 * client that owns it and that client's Notion board status — a single call for cross-referencing
 * Notion campaign status against account suspension.
 */
export async function fetchAccountDirectory(): Promise<AccountDirectoryRow[]> {
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
  const owner = new Map<string, { name: string; status: string | null }>();
  for (const c of clients) {
    for (const aid of effectiveAccountIds(c)) {
      if (!owner.has(aid)) owner.set(aid, { name: c.name, status: c.status ?? null });
    }
  }
  const disabledSince = await disabledSinceMap(
    accts.filter((a) => accountStatus(a.status) === "DISABLED").map((a) => a.id),
  );
  return accts.map((a) => {
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
    };
  });
}
