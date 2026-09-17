import { type DateWindow } from "@/lib/range";
import { bucketFor, bucketLabel, type TimeIncrement } from "@/lib/time-increment";
import type { Kpis } from "@/lib/types";
import { currentPortalActor } from "@/portal/context";
import {
  loadCommissions,
  markupRows,
  PORTAL_DEFAULT_COMMISSION,
  type CommissionTable,
  type MarkedDayRow,
} from "@/portal/markup";
import {
  agencyBrandScope,
  defaultCommissionLookup,
  narrowToBrands,
  portalScope,
  type PortalActor,
  type PortalScope,
} from "@/portal/scope";
import { deriveKpis } from "@/server/agg";
import { requireAdmin } from "./auth";
import {
  actionCounts,
  deposits,
  registrations,
  scopedDays,
  totals,
  type ScopedDay,
} from "./portal";

/**
 * The report builder, for both audiences.
 *
 * The portal's report page used to assemble its rows in the browser and inflate spend there with a
 * commission rate the page held. Both halves of that are wrong: the rate is the agency's margin,
 * and a table a client can export has to agree with the KPI tiles beside it. So the rows are built
 * here, from the same scoped rows, the same markup and the same aggregation the rest of the portal
 * uses (`./portal.ts`) — the only difference between the two audiences is how the scope is obtained:
 *
 * - `fetchPortalReport` scopes to the signed-in client's grants, and takes NO markup input. There
 *   is no parameter a customer could set, see or infer their own margin through.
 * - `buildAgencyReport` scopes to whatever brands a member of staff asked for, and accepts a
 *   markup override so the internal report card can quote a different rate.
 *
 * Everything past scope resolution is `buildRows`, once.
 */

export type PortalReportBreakdown = "total" | "campaign";
export type PortalReportGranularity = "range" | "day" | "week";

/** The client-facing metric set: the shared KPIs plus the portal's two headline events. */
export interface PortalReportMetrics extends Kpis {
  registrations: number;
  deposits: number;
}

export interface PortalReportRow {
  /** A brand name or a campaign's client-facing alias — never an internal id or Meta name. */
  label: string;
  /** null for a whole-range report, the date for `day`, `<from> → <to>` for `week`. */
  period: string | null;
  metrics: PortalReportMetrics;
}

export interface PortalReport {
  rows: PortalReportRow[];
  range: { since: string; until: string; days: number };
}

export interface PortalReportRequest {
  brandIds?: string[];
  campaignIds?: string[];
  breakdown: PortalReportBreakdown;
  granularity: PortalReportGranularity;
}

/** The granularity in the units `bucketFor` already speaks — Meta's `time_increment`. */
const INCREMENT: Record<PortalReportGranularity, TimeIncrement> = {
  range: "all_days",
  day: "1",
  week: "7",
};

/** NUL joins the key parts: neither a brand id nor a bucket label can contain it. */
const keyOf = (group: string, period: string | null): string => `${group}\u0000${period ?? ""}`;

interface Bucket {
  label: string;
  period: string | null;
  rows: MarkedDayRow[];
}

/**
 * Build the rows for an already-resolved scope.
 *
 * `markupOverride` replaces every campaign's own rate when it is a number (a percentage, the same
 * unit the commission table stores); `null` means "use each campaign's recorded rate", which is
 * the only thing the client-facing op ever passes. The override is applied by handing `markupRows`
 * an empty rate history rather than by adjusting spend afterwards, so there is exactly one place
 * where spend becomes client-facing and it cannot be applied twice.
 */
async function buildRows(
  scope: PortalScope,
  w: DateWindow,
  req: PortalReportRequest,
  markupOverride: number | null,
): Promise<PortalReport> {
  const range = { since: w.since, until: w.until, days: w.days };

  // The requested campaigns are a FILTER over the resolved scope, never a lookup: an id the caller
  // has no claim to contributes nothing instead of widening anything. Absent or empty = all of it.
  const wanted = new Set(req.campaignIds ?? []);
  const campaignIds =
    wanted.size === 0 ? scope.campaignIds : scope.campaignIds.filter((id) => wanted.has(id));
  if (campaignIds.length === 0) return { rows: [], range };

  // A campaign groups under itself; a whole-brand report groups under its brand. Either way the
  // group is resolved through the scope, which is also what supplies the label.
  const groupOf =
    req.breakdown === "campaign"
      ? (campaignId: string): string | undefined =>
          scope.aliasOf.has(campaignId) ? campaignId : undefined
      : (campaignId: string): string | undefined => scope.brandOf.get(campaignId);

  const labelOf = new Map<string, string>();
  if (req.breakdown === "campaign") {
    for (const id of campaignIds) {
      const alias = scope.aliasOf.get(id);
      if (alias !== undefined) labelOf.set(id, alias);
    }
  } else {
    for (const b of scope.brands) labelOf.set(b.id, b.name);
  }

  const periodOf = (date: string): string | null =>
    req.granularity === "range"
      ? null
      : bucketLabel(bucketFor(date, w.since, w.until, INCREMENT[req.granularity]));

  /** A row's bucket, or undefined when its group has no label — which the scope should prevent. */
  const bucketKey = (row: { campaignId: string; date: string }): string | undefined => {
    const group = groupOf(row.campaignId);
    if (group === undefined || !labelOf.has(group)) return undefined;
    return keyOf(group, periodOf(row.date));
  };

  const days = (await scopedDays(scope, w.since, w.until, campaignIds)).filter(
    (d) => bucketKey(d) !== undefined,
  );

  const commissions: CommissionTable =
    markupOverride === null ? await loadCommissions(campaignIds) : new Map();
  const defaultFor =
    markupOverride === null
      ? defaultCommissionLookup(scope, PORTAL_DEFAULT_COMMISSION)
      : () => markupOverride;
  const marked = markupRows(days, commissions, defaultFor);

  const buckets = new Map<string, Bucket>();
  /**
   * The bucket for a group and period, created on first use — seeding one is how a selected group
   * with no delivery still reports its zeroes.
   *
   * Undefined when the group has no label. There is deliberately no fallback: a brand id or a
   * campaign id in the label column would leak the internal naming this whole surface exists to
   * keep out of a client's hands, and these rows end up in an exported CSV.
   */
  const bucketAt = (group: string, period: string | null): Bucket | undefined => {
    const label = labelOf.get(group);
    if (label === undefined) return undefined;
    const key = keyOf(group, period);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { label, period, rows: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  // A whole-range report answers "what did this cost me", so every group the caller selected earns
  // a row even at zero — its absence would read as a missing campaign rather than a quiet one. A
  // split report does not: one empty row per silent day is noise, and there is no question a day
  // with no delivery answers.
  if (req.granularity === "range") {
    for (const id of campaignIds) {
      const group = groupOf(id);
      if (group !== undefined) bucketAt(group, null);
    }
  }

  for (const row of marked) {
    const group = groupOf(row.campaignId);
    if (group === undefined) continue;
    bucketAt(group, periodOf(row.date))?.rows.push(row);
  }

  // Events come off the pre-markup rows, which still carry the action jsonb, bucketed by the same
  // key — so a period's registrations and its spend are always the same set of days.
  const events = actionCounts(days, (d: ScopedDay) => bucketKey(d) ?? "");

  const rows: PortalReportRow[] = [...buckets].map(([key, bucket]) => {
    const sums = events.get(key);
    return {
      label: bucket.label,
      period: bucket.period,
      metrics: {
        ...deriveKpis(totals(bucket.rows)),
        registrations: registrations(sums),
        deposits: deposits(sums),
      },
    };
  });

  // Chronological first — a split report is read down the time axis — then the biggest spender
  // within each period, which is the order the campaign table uses.
  rows.sort(
    (a, b) =>
      (a.period ?? "").localeCompare(b.period ?? "") ||
      b.metrics.spend - a.metrics.spend ||
      a.label.localeCompare(b.label),
  );

  return { rows, range };
}

/** The signed-in client's own report, over their own brands, at their own commission rates. */
export async function fetchPortalReport(
  w: DateWindow,
  req: PortalReportRequest,
): Promise<PortalReport> {
  const scope = narrowToBrands(await portalScope(currentPortalActor()), req.brandIds);
  return buildRows(scope, w, req, null);
}

/**
 * A scope is defined relative to somebody, and a member of staff is not a portal user — there is
 * no `portal_users` row to resolve. The synthetic actor exists only to satisfy that field: it is
 * never serialised, never touched, and grants nothing on its own (`agencyBrandScope` takes the
 * brands directly, and `requireAdmin()` is what authorised the call).
 */
const staffActor = (user: { id: string; email: string; name: string | null }): PortalActor => ({
  id: `staff:${user.id}`,
  email: user.email,
  name: user.name,
  status: "approved",
});

/**
 * The same report for the agency's own screens: any brand, and optionally a quoted rate other than
 * the one on file. Admin-only, and the alias gate still applies — the point of the internal copy is
 * to see exactly what the client sees.
 */
export async function buildAgencyReport(
  w: DateWindow,
  req: PortalReportRequest & { markupOverride?: number | null },
): Promise<PortalReport> {
  const me = await requireAdmin();
  const scope = await agencyBrandScope(staffActor(me), req.brandIds);
  return buildRows(scope, w, req, req.markupOverride ?? null);
}

/** One selectable campaign for the internal builder's filter, in the client's vocabulary. */
export interface AgencyReportCampaign {
  id: string;
  /** The client-facing alias. A campaign without one is not in scope at all. */
  name: string;
  brandId: string;
  brandName: string;
}

/**
 * The campaigns the internal builder may filter by.
 *
 * Staff cannot populate that picker from `portalCampaigns`: that op is scoped to the caller's
 * grants, and a member of staff has none. Resolved through the same `agencyBrandScope`, so the
 * picker can only ever offer campaigns a report would actually return rows for.
 *
 * Names come from `scope.aliasOf` and `scope.brands`, and a campaign or brand with no name there
 * is skipped rather than labelled with its id. `campaigns.name` is never consulted: these labels
 * are what the exported report says, so a staff surface is no safer a place to leak the internal
 * naming convention than a client one.
 */
export async function fetchAgencyReportCampaigns(
  brandIds: string[] | undefined,
): Promise<AgencyReportCampaign[]> {
  const me = await requireAdmin();
  const scope = await agencyBrandScope(staffActor(me), brandIds);
  const brandName = new Map(scope.brands.map((b) => [b.id, b.name]));
  const rows: AgencyReportCampaign[] = [];
  for (const id of scope.campaignIds) {
    const brandId = scope.brandOf.get(id);
    const name = scope.aliasOf.get(id);
    const brand = brandId === undefined ? undefined : brandName.get(brandId);
    if (brandId === undefined || name === undefined || brand === undefined) continue;
    rows.push({ id, name, brandId, brandName: brand });
  }
  return rows.sort(
    (a, b) => a.brandName.localeCompare(b.brandName) || a.name.localeCompare(b.name),
  );
}
