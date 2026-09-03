import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { accountStatus } from "@/server/agg";
import { disableReasonLabel } from "@/lib/format";
import { addDays, windowFromDates, type DateWindow } from "@/lib/range";
import { objectiveResults } from "./dashboard";
import { canDeliver } from "@/sync/jobs/notion-budget";
import { loadCampaignOwnership } from "./campaign-attribution";
import { TRAILING_DAYS } from "@/lib/daily-report";
import type { EngagementContext, ReportAccount, ReportCampaign } from "@/lib/daily-report";

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
 * The window the membership rule reads: `TRAILING_DAYS` complete days ending yesterday.
 *
 * Ends yesterday, not today: today is partial, so including it would let a client that started
 * spending an hour ago look like an established engagement, and would make the same report answer
 * differently depending on the hour it ran.
 */
export function trailingWindow(now: Date): DateWindow {
  const until = addDays(now.toISOString().slice(0, 10), -1);
  return windowFromDates(addDays(until, -(TRAILING_DAYS - 1)), until);
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
export async function fetchDailyEngagementRows(
  w: DateWindow,
  trailing: DateWindow,
): Promise<{
  campaigns: ReportCampaign[];
  accounts: Map<string, ReportAccount>;
  context: EngagementContext;
}> {
  const [campaignRows, accountRows, spendRows, trailingRows, clientRows, results, ownership] =
    await Promise.all([
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
          spendCap: schema.accounts.spendCap,
          amountSpent: schema.accounts.amountSpent,
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
      // Trailing spend for the membership rule. A SECOND grouped query rather than a wider window on
      // the first: the report must still display yesterday alone.
      db
        .select({
          entityId: schema.insightsDaily.entityId,
          spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
        })
        .from(schema.insightsDaily)
        .where(
          and(
            eq(schema.insightsDaily.level, "campaign"),
            gte(schema.insightsDaily.date, trailing.since),
            lte(schema.insightsDaily.date, trailing.until),
          ),
        )
        .groupBy(schema.insightsDaily.entityId),
      db.select({ id: schema.clients.id, status: schema.clients.status }).from(schema.clients),
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
        // The canonical delivery test, not a status comparison: an exhausted prepaid cap stops
        // delivery while the account keeps reporting ACTIVE.
        deliverable: canDeliver({
          status: a.status,
          spendCap: a.spendCap,
          amountSpent: a.amountSpent,
        }),
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

  // Trailing spend attributed through the SAME ownership ladder as yesterday's, so the membership
  // test and the displayed figure agree about who owns what.
  const trailingSpendByCampaign = new Map(
    trailingRows.map((r) => [r.entityId, Number(r.spend ?? 0)]),
  );
  const trailingSpend = new Map<string, number>();
  for (const c of campaignRows) {
    const ownerId = ownership.ownerOf({ id: c.id, name: c.name, accountId: c.accountId });
    if (!ownerId) continue;
    const spend = trailingSpendByCampaign.get(c.id) ?? 0;
    if (spend === 0) continue;
    trailingSpend.set(ownerId, (trailingSpend.get(ownerId) ?? 0) + spend);
  }
  const notionStatus = new Map<string, string | null>(clientRows.map((c) => [c.id, c.status]));

  return { campaigns, accounts, context: { trailingSpend, notionStatus } };
}
