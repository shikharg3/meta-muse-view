import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { deriveKpis, windowStart, canonicalEvents, type ClientEvent } from "@/server/agg";
import { fetchCampaigns, objectiveResults } from "./dashboard";
import { effectiveAccountIds, getClientRow } from "@/sync/jobs/clients";
import type { Campaign, Kpis } from "@/lib/types";
import { currentUser, audit } from "@/server/fns/auth";

const num = (v: unknown): number => Number(v ?? 0);

export interface ClientSummary {
  id: string;
  name: string;
  status: string | null;
  accountCount: number;
  syncedAt: string | null;
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
export async function fetchClientsRanked(days: number): Promise<ClientRanked[]> {
  const rows = await db.select().from(schema.clients);
  if (rows.length === 0) return [];
  const since = windowStart(days);
  const [acct, results] = await Promise.all([
    db
      .select({
        entityId: schema.insightsDaily.entityId,
        spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
        impressions: sql<number>`coalesce(sum(${schema.insightsDaily.impressions}),0)`,
      })
      .from(schema.insightsDaily)
      .where(and(eq(schema.insightsDaily.level, "account"), gte(schema.insightsDaily.date, since)))
      .groupBy(schema.insightsDaily.entityId),
    objectiveResults(since).then((r) => r.account),
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
        spend,
        impressions,
        results: resultVal,
        resultLabel,
      };
    })
    .sort((a, b) => b.spend - a.spend);
}

export async function fetchClientDetail(id: string, days: number): Promise<ClientDetail | null> {
  const row = await getClientRow(id);
  if (!row) return null;
  const accountIds = effectiveAccountIds(row);
  const since = windowStart(days);
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
          gte(schema.insightsDaily.date, since),
        ),
      ),
  ]);

  const accName = new Map(accountRows.map((a) => [a.id, a.name]));

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
    };
  });

  // Nested campaign→ad set→ad tree scoped to this client's accounts (drill-down).
  const campaigns = (await fetchCampaigns(days, accountIds)).sort((a, b) => b.spend - a.spend);

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    kpis: deriveKpis(totals),
    accounts,
    campaigns,
    events: canonicalEvents(accountTotals),
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
