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
  opts: { breakdowns: BreakdownType[]; days: number; today?: Date },
): Promise<number> {
  const { since, until } = trailingRange(opts.days, opts.today);
  let written = 0;

  for (const breakdown of opts.breakdowns) {
    for (const window of chunkRange(since, until)) {
      const rows = await client.getInsights(accountId, {
        level: "account",
        time_range: { since: window.since, until: window.until },
        time_increment: 1,
        breakdowns: [breakdown],
        fields: ["spend", "impressions", "clicks", "actions", "action_values"],
        use_unified_attribution_setting: true,
      });

      for (const r of rows) {
        const value = String((r as Record<string, unknown>)[breakdown] ?? "unknown");
        const v = {
          level: "account",
          entityId: accountId,
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
