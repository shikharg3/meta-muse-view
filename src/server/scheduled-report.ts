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
 *
 * A recipe may also ask for interrupted days to be modeled (`modeling.ts`); such a report is marked
 * as an estimate throughout (`annotateModeled`).
 */
import { and, gte, inArray, lte, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resolvePreset } from "@/lib/date-presets";
import { addDays } from "@/lib/range";
import { csvText } from "@/lib/download";
import { reportCsvRows } from "@/lib/report-export";
import { metric } from "@/lib/report-catalog";
import { IDENTITY_COLUMNS, reportFilename, type ReportRecipe } from "@/lib/scheduled-report";
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
  type ReportRowSource,
} from "@/server/agent/report";
import {
  MODELING_DEFAULTS,
  modelInterruptedDays,
  type KeyedRow,
  type ModelingResult,
} from "@/server/modeling";
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
  adSetId?: string;
  adSetName?: string;
}

/** One synced entity-day: the engine's row plus the ids that place it. */
export interface EntityDayRow {
  accountId: string;
  entityId: string;
  row: InsightRow;
}

const text = (key: string, label: string): ReportColumn => ({ key, label, kind: "text" });

/** Every identity column a level can fill, in default order; the recipe picks and orders them. */
const CONTEXT: Record<EntityLevel, ReportColumn[]> = {
  campaign: [
    text("_account", "Account"),
    text("_account_id", "Account ID"),
    text("_campaign", "Campaign"),
    text("_campaign_id", "Campaign ID"),
  ],
  adset: [
    text("_account", "Account"),
    text("_account_id", "Account ID"),
    text("_campaign", "Campaign"),
    text("_campaign_id", "Campaign ID"),
    text("_adset", "Ad set"),
    text("_adset_id", "Ad set ID"),
  ],
  ad: [
    text("_account", "Account"),
    text("_account_id", "Account ID"),
    text("_campaign", "Campaign"),
    text("_campaign_id", "Campaign ID"),
    text("_adset", "Ad set"),
    text("_adset_id", "Ad set ID"),
    text("_ad", "Ad"),
    text("_ad_id", "Ad ID"),
  ],
};

function contextCells(level: EntityLevel, id: string, m: EntityMeta | undefined): string[] {
  const account = [m?.accountName ?? "", m?.accountId ?? ""];
  if (level === "campaign") return [...account, m?.name ?? id, id];
  const campaign = [m?.campaignName ?? "", m?.campaignId ?? ""];
  if (level === "adset") return [...account, ...campaign, m?.name ?? id, id];
  return [...account, ...campaign, m?.adSetName ?? "", m?.adSetId ?? "", m?.name ?? id, id];
}

/** Report-file rows cap: far beyond a screen, well inside Telegram's 50 MB upload limit. */
export const FILE_MAX_ROWS = 20_000;

/**
 * Shape entity rows into the report, keyed by entity ID. Pure apart from the engine call, so keying,
 * scoping and the context columns are testable without a database.
 *
 * `whitelist` is the campaign scope (null = every campaign); a row whose campaign is unknown is
 * dropped under a whitelist, as the Report Builder does. `brandOf` adds a Brand column. Every
 * identity column the level can fill is emitted; `projectColumns` keeps the ones a recipe picked.
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
      adSetId: a.adSetId,
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

/** The window a recipe covers when run on `today` (Berlin), or null when it is not a valid range. */
export function recipeRange(
  recipe: Pick<ReportRecipe, "range">,
  today: string,
): { since: string; until: string } | null {
  if ("preset" in recipe.range) return resolvePreset(recipe.range.preset, today);
  const { since, until } = recipe.range;
  return since && until && since <= until ? { since, until } : null;
}

/**
 * Keep exactly the recipe's columns, in its order. Identity keys (`dim:…`) map to the engine's
 * column keys; a key the breakdown cannot fill is skipped. The totals row is labelled in the first
 * text column kept.
 */
export function projectColumns(p: ReportPayload, keys: string[]): ReportPayload {
  const payloadKey = new Map(IDENTITY_COLUMNS.map((c) => [c.key, c.payloadKey]));
  const at = new Map(p.columns.map((c, i) => [c.key, i]));
  const idx = keys
    .map((k) => at.get(payloadKey.get(k) ?? k))
    .filter((i): i is number => i !== undefined);
  const columns = idx.map((i) => p.columns[i]);
  const firstText = columns.findIndex((c) => c.kind === "text");
  return {
    ...p,
    columns,
    rows: p.rows.map((r) => idx.map((i) => r[i])),
    totals: p.totals
      ? idx.map((i, j) =>
          columns[j].kind !== "text" ? p.totals![i] : j === firstText ? "Total" : "",
        )
      : null,
  };
}

/**
 * Run a recipe. `today` is the date presets resolve against (the Berlin date of the send, or of the
 * preview). An empty result is a payload with no rows, not an error; the caller says so.
 *
 * With `recipe.modeled`, interrupted days are replaced by an estimate (`modeling.ts`) and the report
 * says so in its title, file name and note.
 */
export async function buildRecipeReport(
  recipe: ReportRecipe,
  today: string,
  maxRows: number,
  /** A schedule's own file name (tokens allowed); null = generated. See `reportFilename`. */
  filename: string | null = null,
): Promise<ReportPayload | { error: string }> {
  const client = await getClientRow(recipe.clientId);
  if (!client) return { error: `Unknown client "${recipe.clientId}".` };
  const range = recipeRange(recipe, today);
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
    columns: recipe.columns.filter((k) => metric(k) !== undefined),
    timeIncrement: recipe.timeIncrement,
    objectiveByCampaign,
    eventByCampaign,
    markup: recipe.markup ?? undefined,
    maxRows,
  };
  // Modeling needs the days around the range too: back far enough for the fallback window, forward
  // as far as synced data goes. Without modeling the fetch is exactly the range.
  const lastDay = addDays(today, -1);
  const later = (a: string, b: string) => (a > b ? a : b);
  const ahead = addDays(range.until, MODELING_DEFAULTS.window);
  const fetch = recipe.modeled
    ? {
        since: addDays(
          range.since,
          -Math.max(MODELING_DEFAULTS.window, MODELING_DEFAULTS.fallbackBack),
        ),
        until: later(range.until, ahead < lastDay ? ahead : lastDay),
      }
    : range;
  const modeling: { result: ModelingResult | null } = { result: null };
  const model = (rows: KeyedRow[]): KeyedRow[] => {
    if (!recipe.modeled) return rows;
    modeling.result = modelInterruptedDays(rows, range, lastDay);
    return modeling.result.rows;
  };
  const finish = (p: ReportPayload): ReportPayload => {
    const named: ReportPayload = {
      ...p,
      title:
        breakdown === "none"
          ? `${n.subject} — totals`
          : `${n.subject} — by ${REPORT_DIMS[breakdown].label.toLowerCase()}`,
      filename: `${slug(n.subject)}_${range.since}_${range.until}_by_${breakdown}`,
    };
    const labelled = modeling.result ? annotateModeled(named, modeling.result) : named;
    return projectColumns(
      {
        ...labelled,
        filename: reportFilename(filename, labelled.filename, {
          ...range,
          today,
          modeled: recipe.modeled,
        }),
      },
      recipe.columns,
    );
  };

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
            gte(schema.insightsDaily.date, fetch.since),
            lte(schema.insightsDaily.date, fetch.until),
          ),
        ),
    ]);
    const whitelist = n.campaignIds ? new Set(n.campaignIds) : null;
    const campaignOf = (id: string) => (level === "campaign" ? id : meta.get(id)?.campaignId);
    // Scope before modeling: another client's campaigns on a shared account must not decide
    // which of this client's days count as interrupted.
    const keyed = model(
      insights
        .filter((r) => {
          const c = campaignOf(r.entityId);
          return !whitelist || (c !== undefined && whitelist.has(c));
        })
        .map((r) => ({ accountId: r.accountId, key: r.entityId, row: insightRowFrom(r) })),
    );
    // Brand is offered as a column for every client; one with a single brand just repeats it.
    return finish(
      await composeEntityReport({
        level,
        subject: n.subject,
        spec,
        rows: keyed.map((r) => ({ accountId: r.accountId, entityId: r.key, row: r.row })),
        meta,
        whitelist,
        brandOf: n.brandOf,
      }),
    );
  }

  const full: BuildSpec = { ...spec, breakdown, campaignIds: n.campaignIds ?? undefined };
  // An empty whitelist means "nothing in scope"; the engine reads an empty list as "everything".
  let source: ReportRowSource = n.campaignIds?.length === 0 ? async () => [] : dbRowSource(full);
  if (recipe.modeled && n.campaignIds?.length !== 0) {
    const wide = dbRowSource({ ...full, since: fetch.since, until: fetch.until });
    const all: KeyedRow[] = [];
    for (const accountId of n.accountIds)
      for (const row of await wide(accountId).catch(() => []))
        all.push({
          accountId,
          key: `${row.campaign_id ?? ""}|${String(row[DIM_VALUE_KEY] ?? "")}`,
          row,
        });
    const kept = model(all);
    source = async (accountId) => kept.filter((r) => r.accountId === accountId).map((r) => r.row);
  }
  const payload = finish(await buildReport(source, full, n.subject));
  if (payload.rowCount === 0 && def?.source === "meta")
    return {
      ...payload,
      note:
        `No ${def.label.toLowerCase()} rows yet: Meta breakdowns refresh on the daily full sync, so ` +
        `a recent day can have campaign data but no breakdown rows.`,
    };
  return payload;
}

/**
 * Mark a report as a modeled estimate: "(modeled)" in the title and file name, and the modeled days
 * with their basis first in the note (which the Telegram caption carries).
 */
export function annotateModeled(p: ReportPayload, m: ModelingResult): ReportPayload {
  const money = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
  const days = m.modeled.map(
    (d) =>
      `${d.date} (actual spend ${money(d.actualSpend)} vs ${money(d.referenceMedian)} median of ` +
      `${d.referenceDays.length} active days)`,
  );
  const basis =
    `each is the mean of the active days within ±${MODELING_DEFAULTS.window} days (the previous ` +
    `${MODELING_DEFAULTS.fallbackBack} when no later day has data yet), ` +
    `±${Math.round(MODELING_DEFAULTS.variance * 100)}% per metric`;
  const head =
    m.modeled.length === 0
      ? "Modeled report: no interrupted days in this window, so every figure is actual."
      : `MODELED ESTIMATE, not actual delivery. ${m.modeled.length} interrupted day` +
        `${m.modeled.length === 1 ? "" : "s"} replaced by an estimate — ${days.join("; ")}; ${basis}.`;
  const skipped = m.skipped.length
    ? ` Left actual: ${m.skipped.map((s) => `${s.date} (${s.reason})`).join("; ")}.`
    : "";
  return {
    ...p,
    title: `${p.title} (modeled)`,
    filename: `${p.filename}_modeled`,
    note: [head + skipped, p.note].filter(Boolean).join(" "),
  };
}

/** The CSV as sent. The BOM makes Excel read UTF-8; without it Cyrillic or fullwidth names garble. */
export function reportCsv(p: ReportPayload): string {
  return `\uFEFF${csvText(reportCsvRows(p))}\n`;
}
