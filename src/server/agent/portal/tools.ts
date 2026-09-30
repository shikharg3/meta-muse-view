import { authFailure } from "@/lib/auth/errors";
import { addDays, isYmd, resolveWindow, type DateWindow } from "@/lib/range";
import type { Kpis } from "@/lib/types";
import {
  canSeeCampaign,
  narrowToPortalBrands,
  portalBrandOf,
  portalBrands,
  type PortalScope,
} from "@/portal/scope";
import {
  buildBreakdowns,
  buildCampaign,
  buildCampaigns,
  buildOverview,
  portalFreshness,
  PORTAL_DIMENSIONS,
  type PortalDimension,
  type PortalSeriesPoint,
} from "@/server/fns/portal";
import { buildCreatives } from "@/server/fns/portal-creative";
import {
  buildRows,
  type PortalReportBreakdown,
  type PortalReportGranularity,
} from "@/server/fns/portal-report";
import type { AnthropicTool } from "../anthropic";
import type { AgentToolbox, ToolVisual } from "../chat";

/**
 * The portal assistant's tools: the portal's own scoped read layer, bound to ONE brand.
 *
 * This file is the portal assistant's entire data boundary, so it is built the opposite way round
 * from the staff registry (`../tools`). Those tools take a client name from the model and resolve
 * it against the whole agency; these take nothing that selects data. The brand is fixed in a
 * closure before the model is shown a single definition, no tool has a brand or client parameter,
 * and every read goes through the `build*` functions of `@/server/fns/portal*` — the same code, the
 * same markup and the same whitelist the portal's pages use — on a scope already narrowed to that
 * brand (`bindPortalBrand`). What the model can reach is therefore exactly what the customer's own
 * dashboard shows for that brand, and a prompt cannot talk its way past a parameter that does not
 * exist.
 *
 * Nothing here imports the commission loaders: markup happens inside the read layer, before any
 * figure reaches a tool result, and no rate or raw spend is ever in reach.
 */

/** The brand a turn is bound to, as the customer knows it. */
export interface BoundBrand {
  /** The portal brand id (`portalBrandOf`). */
  id: string;
  name: string;
}

/** A scope narrowed to exactly one portal brand, and that brand. Only `bindPortalBrand` makes one. */
export interface BrandBinding {
  scope: PortalScope;
  brand: BoundBrand;
}

/**
 * Bind a turn to `brandId`, or refuse.
 *
 * The id is looked up among the brands the caller's OWN scope lists (`portalBrands`), never trusted:
 * an id they were not granted is refused outright. That lookup is the check — not
 * `narrowToPortalBrands`, which by design reads a selection naming nothing in scope as "all
 * brands", the right answer for a dashboard filter and the wrong one for a turn that must see one
 * brand. The narrowed result is then verified to hold that brand's campaigns and nothing else,
 * because the whole turn inherits whatever this returns.
 */
export function bindPortalBrand(scope: PortalScope, brandId: string): BrandBinding | null {
  const entry = portalBrands(scope).find((b) => b.id === brandId);
  if (!entry) return null;
  const narrowed = narrowToPortalBrands(scope, [entry.id]);
  if (narrowed.campaignIds.length === 0) return null;
  if (narrowed.campaignIds.some((id) => portalBrandOf(narrowed, id) !== entry.id)) return null;
  return {
    scope: narrowed,
    brand: {
      id: entry.id,
      // The fallback entry (campaigns under none of the client's board rows) carries the client's
      // own name; the portal lists it as that client's other campaigns, and so does the assistant.
      name: entry.id === entry.clientId ? `${entry.name} (other campaigns)` : entry.name,
    },
  };
}

// ── inputs ───────────────────────────────────────────────────────────────────────────────────

/** The longest window a tool reads; the portal's own range picker allows the same. */
const MAX_WINDOW_DAYS = 400;
const DEFAULT_WINDOW_DAYS = 30;

const WINDOW_PROPS = {
  days: {
    type: "integer",
    minimum: 1,
    maximum: MAX_WINDOW_DAYS,
    description: `Trailing window ending today, in days (default ${DEFAULT_WINDOW_DAYS}). days=1 is today only; days=7 the last 7 days.`,
  },
  since: {
    type: "string",
    description: "Start date YYYY-MM-DD. Use together with until; overrides days.",
  },
  until: { type: "string", description: "End date YYYY-MM-DD, inclusive. Use with since." },
} as const;

type ToolError = { error: string };

/** The window a tool reads: explicit dates when both are given, else a trailing day count. */
function windowOf(input: Record<string, unknown>): DateWindow | ToolError {
  const { since, until } = input;
  if (since !== undefined || until !== undefined) {
    if (!isYmd(since) || !isYmd(until)) {
      return { error: "since and until must both be real dates in YYYY-MM-DD form." };
    }
    const w = resolveWindow({ days: DEFAULT_WINDOW_DAYS, from: since, to: until });
    if (w.days > MAX_WINDOW_DAYS) {
      return { error: `A date range can span at most ${MAX_WINDOW_DAYS} days.` };
    }
    return w;
  }
  const days = input.days === undefined ? DEFAULT_WINDOW_DAYS : Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
    return { error: `days must be a whole number from 1 to ${MAX_WINDOW_DAYS}.` };
  }
  return resolveWindow({ days });
}

const isToolError = (v: unknown): v is ToolError =>
  typeof v === "object" && v !== null && "error" in v;

const rangeOf = (w: DateWindow) => ({ since: w.since, until: w.until, days: w.days });

// ── output shaping ─────────────────────────────────────────────────────────────────────────────

const round = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round((Number.isFinite(n) ? n : 0) * f) / f;
};

/**
 * One set of figures as the model reads them: money to the cent, rates to two places. The portal
 * sends unrounded floats to the browser, which formats them; the model would otherwise quote
 * "$1234.5600000001".
 */
function metricsOf(k: Kpis & { registrations: number; deposits: number }) {
  return {
    spend: round(k.spend, 2),
    impressions: k.impressions,
    reach: k.reach,
    clicks: k.clicks,
    ctrPct: round(k.ctr, 2),
    cpc: round(k.cpc, 2),
    cpm: round(k.cpm, 2),
    conversions: round(k.conversions, 2),
    revenue: round(k.revenue, 2),
    roas: round(k.roas, 2),
    registrations: k.registrations,
    deposits: k.deposits,
  };
}

const clip = (s: string | null, max: number): string | null =>
  s === null || s.length <= max ? s : `${s.slice(0, max)}…`;

/** Cap a list the model reads, and say so when it was cut. */
function capped<T>(list: T[], max: number): { items: T[]; note?: string } {
  return list.length <= max
    ? { items: list }
    : { items: list.slice(0, max), note: `Showing the top ${max} of ${list.length}.` };
}

// ── the daily trend ──────────────────────────────────────────────────────────────────────────

type TrendMetric =
  | "spend"
  | "impressions"
  | "reach"
  | "clicks"
  | "ctr"
  | "cpc"
  | "cpm"
  | "conversions"
  | "revenue"
  | "roas"
  | "registrations"
  | "deposits";

interface TrendDef {
  label: string;
  /** The chart's format switch: USD sums, cpc/cpm/%/x average, count sums. */
  unit: "USD" | "cpc" | "cpm" | "%" | "x" | "count";
  decimals: number;
  value(p: PortalSeriesPoint): number;
}

const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0);

const TREND: Record<TrendMetric, TrendDef> = {
  spend: { label: "Spend", unit: "USD", decimals: 2, value: (p) => p.spend },
  impressions: { label: "Impressions", unit: "count", decimals: 0, value: (p) => p.impressions },
  reach: { label: "Reach", unit: "count", decimals: 0, value: (p) => p.reach },
  clicks: { label: "Clicks", unit: "count", decimals: 0, value: (p) => p.clicks },
  ctr: { label: "CTR", unit: "%", decimals: 2, value: (p) => ratio(p.clicks, p.impressions) * 100 },
  cpc: { label: "CPC", unit: "cpc", decimals: 2, value: (p) => ratio(p.spend, p.clicks) },
  cpm: {
    label: "CPM",
    unit: "cpm",
    decimals: 2,
    value: (p) => ratio(p.spend, p.impressions) * 1000,
  },
  conversions: { label: "Conversions", unit: "count", decimals: 2, value: (p) => p.conversions },
  revenue: { label: "Revenue", unit: "USD", decimals: 2, value: (p) => p.revenue },
  roas: { label: "ROAS", unit: "x", decimals: 2, value: (p) => ratio(p.revenue, p.spend) },
  registrations: {
    label: "Registrations",
    unit: "count",
    decimals: 0,
    value: (p) => p.registrations,
  },
  deposits: { label: "Deposits", unit: "count", decimals: 0, value: (p) => p.deposits },
};

const TREND_METRICS = Object.keys(TREND) as TrendMetric[];
const isTrendMetric = (v: unknown): v is TrendMetric =>
  typeof v === "string" && TREND_METRICS.some((m) => m === v);

const isDimension = (v: unknown): v is PortalDimension =>
  typeof v === "string" && PORTAL_DIMENSIONS.some((d) => d === v);

const BREAKDOWNS: readonly PortalReportBreakdown[] = ["total", "campaign"];
const GRANULARITIES: readonly PortalReportGranularity[] = ["range", "day", "week"];

// ── the toolbox ──────────────────────────────────────────────────────────────────────────────

interface PortalTool {
  definition: AnthropicTool;
  label: string;
  run(input: Record<string, unknown>): Promise<unknown>;
}

/** Refused rather than answered empty: an empty answer about an id is itself information. */
const NOT_THIS_BRAND: ToolError = {
  error: "No campaign with that id belongs to this brand. Use list_campaigns to find campaign ids.",
};

/**
 * The tools for one bound turn. Each closes over `binding`; none can be pointed anywhere else.
 */
export function portalToolbox({ scope, brand }: BrandBinding): AgentToolbox {
  /**
   * A campaign id the model passes must be one of THIS brand's. The scope is already narrowed, so
   * `canSeeCampaign` alone would do today — the brand comparison is kept anyway so the guarantee
   * does not rest on how the scope was built.
   */
  const ownsCampaign = (id: unknown): id is string =>
    typeof id === "string" && canSeeCampaign(scope, id) && portalBrandOf(scope, id) === brand.id;

  /**
   * Which results become a KPI strip or a chart. Keyed by the result object itself: the loop hands
   * `visualOf` the exact value `run` returned, so the visual is recorded where the typed data is
   * rather than re-validated from `unknown`.
   */
  const visuals = new WeakMap<object, ToolVisual>();

  const tools: PortalTool[] = [
    {
      label: "Performance overview",
      definition: {
        name: "get_overview",
        description:
          "The brand's headline results over a window — spend, impressions, reach, clicks, CTR, CPC, CPM, conversions, revenue, ROAS, registrations and deposits — plus the % change of each against the previous period of equal length. Start here for 'how are we doing' questions.",
        input_schema: { type: "object", properties: { ...WINDOW_PROPS } },
      },
      async run(input) {
        const w = windowOf(input);
        if (isToolError(w)) return w;
        const o = await buildOverview(scope, w);
        const registrations = o.series.reduce((sum, p) => sum + p.registrations, 0);
        const deposits = o.series.reduce((sum, p) => sum + p.deposits, 0);
        const result = {
          brand: brand.name,
          range: rangeOf(w),
          previousPeriod: { since: w.prevSince, until: addDays(w.since, -1) },
          totals: metricsOf({ ...o.kpis, registrations, deposits }),
          // Null means the previous period had nothing to compare against.
          changeVsPreviousPeriodPct: o.deltas,
        };
        visuals.set(result, { kind: "cards", title: brand.name, kpis: o.kpis });
        return result;
      },
    },
    {
      label: "Daily trend",
      definition: {
        name: "get_daily_trend",
        description:
          "One metric day by day over a window, drawn as a chart for the customer. For the whole brand, or for one campaign when campaign_id is given. Use for trend, 'over time', best/worst day and pacing questions.",
        input_schema: {
          type: "object",
          properties: {
            metric: { type: "string", enum: TREND_METRICS },
            campaign_id: {
              type: "string",
              description: "Optional: one campaign's id from list_campaigns.",
            },
            ...WINDOW_PROPS,
          },
          required: ["metric"],
        },
      },
      async run(input) {
        const metric = input.metric;
        if (!isTrendMetric(metric)) {
          return { error: `metric must be one of: ${TREND_METRICS.join(", ")}.` };
        }
        const campaignId = input.campaign_id;
        if (campaignId !== undefined && !ownsCampaign(campaignId)) return NOT_THIS_BRAND;
        const w = windowOf(input);
        if (isToolError(w)) return w;
        let subject = brand.name;
        let series: PortalSeriesPoint[];
        if (campaignId !== undefined) {
          const detail = await buildCampaign(scope, campaignId, w);
          subject = detail.name;
          series = detail.series;
        } else {
          series = (await buildOverview(scope, w)).series;
        }
        const def = TREND[metric];
        const points = series.map((p) => ({
          date: p.date,
          value: round(def.value(p), def.decimals),
        }));
        const title = `${def.label} — ${subject} (${w.since} → ${w.until})`;
        const result = {
          title,
          unit: def.unit,
          points,
          note: "Days with no delivery are omitted. For a period total use get_overview, not the sum of these points.",
        };
        visuals.set(result, { kind: "series", title, unit: def.unit, points });
        return result;
      },
    },
    {
      label: "Campaigns",
      definition: {
        name: "list_campaigns",
        description:
          "Every campaign of the brand that delivered in the window, largest spend first, with its id, status (running, paused, finished, scheduled) and full metrics. Use to compare or rank campaigns and to find a campaign's id.",
        input_schema: { type: "object", properties: { ...WINDOW_PROPS } },
      },
      async run(input) {
        const w = windowOf(input);
        if (isToolError(w)) return w;
        const rows = (await buildCampaigns(scope, w)).filter((r) => r.brandId === brand.id);
        const { items, note } = capped(rows, 50);
        return {
          range: rangeOf(w),
          campaignCount: rows.length,
          campaigns: items.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            ...metricsOf(r),
          })),
          ...(note ? { note } : {}),
        };
      },
    },
    {
      label: "Campaign details",
      definition: {
        name: "get_campaign",
        description:
          "One campaign in detail: status, metrics with % change vs the previous period, and its ad sets (audiences) with each one's ESTIMATED share of the campaign's spend. Takes a campaign id from list_campaigns.",
        input_schema: {
          type: "object",
          properties: { campaign_id: { type: "string" }, ...WINDOW_PROPS },
          required: ["campaign_id"],
        },
      },
      async run(input) {
        const campaignId = input.campaign_id;
        if (!ownsCampaign(campaignId)) return NOT_THIS_BRAND;
        const w = windowOf(input);
        if (isToolError(w)) return w;
        const d = await buildCampaign(scope, campaignId, w);
        return {
          id: d.id,
          name: d.name,
          status: d.status,
          range: rangeOf(w),
          totals: metricsOf({ ...d.kpis, registrations: d.registrations, deposits: d.deposits }),
          changeVsPreviousPeriodPct: d.deltas,
          adSets: d.adSets.map((a) => ({
            name: a.name,
            status: a.status,
            estimatedSpendSharePct: round(a.share * 100, 1),
            estimatedSpend: round(a.spend, 2),
          })),
          adSetNote:
            "Ad-set spend is an ESTIMATE: the campaign's spend split by each ad set's budget (equally when the campaign holds its budget centrally). Say so whenever you quote it.",
        };
      },
    },
    {
      label: "Audience breakdown",
      definition: {
        name: "get_breakdown",
        description:
          "The brand's spend, clicks and conversions split by one dimension — age, gender, age_gender, country, region, market, platform (Facebook/Instagram/…), placement, device or hour of day — largest spend first.",
        input_schema: {
          type: "object",
          properties: { dimension: { type: "string", enum: PORTAL_DIMENSIONS }, ...WINDOW_PROPS },
          required: ["dimension"],
        },
      },
      async run(input) {
        const dimension = input.dimension;
        if (!isDimension(dimension)) {
          return { error: `dimension must be one of: ${PORTAL_DIMENSIONS.join(", ")}.` };
        }
        const w = windowOf(input);
        if (isToolError(w)) return w;
        const segments = await buildBreakdowns(scope, w, dimension);
        const { items, note } = capped(segments, 30);
        return {
          dimension,
          range: rangeOf(w),
          segments: items.map((s) => ({
            label: s.label,
            spend: round(s.spend, 2),
            spendSharePct: round(s.share * 100, 1),
            clicks: s.clicks,
            conversions: round(s.conversions, 2),
          })),
          ...(note ? { note } : {}),
        };
      },
    },
    {
      label: "Creatives",
      definition: {
        name: "list_creatives",
        description:
          "The brand's ads with their copy (headline, primary text, call to action), format and performance, largest spend first. Optionally for one campaign. Use for 'which ad works best' and copy questions.",
        input_schema: {
          type: "object",
          properties: {
            campaign_id: {
              type: "string",
              description: "Optional: one campaign's id from list_campaigns.",
            },
            ...WINDOW_PROPS,
          },
        },
      },
      async run(input) {
        const campaignId = input.campaign_id;
        if (campaignId !== undefined && !ownsCampaign(campaignId)) return NOT_THIS_BRAND;
        const w = windowOf(input);
        if (isToolError(w)) return w;
        const cards = await buildCreatives(
          scope,
          w,
          campaignId === undefined ? undefined : [campaignId],
        );
        const { items, note } = capped(cards, 25);
        return {
          range: rangeOf(w),
          creativeCount: cards.length,
          // Media, thumbnail and landing URLs are left out: the model cannot look at them, and a
          // URL is the one field here that could carry something other than this brand's copy.
          creatives: items.map((c) => ({
            name: c.name,
            campaign: scope.aliasOf.get(c.campaignId) ?? null,
            format: c.format,
            headline: c.headline,
            primaryText: clip(c.primaryText, 300),
            cta: c.cta,
            spend: round(c.spend, 2),
            impressions: c.impressions,
            clicks: c.clicks,
            ctrPct: round(c.ctr, 2),
            conversions: round(c.conversions, 2),
            costPerConversion: round(c.costPerConversion, 2),
          })),
          ...(note ? { note } : {}),
        };
      },
    },
    {
      label: "Report",
      definition: {
        name: "get_report",
        description:
          "A table for the window: one row for the whole brand or one per campaign (breakdown), for the whole range, per day or per week (granularity), with a correct period total. Use for day-by-day or week-by-week tables and campaign-by-period comparisons.",
        input_schema: {
          type: "object",
          properties: {
            breakdown: { type: "string", enum: BREAKDOWNS },
            granularity: { type: "string", enum: GRANULARITIES },
            ...WINDOW_PROPS,
          },
          required: ["breakdown", "granularity"],
        },
      },
      async run(input) {
        const breakdown = BREAKDOWNS.find((b) => b === input.breakdown);
        const granularity = GRANULARITIES.find((g) => g === input.granularity);
        if (!breakdown || !granularity) {
          return {
            error: `breakdown must be one of ${BREAKDOWNS.join(", ")}; granularity one of ${GRANULARITIES.join(", ")}.`,
          };
        }
        const w = windowOf(input);
        if (isToolError(w)) return w;
        const report = await buildRows(scope, w, { breakdown, granularity });
        const { items, note } = capped(report.rows, 120);
        const whole = report.totals ?? (report.rows.length === 1 ? report.rows[0].metrics : null);
        return {
          range: report.range,
          breakdown,
          granularity,
          rowCount: report.rows.length,
          rows: items.map((r) => ({ label: r.label, period: r.period, ...metricsOf(r.metrics) })),
          total: whole ? metricsOf(whole) : null,
          totalNote:
            "Quote `total` for the period — never add rows up: reach does not add across days or campaigns.",
          ...(note ? { note } : {}),
        };
      },
    },
    {
      label: "Data freshness",
      definition: {
        name: "get_data_freshness",
        description:
          "When the brand's figures were last updated, and the latest day they are complete through. Use when asked how current the numbers are, or when today's figures look low.",
        input_schema: { type: "object", properties: {} },
      },
      async run() {
        const f = await portalFreshness(scope);
        return { lastUpdatedAt: f.syncedAt, completeThrough: f.completeThrough };
      },
    },
  ];

  return {
    definitions: tools.map((t) => t.definition),
    label: (name) => tools.find((t) => t.definition.name === name)?.label ?? "Looking something up",
    async run(name, input) {
      const tool = tools.find((t) => t.definition.name === name);
      if (!tool) return { error: `Unknown tool: ${name}` };
      try {
        return await tool.run(input);
      } catch (e) {
        const auth = authFailure(e);
        if (auth) return { error: auth.message };
        // The raw message can name tables and columns; the model would read it out to a customer.
        console.error(`[portal-ai] tool "${name}" failed for brand ${brand.id}`, e);
        return { error: "That data could not be loaded just now. Suggest trying again shortly." };
      }
    },
    visualOf: (_name, result) =>
      typeof result === "object" && result !== null ? (visuals.get(result) ?? null) : null,
  };
}
