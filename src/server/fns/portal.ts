import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError } from "@/lib/auth/errors";
import type { DateWindow } from "@/lib/range";
import type { KpiDeltas, Kpis } from "@/lib/types";
import { currentPortalActor } from "@/portal/context";
import {
  loadCommissions,
  markupRows,
  totalSpend,
  PORTAL_DEFAULT_COMMISSION,
  type MarkedDayRow,
  type RawDayRow,
} from "@/portal/markup";
import {
  canSeeCampaign,
  defaultCommissionLookup,
  narrowToPortalBrands,
  portalBrandOf,
  portalBrands,
  portalScope,
  type PortalScope,
} from "@/portal/scope";
import { deriveKpis, familyCount, pctDelta, type Totals } from "@/server/agg";
import { canDeliver } from "@/sync/jobs/notion-budget";

/**
 * The client portal's read layer.
 *
 * Every function here resolves its own scope through `@/portal/scope` and queries strictly inside
 * it. Scope resolution lives here rather than in the op handlers on purpose: an op that forgot it
 * would return the whole agency's numbers to one client, and a single entry point per page makes
 * that impossible to forget.
 *
 * Three rules shape all of it:
 *
 * 1. **Campaign-level rows only.** `insights_daily` also holds account-level rows, which are
 *    cheaper to aggregate — and unusable here. An account is shared and recycled between clients,
 *    so an account row can be split neither by ownership nor by commission rate.
 * 2. **Markup before aggregation.** Spend reaches a response only through `markupRows()` →
 *    `totalSpend()`, so every derived cost figure (CPC, CPM, ROAS) is computed from the
 *    client-facing number and cannot disagree with the headline.
 * 3. **Nothing internal is serialised.** No raw spend, no commission rate, no `campaigns.name`, no
 *    account or client id. Campaign names come from `scope.aliasOf`, which only holds aliases an
 *    operator wrote by hand.
 */

const num = (v: unknown): number => Number(v ?? 0);

/**
 * The client's vocabulary for the two events every portal page is built around.
 *
 * Both read canonical event FAMILIES rather than a single action type: Meta reports the same
 * conversion under several near-identical `action_type`s, and a client whose pixel fires the bare
 * `purchase` variant instead of `omni_purchase` would otherwise report zero deposits. A funded
 * account is a purchase event — there is no separate "deposit" action type in the Meta taxonomy.
 */
const REGISTRATION_FAMILY = "Registrations";
const DEPOSIT_FAMILY = "Purchases";

/**
 * A scoped campaign-level day, before markup, carrying the action jsonb the families need.
 *
 * Exported with the handful of helpers below so the report builder (`./portal-report.ts`) reads
 * and aggregates through exactly this code rather than a second implementation of it: two
 * aggregations over the same rows are two chances to disagree about reach, markup or the event
 * families, and a report that contradicts the dashboard it sits next to is worse than no report.
 */
export interface ScopedDay extends RawDayRow {
  actions: unknown;
}

/** What a client is told about a campaign's delivery. Meta's own status words never reach them. */
export type PortalCampaignStatus = "running" | "paused" | "finished" | "scheduled";

/** One of the customer's brands: a Notion board row they may see campaigns under (`portalBrands`). */
export interface PortalBrandCard {
  id: string;
  name: string;
}

export interface PortalFreshness {
  /** When the scoped rows were last written by the sync, ISO instant. */
  syncedAt: string | null;
  /** The latest day the portal has data for — the client's "figures complete through". */
  completeThrough: string | null;
}

export interface PortalBootstrap {
  user: { name: string | null; email: string };
  brands: PortalBrandCard[];
  freshness: PortalFreshness;
}

export interface PortalSeriesPoint {
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  revenue: number;
  registrations: number;
  deposits: number;
}

export interface PortalOverview {
  kpis: Kpis;
  deltas: KpiDeltas;
  series: PortalSeriesPoint[];
}

export interface PortalCampaignRow extends Kpis {
  id: string;
  /** `scope.aliasOf` — the operator-written client-facing name. */
  name: string;
  /** Its brand's `PortalBrandCard.id` (`portalBrandOf`). */
  brandId: string;
  status: PortalCampaignStatus;
  registrations: number;
  deposits: number;
}

export interface PortalAdSetRow {
  id: string;
  name: string;
  status: PortalCampaignStatus;
  /** Fraction of the campaign's spend attributed to this audience (0..1). */
  share: number;
  spend: number;
}

export interface PortalCampaignDetail {
  id: string;
  name: string;
  /** Its brand's `PortalBrandCard.id` (`portalBrandOf`). */
  brandId: string;
  status: PortalCampaignStatus;
  kpis: Kpis;
  deltas: KpiDeltas;
  registrations: number;
  deposits: number;
  series: PortalSeriesPoint[];
  adSets: PortalAdSetRow[];
}

/**
 * The dimensions a client may split by, and the `breakdown_type` each one is stored under.
 *
 * Only what `BREAKDOWN_GROUPS` actually pulls at campaign level is offered, under client-facing
 * keys — the stored types are Meta's own composite strings and are not a UI vocabulary. Four
 * synced groups are deliberately absent:
 *
 * - the `*_asset` groups are requested at ad level only (`sync/cycle.ts`), so no campaign row exists;
 * - `frequency_value` is a histogram bucket, not a segment — a share of spend per frequency band
 *   answers a different question and would read as a nonsense label;
 * - `product_id` is a catalog identifier with no human-readable label;
 * - `hourly_stats_aggregated_by_audience_time_zone` is the same hour dimension in a second framing.
 *   Offering both invites adding them together, which double-counts the whole window.
 */
const DIMENSION_TYPE = {
  age: "age",
  gender: "gender",
  age_gender: "age|gender",
  country: "country",
  region: "region",
  market: "comscore_market",
  platform: "publisher_platform",
  placement: "publisher_platform|platform_position|impression_device",
  device: "device_platform",
  hour: "hourly_stats_aggregated_by_advertiser_time_zone",
} as const;

export type PortalDimension = keyof typeof DIMENSION_TYPE;

/** `z.enum` needs a non-empty tuple; `Object.keys` cannot express that the table has entries. */
export const PORTAL_DIMENSIONS = Object.keys(DIMENSION_TYPE) as [
  PortalDimension,
  ...PortalDimension[],
];

export interface PortalSegment {
  label: string;
  spend: number;
  /** This segment's fraction of the returned segments' spend (0..1). */
  share: number;
  clicks: number;
  conversions: number;
}

// ── scope + rows ───────────────────────────────────────────────────────────────────────────────

/** The calling client's scope, narrowed to the brands the request asked for. */
async function scopeFor(brandIds: string[] | undefined): Promise<PortalScope> {
  const actor = currentPortalActor();
  return narrowToPortalBrands(await portalScope(actor), brandIds);
}

/**
 * The scope's campaign-level rows over an inclusive day range.
 *
 * An empty scope short-circuits to no rows. That is the whole point of the whitelist: dropping the
 * `entity_id` filter for an empty list would read every campaign in the database.
 *
 * The rows are filtered against the scope a SECOND time, in code. That is redundant against the
 * query and deliberately so: a whitelist enforced in exactly one WHERE clause is one careless edit
 * away from folding another client's spend into a total.
 */
export async function scopedDays(
  scope: PortalScope,
  since: string,
  until: string,
  campaignIds = scope.campaignIds,
): Promise<ScopedDay[]> {
  // Mirrors the query's filter, so a row can only survive if it is BOTH requested and attributable
  // to one of the caller's brands — a campaign with no brand has no commission rate either.
  const allowed = new Set(campaignIds.filter((id) => scope.brandOf.has(id)));
  if (allowed.size === 0) return [];
  const rows = await db
    .select({
      campaignId: schema.insightsDaily.entityId,
      date: schema.insightsDaily.date,
      spend: schema.insightsDaily.spend,
      impressions: schema.insightsDaily.impressions,
      reach: schema.insightsDaily.reach,
      clicks: schema.insightsDaily.clicks,
      conversions: schema.insightsDaily.conversions,
      conversionValues: schema.insightsDaily.conversionValues,
      actions: schema.insightsDaily.actions,
    })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.level, "campaign"),
        inArray(schema.insightsDaily.entityId, campaignIds),
        gte(schema.insightsDaily.date, since),
        lte(schema.insightsDaily.date, until),
      ),
    );
  return rows
    .filter((r) => allowed.has(r.campaignId))
    .map((r) => ({
      campaignId: r.campaignId,
      date: r.date,
      spend: num(r.spend),
      impressions: num(r.impressions),
      reach: num(r.reach),
      clicks: num(r.clicks),
      conversions: num(r.conversions),
      conversionValues: num(r.conversionValues),
      actions: r.actions,
    }));
}

/**
 * Scoped rows for a window, with the commission folded into every row's spend.
 *
 * The pre-markup array is returned alongside because the action jsonb rides on it and is untouched
 * by the markup. Reading the events from it — rather than threading them through `markupRows` —
 * keeps "has this row been marked up?" answerable from its type.
 */
async function readWindow(
  scope: PortalScope,
  since: string,
  until: string,
  campaignIds = scope.campaignIds,
): Promise<{ days: ScopedDay[]; marked: MarkedDayRow[] }> {
  const [days, commissions] = await Promise.all([
    scopedDays(scope, since, until, campaignIds),
    loadCommissions(scope.campaignIds),
  ]);
  return {
    days,
    marked: markupRows(
      days,
      commissions,
      defaultCommissionLookup(scope, PORTAL_DEFAULT_COMMISSION),
    ),
  };
}

/** `action_type` → summed count, bucketed by `key` — the input `familyCount` expects. */
export function actionCounts<K>(
  rows: ScopedDay[],
  key: (row: ScopedDay) => K,
): Map<K, Map<string, number>> {
  const out = new Map<K, Map<string, number>>();
  for (const row of rows) {
    // `actions` is jsonb: Meta's action array exactly as ingested, read the same way
    // `canonicalEvents` reads it. A null column is a day that recorded no events at all.
    const list = (row.actions as { action_type: string; value: string }[] | null) ?? [];
    if (list.length === 0) continue;
    const k = key(row);
    let sums = out.get(k);
    if (!sums) {
      sums = new Map<string, number>();
      out.set(k, sums);
    }
    for (const a of list) sums.set(a.action_type, (sums.get(a.action_type) ?? 0) + num(a.value));
  }
  return out;
}

const EMPTY_SUMS = new Map<string, number>();

export const registrations = (sums: Map<string, number> | undefined): number =>
  familyCount(sums ?? EMPTY_SUMS, REGISTRATION_FAMILY);
export const deposits = (sums: Map<string, number> | undefined): number =>
  familyCount(sums ?? EMPTY_SUMS, DEPOSIT_FAMILY);

/**
 * Window totals for already-marked-up rows.
 *
 * Reach is the sum of each campaign's largest single day, not the sum of the column. Daily reach is
 * de-duplicated within a row, so the same person reached on Monday and Tuesday is one person —
 * adding the days produces a figure that is not a number of people at all. This is the convention
 * the internal dashboard's KPI tiles use, so the two surfaces report the same quantity.
 */
export function totals(rows: MarkedDayRow[]): Totals {
  const peak = new Map<string, number>();
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  let revenue = 0;
  for (const r of rows) {
    impressions += r.impressions;
    clicks += r.clicks;
    conversions += r.conversions;
    revenue += r.conversionValues;
    const best = peak.get(r.campaignId);
    if (best === undefined || r.reach > best) peak.set(r.campaignId, r.reach);
  }
  let reach = 0;
  for (const p of peak.values()) reach += p;
  // Through `totalSpend` so the marked-up figure is the only spend that can reach a response.
  return { spend: totalSpend(rows), impressions, clicks, conversions, revenue, reach };
}

function deltasOf(cur: Kpis, prev: Kpis): KpiDeltas {
  return {
    spend: pctDelta(cur.spend, prev.spend),
    revenue: pctDelta(cur.revenue, prev.revenue),
    roas: pctDelta(cur.roas, prev.roas),
    ctr: pctDelta(cur.ctr, prev.ctr),
    conversions: pctDelta(cur.conversions, prev.conversions),
    impressions: pctDelta(cur.impressions, prev.impressions),
    cpc: pctDelta(cur.cpc, prev.cpc),
    cpm: pctDelta(cur.cpm, prev.cpm),
    reach: pctDelta(cur.reach, prev.reach),
  };
}

/** One point per day that has rows, summed across the scoped campaigns. */
function seriesOf(marked: MarkedDayRow[], events: Map<string, Map<string, number>>) {
  const byDate = new Map<string, PortalSeriesPoint>();
  for (const r of marked) {
    let point = byDate.get(r.date);
    if (!point) {
      point = {
        date: r.date,
        spend: 0,
        impressions: 0,
        reach: 0,
        clicks: 0,
        conversions: 0,
        revenue: 0,
        registrations: registrations(events.get(r.date)),
        deposits: deposits(events.get(r.date)),
      };
      byDate.set(r.date, point);
    }
    point.spend += r.spend;
    point.impressions += r.impressions;
    // Within one day reach is additive across campaigns in the same sense the internal trend chart
    // treats it; it is the cross-day sum that would be meaningless.
    point.reach += r.reach;
    point.clicks += r.clicks;
    point.conversions += r.conversions;
    point.revenue += r.conversionValues;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── delivery status ────────────────────────────────────────────────────────────────────────────

interface DeliveryFacts {
  effectiveStatus: string | null;
  startTime: Date | null;
  endTime: Date | null;
  /** Its ad account can still spend today — see `canDeliver`. */
  deliverable: boolean;
}

/**
 * Meta's `effective_status` in the client's words.
 *
 * `effective_status = ACTIVE` does NOT mean a campaign can spend: Meta stops delivery at the
 * ACCOUNT level when an account is disabled or its prepaid cap is exhausted and leaves every
 * campaign underneath reporting ACTIVE. Reporting that as "running" to the client whose money is
 * not being spent is the worst version of this bug, so an undeliverable account reads "paused".
 */
function clientStatus(f: DeliveryFacts, now: Date): PortalCampaignStatus {
  const s = (f.effectiveStatus ?? "").toUpperCase();
  if (s === "DELETED" || s === "ARCHIVED") return "finished";
  if (f.endTime && f.endTime.getTime() < now.getTime()) return "finished";
  if (s !== "ACTIVE") return "paused";
  if (f.startTime && f.startTime.getTime() > now.getTime()) return "scheduled";
  return f.deliverable ? "running" : "paused";
}

interface CampaignFacts {
  status: PortalCampaignStatus;
}

/**
 * Delivery facts per scoped campaign.
 *
 * A campaign whose account row has not synced counts as NOT deliverable: `accountStatus(null)`
 * optimistically returns ACTIVE and `canDeliver` treats a null cap as uncapped, so the defaults
 * would assert delivery for an account we know nothing about.
 */
async function campaignFacts(
  scope: PortalScope,
  now: Date,
  campaignIds = scope.campaignIds,
): Promise<Map<string, CampaignFacts>> {
  const out = new Map<string, CampaignFacts>();
  if (campaignIds.length === 0) return out;

  const rows = await db
    .select({
      id: schema.campaigns.id,
      accountId: schema.campaigns.accountId,
      effectiveStatus: schema.campaigns.effectiveStatus,
      startTime: schema.campaigns.startTime,
      stopTime: schema.campaigns.stopTime,
    })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.id, campaignIds));

  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const accountRows =
    accountIds.length === 0
      ? []
      : await db
          .select({
            id: schema.accounts.id,
            status: schema.accounts.status,
            spendCap: schema.accounts.spendCap,
            amountSpent: schema.accounts.amountSpent,
          })
          .from(schema.accounts)
          .where(inArray(schema.accounts.id, accountIds));
  const deliverable = new Set(accountRows.filter((a) => canDeliver(a)).map((a) => a.id));

  for (const r of rows) {
    out.set(r.id, {
      status: clientStatus(
        {
          effectiveStatus: r.effectiveStatus,
          startTime: r.startTime,
          endTime: r.stopTime,
          deliverable: deliverable.has(r.accountId),
        },
        now,
      ),
    });
  }
  return out;
}

// ── ops data ──────────────────────────────────────────────────────────────────────────────────

/**
 * What the portal shell needs before it can render anything: who is signed in, which brands they
 * may switch between, and how fresh the figures are.
 *
 * The brands are the board rows their campaigns count under (`portalBrands`), each projected to an
 * id and a name — `ScopedBrand` and `ScopedProject` also carry ad accounts, commission and the
 * owner, none of which a client may ever see.
 */
export async function fetchPortalBootstrap(): Promise<PortalBootstrap> {
  const scope = await scopeFor(undefined);
  const brands: PortalBrandCard[] = portalBrands(scope);

  const freshness: PortalFreshness = { syncedAt: null, completeThrough: null };
  if (scope.campaignIds.length > 0) {
    const [row] = await db
      .select({
        syncedAt: sql<string | Date | null>`max(${schema.insightsDaily.syncedAt})`,
        // ::text because the driver would otherwise hand back a Date for a DATE column and the
        // local-time render of it can land a day out.
        completeThrough: sql<string | null>`max(${schema.insightsDaily.date})::text`,
      })
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, "campaign"),
          inArray(schema.insightsDaily.entityId, scope.campaignIds),
        ),
      );
    const synced = row?.syncedAt ? new Date(row.syncedAt) : null;
    freshness.syncedAt = synced && !Number.isNaN(synced.getTime()) ? synced.toISOString() : null;
    freshness.completeThrough = row?.completeThrough ?? null;
  }

  return {
    user: { name: scope.actor.name, email: scope.actor.email },
    brands,
    freshness,
  };
}

/** Headline KPIs, their period-over-period movement and the daily series. */
export async function fetchPortalOverview(
  w: DateWindow,
  brandIds: string[] | undefined,
): Promise<PortalOverview> {
  const scope = await scopeFor(brandIds);
  // One read covers both windows: the previous period is [prevSince, since), the same convention
  // the internal dashboard's deltas use.
  const { days, marked } = await readWindow(scope, w.prevSince, w.until);
  const current = marked.filter((r) => r.date >= w.since);
  const previous = marked.filter((r) => r.date < w.since);

  const kpis = deriveKpis(totals(current));
  const events = actionCounts(
    days.filter((d) => d.date >= w.since),
    (d) => d.date,
  );

  return {
    kpis,
    deltas: deltasOf(kpis, deriveKpis(totals(previous))),
    series: seriesOf(current, events),
  };
}

/**
 * Whether a campaign delivered anything at all in the window.
 *
 * Meta keeps every campaign ever created on an account, so a client's list is mostly history:
 * 28 of betonline.ag's 34 in-scope campaigns are abandoned drafts and duplicates that have never
 * spent a penny. Listing them is not transparency, it is noise — Ads Manager itself defaults to
 * hiding campaigns with no delivery in the selected range, so this matches the tool the numbers
 * come from.
 *
 * EVERY metric is checked, not just spend and impressions. That is the point: this can then never
 * drop a row that contributed to a total the client is also shown, so the campaign table's column
 * sums stay equal to the overview's. A campaign that somehow recorded a registration without an
 * impression stays on the list rather than quietly vanishing from a figure that still counts it.
 */
export const delivered = (t: Totals, regs: number, deps: number): boolean =>
  t.spend !== 0 ||
  t.impressions !== 0 ||
  t.clicks !== 0 ||
  t.reach !== 0 ||
  t.conversions !== 0 ||
  t.revenue !== 0 ||
  regs !== 0 ||
  deps !== 0;

/**
 * One row per campaign that delivered in the window.
 *
 * A campaign that did nothing in the window is left out — see `delivered()`. Its detail page is
 * still reachable and still answers, because the id is checked against the scope rather than
 * against this list: a client following an old link gets their campaign, not a 403.
 */
export async function fetchPortalCampaigns(
  w: DateWindow,
  brandIds: string[] | undefined,
  now = new Date(),
): Promise<PortalCampaignRow[]> {
  const scope = await scopeFor(brandIds);
  const [{ days, marked }, facts] = await Promise.all([
    readWindow(scope, w.since, w.until),
    campaignFacts(scope, now),
  ]);

  const byCampaign = new Map<string, MarkedDayRow[]>();
  for (const r of marked) {
    const list = byCampaign.get(r.campaignId);
    if (list) list.push(r);
    else byCampaign.set(r.campaignId, [r]);
  }
  const events = actionCounts(days, (d) => d.campaignId);

  const rows: PortalCampaignRow[] = [];
  for (const id of scope.campaignIds) {
    const alias = scope.aliasOf.get(id);
    const brandId = portalBrandOf(scope, id);
    // Both are set for every id the scope returns; skipping rather than substituting a fallback
    // keeps an internal name from ever standing in for a missing alias.
    if (alias === undefined || brandId === undefined) continue;
    const sums = events.get(id);
    const t = totals(byCampaign.get(id) ?? []);
    const regs = registrations(sums);
    const deps = deposits(sums);
    if (!delivered(t, regs, deps)) continue;
    rows.push({
      id,
      name: alias,
      brandId,
      status: facts.get(id)?.status ?? "paused",
      ...deriveKpis(t),
      registrations: regs,
      deposits: deps,
    });
  }
  return rows.sort((a, b) => b.spend - a.spend);
}

/**
 * Split a campaign's marked-up spend across its audiences.
 *
 * The portal reads campaign-level rows only, so there is no per-ad-set delivery figure to divide:
 * the weights are the ad sets' own budgets, which is what the campaign's spend is actually allocated
 * by. A campaign holding its budget centrally (CBO) leaves every ad set at zero, so an equal split
 * is the fallback. Deleted and archived ad sets are left out entirely rather than diluting the
 * shares of the audiences still running.
 */
async function adSetRows(
  campaignId: string,
  spend: number,
  now: Date,
  deliverable: boolean,
): Promise<PortalAdSetRow[]> {
  const rows = await db
    .select({
      id: schema.adSets.id,
      name: schema.adSets.name,
      effectiveStatus: schema.adSets.effectiveStatus,
      startTime: schema.adSets.startTime,
      endTime: schema.adSets.endTime,
      dailyBudget: schema.adSets.dailyBudget,
      lifetimeBudget: schema.adSets.lifetimeBudget,
    })
    .from(schema.adSets)
    .where(eq(schema.adSets.campaignId, campaignId));

  const live = rows.filter((r) => {
    const s = (r.effectiveStatus ?? "").toUpperCase();
    return s !== "DELETED" && s !== "ARCHIVED";
  });
  if (live.length === 0) return [];

  // Daily and lifetime budgets are not the same unit, but Meta sets one or the other per campaign,
  // so within a campaign the weights are comparable.
  const weights = live.map((r) => num(r.dailyBudget) || num(r.lifetimeBudget));
  const total = weights.reduce((sum, wgt) => sum + wgt, 0);

  return live.map((r, i) => {
    const share = total > 0 ? weights[i] / total : 1 / live.length;
    return {
      id: r.id,
      name: r.name,
      status: clientStatus(
        {
          effectiveStatus: r.effectiveStatus,
          startTime: r.startTime,
          endTime: r.endTime,
          deliverable,
        },
        now,
      ),
      share,
      spend: spend * share,
    };
  });
}

/**
 * One campaign in detail.
 *
 * The id is checked against the scope before anything is read. It is a filter over what the caller
 * already has, never a lookup: a campaign the caller was not granted is refused outright rather
 * than answered with empty figures, because an empty answer is itself information about a campaign
 * belonging to somebody else.
 */
export async function fetchPortalCampaign(
  id: string,
  w: DateWindow,
  now = new Date(),
): Promise<PortalCampaignDetail> {
  const scope = await scopeFor(undefined);
  if (!canSeeCampaign(scope, id)) {
    throw new ForbiddenError("You don't have access to this campaign.");
  }
  const alias = scope.aliasOf.get(id) ?? "";
  const brandId = portalBrandOf(scope, id) ?? "";

  const only = [id];
  const [{ days, marked }, facts] = await Promise.all([
    readWindow(scope, w.prevSince, w.until, only),
    campaignFacts(scope, now, only),
  ]);
  const current = marked.filter((r) => r.date >= w.since);
  const currentDays = days.filter((d) => d.date >= w.since);

  const kpis = deriveKpis(totals(current));
  const windowSums = actionCounts(currentDays, (d) => d.campaignId).get(id);
  const status = facts.get(id)?.status ?? "paused";

  return {
    id,
    name: alias,
    brandId,
    status,
    kpis,
    deltas: deltasOf(kpis, deriveKpis(totals(marked.filter((r) => r.date < w.since)))),
    registrations: registrations(windowSums),
    deposits: deposits(windowSums),
    series: seriesOf(
      current,
      actionCounts(currentDays, (d) => d.date),
    ),
    adSets: await adSetRows(id, kpis.spend, now, status === "running"),
  };
}

/**
 * One dimension's segments, largest spend first.
 *
 * `insights_breakdown_daily` rows are keyed by `entity_id`, so a scoped read is the same whitelist
 * the daily rows use, applied in the query and again in code: a row that cannot be attributed to a
 * scoped campaign is dropped rather than folded into a segment at the fallback commission. The
 * markup is applied per segment before the segment total exists, which is why the rows are grouped
 * by label first — `markupRows` needs the campaign and the date, and a summed segment has neither.
 */
export async function fetchPortalBreakdowns(
  w: DateWindow,
  brandIds: string[] | undefined,
  dimension: PortalDimension,
): Promise<PortalSegment[]> {
  const scope = await scopeFor(brandIds);
  if (scope.campaignIds.length === 0) return [];

  const rows = await db
    .select({
      campaignId: schema.insightsBreakdownDaily.entityId,
      date: schema.insightsBreakdownDaily.date,
      value: schema.insightsBreakdownDaily.breakdownValue,
      spend: schema.insightsBreakdownDaily.spend,
      impressions: schema.insightsBreakdownDaily.impressions,
      reach: schema.insightsBreakdownDaily.reach,
      clicks: schema.insightsBreakdownDaily.clicks,
      conversions: schema.insightsBreakdownDaily.conversions,
      conversionValues: schema.insightsBreakdownDaily.conversionValues,
    })
    .from(schema.insightsBreakdownDaily)
    .where(
      and(
        eq(schema.insightsBreakdownDaily.level, "campaign"),
        eq(schema.insightsBreakdownDaily.breakdownType, DIMENSION_TYPE[dimension]),
        inArray(schema.insightsBreakdownDaily.entityId, scope.campaignIds),
        gte(schema.insightsBreakdownDaily.date, w.since),
        lte(schema.insightsBreakdownDaily.date, w.until),
      ),
    );

  const commissions = await loadCommissions(scope.campaignIds);
  const defaultFor = defaultCommissionLookup(scope, PORTAL_DEFAULT_COMMISSION);

  const byLabel = new Map<string, RawDayRow[]>();
  for (const r of rows) {
    if (!scope.brandOf.has(r.campaignId)) continue;
    // A composite dimension stores its parts pipe-joined; " · " is how the internal dashboard
    // renders the same value.
    const label = r.value.includes("|") ? r.value.replace(/\|/g, " · ") : r.value;
    const list = byLabel.get(label);
    const row: RawDayRow = {
      campaignId: r.campaignId,
      date: r.date,
      spend: num(r.spend),
      impressions: num(r.impressions),
      reach: num(r.reach),
      clicks: num(r.clicks),
      conversions: num(r.conversions),
      conversionValues: num(r.conversionValues),
    };
    if (list) list.push(row);
    else byLabel.set(label, [row]);
  }

  const segments: Omit<PortalSegment, "share">[] = [];
  let grand = 0;
  for (const [label, group] of byLabel) {
    const spend = totalSpend(markupRows(group, commissions, defaultFor));
    grand += spend;
    segments.push({
      label,
      spend,
      clicks: group.reduce((sum, r) => sum + r.clicks, 0),
      conversions: group.reduce((sum, r) => sum + r.conversions, 0),
    });
  }

  return segments
    .map((s) => ({ ...s, share: grand > 0 ? s.spend / grand : 0 }))
    .sort((a, b) => b.spend - a.spend);
}
