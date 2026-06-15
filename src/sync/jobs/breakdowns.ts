import { db, schema } from "@/db/client";
import type { InsightsClient } from "@/meta/types";
import { pickAction, DEFAULT_CONVERSION_TYPE } from "@/meta/insights";
import { trailingRange, chunkRange } from "./insights";

export const BREAKDOWNS = [
  "age",
  "gender",
  "publisher_platform",
  "device_platform",
  "country",
] as const;
export type BreakdownType = (typeof BREAKDOWNS)[number];

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);

export async function syncBreakdowns(
  client: InsightsClient,
  accountId: string,
  opts: { breakdowns: BreakdownType[]; days: number; level?: "account" | "campaign"; today?: Date },
): Promise<number> {
  const level = opts.level ?? "account";
  const { since, until } = trailingRange(opts.days, opts.today);
  // Campaign-level rows need campaign_id so each row maps back to its campaign.
  const fields =
    level === "campaign"
      ? ["spend", "impressions", "clicks", "actions", "action_values", "campaign_id"]
      : ["spend", "impressions", "clicks", "actions", "action_values"];
  let written = 0;

  for (const breakdown of opts.breakdowns) {
    for (const window of chunkRange(since, until)) {
      const rows = await client.getInsights(accountId, {
        level,
        time_range: { since: window.since, until: window.until },
        time_increment: 1,
        breakdowns: [breakdown],
        fields,
        use_unified_attribution_setting: true,
      });

      for (const r of rows) {
        const rec = r as Record<string, unknown>;
        const entityId = level === "account" ? accountId : String(rec.campaign_id ?? accountId);
        const value = String(rec[breakdown] ?? "unknown");
        const v = {
          level,
          entityId,
          accountId,
          date: r.date_start,
          breakdownType: breakdown,
          breakdownValue: value,
          spend: n(r.spend),
          impressions: n(r.impressions),
          clicks: n(r.clicks),
          conversions: pickAction(r.actions, DEFAULT_CONVERSION_TYPE),
          conversionValues: pickAction(r.action_values, DEFAULT_CONVERSION_TYPE),
        };
        await db
          .insert(schema.insightsBreakdownDaily)
          .values(v)
          .onConflictDoUpdate({
            target: [
              schema.insightsBreakdownDaily.level,
              schema.insightsBreakdownDaily.entityId,
              schema.insightsBreakdownDaily.date,
              schema.insightsBreakdownDaily.breakdownType,
              schema.insightsBreakdownDaily.breakdownValue,
            ],
            set: { ...v, syncedAt: new Date() },
          });
        written++;
      }
    }
  }
  return written;
}
