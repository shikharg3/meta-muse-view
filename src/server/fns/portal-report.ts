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
  defaultCommissionLookup,
  narrowToPortalBrands,
  portalBrandOf,
  portalBrands,
  portalScope,
  type PortalScope,
} from "@/portal/scope";
import { deriveKpis } from "@/server/agg";
import {
  actionCounts,
  delivered,
  deposits,
  registrations,
  scopedDays,
  totals,
  type ScopedDay,
} from "./portal";

/**
 * The client's report builder.
 *
 * The portal's report page used to assemble its rows in the browser and inflate spend there with a
 * commission rate the page held. Both halves of that are wrong: the rate is the agency's margin,
 * and a table a client can export has to agree with the KPI tiles beside it. So the rows are built
 * here, from the same scoped rows, the same markup and the same aggregation the rest of the portal
 * uses (`./portal.ts`), scoped to the signed-in client's grants and with NO markup input — there
 * is no parameter a customer could set, see or infer their own margin through.
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

/** Build the rows for an already-resolved scope, at each campaign's recorded commission. */
async function buildRows(
  scope: PortalScope,
  w: DateWindow,
  req: PortalReportRequest,
): Promise<PortalReport> {
  const range = { since: w.since, until: w.until, days: w.days };

  // The requested campaigns are a FILTER over the resolved scope, never a lookup: an id the caller
  // has no claim to contributes nothing instead of widening anything. Absent or empty = all of it.
  const wanted = new Set(req.campaignIds ?? []);
  const campaignIds =
    wanted.size === 0 ? scope.campaignIds : scope.campaignIds.filter((id) => wanted.has(id));
  if (campaignIds.length === 0) return { rows: [], range };

  // A campaign groups under itself; a whole-brand report groups under its portal brand (the board
  // row it counts under, `portalBrandOf`). Either way the group is resolved through the scope,
  // which is also what supplies the label.
  const groupOf =
    req.breakdown === "campaign"
      ? (campaignId: string): string | undefined =>
          scope.aliasOf.has(campaignId) ? campaignId : undefined
      : (campaignId: string): string | undefined => portalBrandOf(scope, campaignId);

  const labelOf = new Map<string, string>();
  if (req.breakdown === "campaign") {
    for (const id of campaignIds) {
      const alias = scope.aliasOf.get(id);
      if (alias !== undefined) labelOf.set(id, alias);
    }
  } else {
    for (const b of portalBrands(scope)) labelOf.set(b.id, b.name);
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

  const commissions: CommissionTable = await loadCommissions(campaignIds);
  const marked = markupRows(
    days,
    commissions,
    defaultCommissionLookup(scope, PORTAL_DEFAULT_COMMISSION),
  );

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

  // Zero rows exist only for groups the caller NAMED. Asking a report about a specific campaign
  // and getting nothing back reads as a failure rather than as an answer, so its zeroes are the
  // answer; a report nobody filtered is not a question about specific campaigns, and every silent
  // group is dropped below.
  //
  // "Has rows" is NOT the same question as "delivered": Meta writes a zero-valued row for a day a
  // campaign did not run, so 34 of this brand's campaigns open a bucket while 14 actually spent
  // anything. Filtering on the assembled totals is what keeps an exported CSV from listing the
  // abandoned drafts the client's own campaign table already drops.
  //
  // A split report seeds nothing either way: one empty row per silent day is noise, and there is
  // no question a day with no delivery answers.
  const named = wanted.size > 0;
  if (req.granularity === "range" && named) {
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

  const rows: PortalReportRow[] = [...buckets]
    .map(([key, bucket]) => {
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
    })
    .filter(({ metrics }) => named || delivered(metrics, metrics.registrations, metrics.deposits));

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
  const scope = narrowToPortalBrands(await portalScope(currentPortalActor()), req.brandIds);
  return buildRows(scope, w, req);
}
