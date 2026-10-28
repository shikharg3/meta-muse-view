/**
 * The daily ad-set report: one row per ad set for one client and one day, as a `ReportDoc` the page
 * renders and the worker sends as CSV. Rules (columns, due-ness) live in `@/lib/adset-report`.
 *
 * Built ON the report engine (`buildReport`) so every metric resolves exactly as in the Report
 * Builder, but rows are keyed by ad set ID, not by name. The builder's "Ad set" breakdown groups by
 * name, and that is wrong here: one OneAgency structure repeats "Georgia - Static" in 31 ad sets
 * across accounts, which a name key would fold into a single row.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ADSET_REPORT_METRICS } from "@/lib/adset-report";
import { csvText } from "@/lib/download";
import { reportCsvRows, type ReportDoc } from "@/lib/report-export";
import type { InsightRow } from "@/meta/types";
import { buildReport, DIM_VALUE_KEY, insightRowFrom } from "@/server/agent/report";
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";
import { effectiveAccountIds, getClientRow } from "@/sync/jobs/clients";

/** What the engine needs per ad set beyond its insight row. */
export interface AdsetMeta {
  name: string;
  campaignId: string;
  campaignName: string;
  accountId: string;
  accountName: string;
}

/** One synced ad-set day: the engine's row plus the ids that place it. */
export interface AdsetDayRow {
  accountId: string;
  adSetId: string;
  row: InsightRow;
}

export interface AdsetReport {
  clientName: string;
  date: string;
  doc: ReportDoc;
  /** Totals by metric key, for the Telegram caption and the page header. */
  totals: Record<(typeof ADSET_REPORT_METRICS)[number], number>;
}

const LEAD_COLUMNS = [
  { key: "_date", label: "Date", kind: "text" as const },
  { key: "_account", label: "Account", kind: "text" as const },
  { key: "_campaign", label: "Campaign", kind: "text" as const },
  { key: "_adset", label: "Ad set", kind: "text" as const },
  { key: "_adset_id", label: "Ad set ID", kind: "text" as const },
];

/**
 * Shape a client's ad-set rows for `date` into the report. Pure apart from the engine call, so the
 * row keying and scoping are testable without a database.
 *
 * `owned` is the client's campaign scope on shared accounts (null = every campaign of its accounts);
 * a row whose ad set has no known campaign is dropped under a scope, as the Report Builder does.
 */
export async function composeAdsetReport(input: {
  clientName: string;
  date: string;
  accountIds: string[];
  rows: AdsetDayRow[];
  meta: Map<string, AdsetMeta>;
  owned: string[] | null;
}): Promise<AdsetReport> {
  const scope = input.owned ? new Set(input.owned) : null;
  const byAccount = new Map<string, InsightRow[]>();
  for (const r of input.rows) {
    const campaignId = input.meta.get(r.adSetId)?.campaignId;
    if (scope && (!campaignId || !scope.has(campaignId))) continue;
    const list = byAccount.get(r.accountId) ?? [];
    list.push({ ...r.row, campaign_id: campaignId, [DIM_VALUE_KEY]: r.adSetId });
    byAccount.set(r.accountId, list);
  }

  const payload = await buildReport(
    async (accountId) => byAccount.get(accountId) ?? [],
    {
      accountIds: input.accountIds,
      since: input.date,
      until: input.date,
      columns: [...ADSET_REPORT_METRICS],
      breakdown: "adset",
      timeIncrement: "1",
      objectiveByCampaign: {},
    },
    input.clientName,
  );

  // The engine's leading cells are [date, ad set id]; everything after them is the metrics.
  const metricColumns = payload.columns.slice(2);
  const spendAt = metricColumns.findIndex((c) => c.key === "spend");
  const rows = payload.rows
    .map((cells) => {
      const id = String(cells[1]);
      const m = input.meta.get(id);
      return [
        cells[0],
        m?.accountName ?? "",
        m?.campaignName ?? "",
        m?.name ?? id,
        id,
        ...cells.slice(2),
      ];
    })
    .sort((a, b) => Number(b[5 + spendAt] ?? 0) - Number(a[5 + spendAt] ?? 0));

  const totalCells = payload.totals?.slice(2) ?? metricColumns.map(() => 0);
  const totals = Object.fromEntries(
    metricColumns.map((c, i) => [c.key, Number(totalCells[i] ?? 0)]),
  ) as AdsetReport["totals"];

  return {
    clientName: input.clientName,
    date: input.date,
    totals,
    doc: {
      title: `${input.clientName} — ad sets`,
      subtitle: input.date,
      note: payload.note,
      columns: [...LEAD_COLUMNS, ...metricColumns],
      rows,
      totals: rows.length > 0 ? ["Total", "", "", "", "", ...totalCells] : null,
      filename: `${
        input.clientName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "client"
      }_adsets_${input.date}`,
    },
  };
}

/** Load a client's ad-set rows for one day and build the report. */
export async function buildAdsetReport(
  clientId: string,
  date: string,
): Promise<AdsetReport | { error: string }> {
  const client = await getClientRow(clientId);
  if (!client) return { error: `Unknown client "${clientId}".` };
  const accountIds = effectiveAccountIds(client);
  if (accountIds.length === 0) return { error: `No ad accounts are mapped to ${client.name}.` };

  const [owned, insights, sets, campaigns, accounts] = await Promise.all([
    ownedCampaignIds(clientId, accountIds),
    db
      .select()
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, "adset"),
          eq(schema.insightsDaily.date, date),
          inArray(schema.insightsDaily.accountId, accountIds),
        ),
      ),
    db
      .select({
        id: schema.adSets.id,
        name: schema.adSets.name,
        campaignId: schema.adSets.campaignId,
        accountId: schema.adSets.accountId,
      })
      .from(schema.adSets)
      .where(inArray(schema.adSets.accountId, accountIds)),
    db
      .select({ id: schema.campaigns.id, name: schema.campaigns.name })
      .from(schema.campaigns)
      .where(inArray(schema.campaigns.accountId, accountIds)),
    db
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, accountIds)),
  ]);

  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const meta = new Map<string, AdsetMeta>(
    sets.map((s) => [
      s.id,
      {
        name: s.name,
        campaignId: s.campaignId,
        campaignName: campaignName.get(s.campaignId) ?? s.campaignId,
        accountId: s.accountId,
        accountName: accountName.get(s.accountId) ?? s.accountId,
      },
    ]),
  );

  return composeAdsetReport({
    clientName: client.name,
    date,
    accountIds,
    rows: insights.map((r) => ({
      accountId: r.accountId,
      adSetId: r.entityId,
      row: insightRowFrom(r),
    })),
    meta,
    owned,
  });
}

/**
 * The CSV file as sent. The BOM makes Excel read it as UTF-8; without it, a non-ASCII campaign name
 * (rented accounts carry Cyrillic and fullwidth punctuation) opens as mojibake.
 */
export function adsetReportCsv(r: AdsetReport): string {
  return `\uFEFF${csvText(reportCsvRows(r.doc))}\n`;
}
