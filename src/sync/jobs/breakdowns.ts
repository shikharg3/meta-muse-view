import { db, schema } from "@/db/client";
import type { InsightsClient } from "@/meta/types";
import { pickAction, DEFAULT_CONVERSION_TYPE } from "@/meta/insights";
import { trailingRange, chunkRange, type Level } from "./insights";

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);

const ID_FIELD: Record<Level, string | null> = {
  account: null,
  campaign: "campaign_id",
  adset: "adset_id",
  ad: "ad_id",
};

/**
 * Pull breakdown insights for each dimension group at the given level. Every metric lands in `raw`;
 * spend/impressions/reach/clicks/conversions are promoted, and the per-dimension values are stored
 * in `dims` (with a joined breakdown_type/value as the composite key). Each group is isolated: a
 * group Meta rejects at this level (e.g. asset breakdowns above ad level) is skipped, not fatal.
 */
export async function syncBreakdowns(
  client: InsightsClient,
  accountId: string,
  opts: {
    groups: string[][];
    days?: number;
    level?: Level;
    today?: Date;
    since?: string;
    until?: string;
  },
): Promise<number> {
  const level = opts.level ?? "account";
  const idField = ID_FIELD[level];
  const { since, until } =
    opts.since && opts.until
      ? { since: opts.since, until: opts.until }
      : trailingRange(opts.days ?? 28, opts.today);
  const fields = [
    "spend",
    "impressions",
    "reach",
    "clicks",
    "actions",
    "action_values",
    ...(idField ? [idField] : []),
  ];

  let written = 0;
  for (const group of opts.groups) {
    const breakdownType = group.join("|");
    try {
      for (const window of chunkRange(since, until)) {
        const rows = await client.getInsights(accountId, {
          level,
          time_range: { since: window.since, until: window.until },
          time_increment: 1,
          breakdowns: group,
          fields,
          use_unified_attribution_setting: true,
        });
        for (const r of rows) {
          const rec = r as Record<string, unknown>;
          const entityId = idField ? String(rec[idField] ?? accountId) : accountId;
          const dims: Record<string, string> = {};
          for (const dim of group) dims[dim] = String(rec[dim] ?? "unknown");
          const v = {
            level,
            entityId,
            accountId,
            date: r.date_start,
            breakdownType,
            breakdownValue: group.map((d) => dims[d]).join("|"),
            dims,
            spend: n(r.spend),
            impressions: n(r.impressions),
            reach: n(r.reach),
            clicks: n(r.clicks),
            conversions: pickAction(r.actions, DEFAULT_CONVERSION_TYPE),
            conversionValues: pickAction(r.action_values, DEFAULT_CONVERSION_TYPE),
            raw: r,
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
    } catch (e) {
      console.error(
        `[breakdowns] ${level} ${breakdownType} skipped:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return written;
}
