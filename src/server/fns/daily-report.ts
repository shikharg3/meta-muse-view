import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { accountStatus } from "@/server/agg";
import { disableReasonLabel } from "@/lib/format";
import { addDays, windowFromDates, type DateWindow } from "@/lib/range";
import { objectiveResults } from "./dashboard";
import { loadCampaignOwnership } from "./campaign-attribution";
import type { ReportAccount, ReportCampaign } from "@/lib/daily-report";

/**
 * The window the report covers: yesterday, one day wide.
 *
 * UTC date arithmetic against a `date` column that holds each account's OWN calendar day. That
 * mismatch is the documented convention of this codebase (`src/lib/date-presets.ts`) rather than an
 * oversight: resolving it with the server's local timezone would shift a client's day boundary
 * depending on where the process runs, and would make this report disagree with every dashboard.
 */
export function yesterdayWindow(now: Date): DateWindow {
  const day = addDays(now.toISOString().slice(0, 10), -1);
  return windowFromDates(day, day);
}

/**
 * Every campaign in scope for the report, already attributed to its owning Notion engagement.
 *
 * Reads CAMPAIGN-level insights and attributes them through the one ownership ladder. It must not be
 * rewritten to sum account-level insights per client: ad accounts are shared and recycled, several
 * board rows can claim one `act_` id, and giving each claimant the account's full spend is how this
 * kind of figure has been wrong by orders of magnitude before.
 *
 * `fetchCampaigns()` is deliberately not reused — it loads every ad set, ad count and creative for a
 * page view, and the `status` it returns is a display status derived from `campaigns.status`, not the
 * `effective_status` the membership rule needs.
 */
export async function fetchDailyEngagementRows(w: DateWindow): Promise<{
  campaigns: ReportCampaign[];
  accounts: Map<string, ReportAccount>;
}> {
  const [campaignRows, accountRows, spendRows, results, ownership] = await Promise.all([
    db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        accountId: schema.campaigns.accountId,
        effectiveStatus: schema.campaigns.effectiveStatus,
      })
      .from(schema.campaigns),
    db
      .select({
        id: schema.accounts.id,
        currency: schema.accounts.currency,
        status: schema.accounts.status,
        disableReason: schema.accounts.disableReason,
      })
      .from(schema.accounts),
    // `insights_breakdown_daily` is the same spend split by dimension; summing it here would
    // double-count every campaign that carries any breakdown.
    db
      .select({
        entityId: schema.insightsDaily.entityId,
        spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
      })
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, "campaign"),
          gte(schema.insightsDaily.date, w.since),
          lte(schema.insightsDaily.date, w.until),
        ),
      )
      .groupBy(schema.insightsDaily.entityId),
    objectiveResults(w),
    loadCampaignOwnership(),
  ]);

  const accounts = new Map<string, ReportAccount>(
    accountRows.map((a) => [
      a.id,
      {
        id: a.id,
        currency: a.currency,
        status: accountStatus(a.status),
        disableReason: disableReasonLabel(a.disableReason),
      },
    ]),
  );
  const spendById = new Map(spendRows.map((r) => [r.entityId, Number(r.spend ?? 0)]));

  const campaigns: ReportCampaign[] = campaignRows.map((c) => {
    const ownerId = ownership.ownerOf({ id: c.id, name: c.name, accountId: c.accountId });
    const result = results.campaign.get(c.id);
    return {
      id: c.id,
      accountId: c.accountId,
      clientId: ownerId,
      clientName: ownerId ? ownership.nameOf(ownerId) : null,
      spend: spendById.get(c.id) ?? 0,
      results: result?.value ?? 0,
      resultLabel: result?.label ?? "Results",
      active: c.effectiveStatus === "ACTIVE",
    };
  });

  return { campaigns, accounts };
}
