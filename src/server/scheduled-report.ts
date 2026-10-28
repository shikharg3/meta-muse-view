/**
 * Run a `ReportRecipe` (client, brands, campaigns, columns, breakdown, granularity, range, markup) into a
 * `ReportPayload` for the scheduled Telegram reports and their page.
 *
 * Every metric resolves through the report engine (`buildReport`), so figures match the Report
 * Builder. Two differences, both because the result is a file someone works with in a spreadsheet:
 *
 * - Campaign, ad-set and ad breakdowns are keyed by ID, not name, and carry Account / Campaign /
 *   Ad set context columns. The builder groups those dimensions by name, which folds OneAgency's 31
 *   ad sets called "Georgia - Static" into one row.
 * - Scope can be narrowed to brands (`report-scope.ts`), and a client with several brands gets a
 *   Brand column on those breakdowns.
 */
import { and, gte, inArray, lte, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resolvePreset } from "@/lib/date-presets";
import { csvText } from "@/lib/download";
import { reportCsvRows } from "@/lib/report-export";
import type { ReportRecipe } from "@/lib/scheduled-report";
import type { InsightRow } from "@/meta/types";
import {
  buildReport,
  customEventMap,
  dbRowSource,
  DIM_VALUE_KEY,
  insightRowFrom,
  objectiveMap,
  REPORT_DIMS,
  type Breakdown,
  type BuildSpec,
  type ReportColumn,
  type ReportPayload,
} from "@/server/agent/report";
import { loadClientScope, narrowScope } from "@/server/report-scope";
import { getClientRow } from "@/sync/jobs/clients";

export type EntityLevel = "campaign" | "adset" | "ad";

/** Names that place one campaign / ad set / ad. */
export interface EntityMeta {
  name: string;
  accountId: string;
  accountName: string;
  campaignId: string;
  campaignName: string;
  adSetName?: string;
}

/** One synced entity-day: the engine's row plus the ids that place it. */
export interface EntityDayRow {
  accountId: string;
  entityId: string;
  row: InsightRow;
}

const text = (key: string, label: string): ReportColumn => ({ key, label, kind: "text" });

const CONTEXT: Record<EntityLevel, ReportColumn[]> = {
  campaign: [
    text("_account", "Account"),
    text("_campaign", "Campaign"),
    text("_id", "Campaign ID"),
  ],
  adset: [
    text("_account", "Account"),
    text("_campaign", "Campaign"),
    text("_adset", "Ad set"),
    text("_id", "Ad set ID"),
  ],
  ad: [
    text("_account", "Account"),
    text("_campaign", "Campaign"),
    text("_adset", "Ad set"),
    text("_ad", "Ad"),
    text("_id", "Ad ID"),
  ],
};

function contextCells(level: EntityLevel, id: string, m: EntityMeta | undefined): string[] {
  const head = [m?.accountName ?? "", m?.campaignName ?? ""];
  if (level === "campaign") return [head[0], m?.name ?? id, id];
  if (level === "adset") return [...head, m?.name ?? id, id];
  return [...head, m?.adSetName ?? "", m?.name ?? id, id];
}

/** Report-file rows cap: far beyond a screen, well inside Telegram's 50 MB upload limit. */
export const FILE_MAX_ROWS = 20_000;

/**
 * Shape entity rows into the report, keyed by entity ID. Pure apart from the engine call, so keying,
 * scoping and the context columns are testable without a database.
 *
 * `whitelist` is the campaign scope (null = every campaign); a row whose campaign is unknown is
 * dropped under a whitelist, as the Report Builder does. `brandOf` adds a Brand column.
 */
export async function composeEntityReport(input: {
  level: EntityLevel;
  subject: string;
  spec: Omit<BuildSpec, "breakdown" | "campaignIds">;
  rows: EntityDayRow[];
  meta: Map<string, EntityMeta>;
  whitelist: Set<string> | null;
  brandOf: Map<string, string> | null;
}): Promise<ReportPayload> {
  const { level, meta, whitelist, brandOf } = input;
  const campaignOf = (id: string) => (level === "campaign" ? id : meta.get(id)?.campaignId);
  const byAccount = new Map<string, InsightRow[]>();
  for (const r of input.rows) {
    const campaignId = campaignOf(r.entityId);
    if (whitelist && (!campaignId || !whitelist.has(campaignId))) continue;
    const list = byAccount.get(r.accountId) ?? [];
    list.push({ ...r.row, campaign_id: campaignId, [DIM_VALUE_KEY]: r.entityId });
    byAccount.set(r.accountId, list);
  }

  const payload = await buildReport(
    async (accountId) => byAccount.get(accountId) ?? [],
    { ...input.spec, breakdown: level },
    input.subject,
  );

  // The engine leads with [period?, entity id]; everything after is metrics.
  const hasPeriod = payload.columns[0]?.key === "_period";
  const engineLead = hasPeriod ? 2 : 1;
  const metricColumns = payload.columns.slice(engineLead);
  const lead: ReportColumn[] = [
    ...(hasPeriod ? [payload.columns[0]] : []),
    ...(brandOf ? [text("_brand", "Brand")] : []),
    ...CONTEXT[level],
  ];
  const spendAt = lead.length + metricColumns.findIndex((c) => c.key === "spend");
  const rows = payload.rows
    .map((cells) => {
      const id = String(cells[engineLead - 1]);
      const campaignId = campaignOf(id);
      return [
        ...(hasPeriod ? [cells[0]] : []),
        ...(brandOf ? [(campaignId && brandOf.get(campaignId)) || ""] : []),
        ...contextCells(level, id, meta.get(id)),
        ...cells.slice(engineLead),
      ];
    })
    .sort((a, b) => {
      const byPeriod = hasPeriod ? String(a[0]).localeCompare(String(b[0])) : 0;
      if (byPeriod !== 0 || spendAt < lead.length) return byPeriod;
      return Number(b[spendAt] ?? 0) - Number(a[spendAt] ?? 0);
    });

  return {
    ...payload,
    columns: [...lead, ...metricColumns],
    rows,
    totals:
      payload.totals && rows.length > 0
        ? ["Total", ...lead.slice(1).map(() => ""), ...payload.totals.slice(engineLead)]
        : null,
    rowCount: rows.length,
  };
}

/** Load names for every entity of `level` on these accounts. */
async function loadEntityMeta(
  level: EntityLevel,
  accountIds: string[],
): Promise<Map<string, EntityMeta>> {
  const [accounts, campaigns, sets, ads] = await Promise.all([
    db
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, accountIds)),
    db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        accountId: schema.campaigns.accountId,
      })
      .from(schema.campaigns)
      .where(inArray(schema.campaigns.accountId, accountIds)),
    level === "campaign"
      ? Promise.resolve([])
      : db
          .select({
            id: schema.adSets.id,
            name: schema.adSets.name,
            campaignId: schema.adSets.campaignId,
            accountId: schema.adSets.accountId,
          })
          .from(schema.adSets)
          .where(inArray(schema.adSets.accountId, accountIds)),
    level === "ad"
      ? db
          .select({
            id: schema.ads.id,
            name: schema.ads.name,
            adSetId: schema.ads.adSetId,
            accountId: schema.ads.accountId,
          })
          .from(schema.ads)
          .where(inArray(schema.ads.accountId, accountIds))
      : Promise.resolve([]),
  ]);
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
  const place = (accountId: string, campaignId: string) => ({
    accountId,
    accountName: accountName.get(accountId) ?? accountId,
    campaignId,
    campaignName: campaignName.get(campaignId) ?? campaignId,
  });
  if (level === "campaign")
    return new Map(campaigns.map((c) => [c.id, { name: c.name, ...place(c.accountId, c.id) }]));
  const setById = new Map(sets.map((s) => [s.id, s]));
  if (level === "adset")
    return new Map(sets.map((s) => [s.id, { name: s.name, ...place(s.accountId, s.campaignId) }]));
  const out = new Map<string, EntityMeta>();
  for (const a of ads) {
    const set = setById.get(a.adSetId);
    out.set(a.id, {
      name: a.name,
      adSetName: set?.name ?? a.adSetId,
      ...place(a.accountId, set?.campaignId ?? ""),
    });
  }
  return out;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "report";

/**
 * Run a recipe. `today` is the date presets resolve against (the Berlin date of the send, or of the
 * preview). An empty result is a payload with no rows, not an error; the caller says so.
 */
export async function buildRecipeReport(
  recipe: ReportRecipe,
  today: string,
  maxRows: number,
): Promise<ReportPayload | { error: string }> {
  const client = await getClientRow(recipe.clientId);
  if (!client) return { error: `Unknown client "${recipe.clientId}".` };
  const range =
    "preset" in recipe.range
      ? resolvePreset(recipe.range.preset, today)
      : recipe.range.since && recipe.range.until && recipe.range.since <= recipe.range.until
        ? recipe.range
        : null;
  if (!range) return { error: "Pick a valid date range." };
  const breakdown = recipe.breakdown as Breakdown;
  if (breakdown !== "none" && !(breakdown in REPORT_DIMS))
    return { error: `Unknown breakdown "${recipe.breakdown}".` };

  const scope = await loadClientScope(client);
  const n = narrowScope(scope, recipe.brands, recipe.campaignIds);
  if (n.accountIds.length === 0) return { error: `No ad accounts are in scope for ${n.subject}.` };
  const [objectiveByCampaign, eventByCampaign] = await Promise.all([
    objectiveMap(n.accountIds),
    customEventMap(n.accountIds),
  ]);
  const spec = {
    accountIds: n.accountIds,
    since: range.since,
    until: range.until,
    columns: recipe.columns,
    timeIncrement: recipe.timeIncrement,
    objectiveByCampaign,
    eventByCampaign,
    markup: recipe.markup ?? undefined,
    maxRows,
  };
  const named = (p: ReportPayload): ReportPayload => ({
    ...p,
    title:
      breakdown === "none"
        ? `${n.subject} — totals`
        : `${n.subject} — by ${REPORT_DIMS[breakdown].label.toLowerCase()}`,
    filename: `${slug(n.subject)}_${range.since}_${range.until}_by_${breakdown}`,
  });

  const def = breakdown === "none" ? null : REPORT_DIMS[breakdown];
  if (def?.source === "entity") {
    const level = def.level;
    const [meta, insights] = await Promise.all([
      loadEntityMeta(level, n.accountIds),
      db
        .select()
        .from(schema.insightsDaily)
        .where(
          and(
            eq(schema.insightsDaily.level, level),
            inArray(schema.insightsDaily.accountId, n.accountIds),
            gte(schema.insightsDaily.date, range.since),
            lte(schema.insightsDaily.date, range.until),
          ),
        ),
    ]);
    const multiBrand = scope.brands.length > 1 && recipe.brands.length !== 1;
    return named(
      await composeEntityReport({
        level,
        subject: n.subject,
        spec,
        rows: insights.map((r) => ({
          accountId: r.accountId,
          entityId: r.entityId,
          row: insightRowFrom(r),
        })),
        meta,
        whitelist: n.campaignIds ? new Set(n.campaignIds) : null,
        brandOf: multiBrand ? n.brandOf : null,
      }),
    );
  }

  const full: BuildSpec = { ...spec, breakdown, campaignIds: n.campaignIds ?? undefined };
  // An empty whitelist means "nothing in scope"; the engine reads an empty list as "everything".
  const source = n.campaignIds?.length === 0 ? async () => [] : dbRowSource(full);
  const payload = named(await buildReport(source, full, n.subject));
  if (payload.rowCount === 0 && def?.source === "meta")
    return {
      ...payload,
      note:
        `No ${def.label.toLowerCase()} rows yet: Meta breakdowns refresh on the daily full sync, so ` +
        `a recent day can have campaign data but no breakdown rows.`,
    };
  return payload;
}

/** The CSV as sent. The BOM makes Excel read UTF-8; without it Cyrillic or fullwidth names garble. */
export function reportCsv(p: ReportPayload): string {
  return `\uFEFF${csvText(reportCsvRows(p))}\n`;
}
