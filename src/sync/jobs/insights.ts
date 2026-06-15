import { db, schema } from "@/db/client";
import type { InsightRow, InsightsClient } from "@/meta/types";
import { normalizeInsightRow } from "@/meta/insights";

export type Level = "account" | "campaign" | "adset" | "ad";

const ID_FIELD: Record<Level, keyof InsightRow> = {
  account: "account_id",
  campaign: "campaign_id",
  adset: "adset_id",
  ad: "ad_id",
};

export function trailingRange(days: number, today = new Date()): { since: string; until: string } {
  const until = today.toISOString().slice(0, 10);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { since: start.toISOString().slice(0, 10), until };
}

/** Largest single insights request window. 90 days is the proven-safe size for this
 *  dataset; longer ranges risk Meta's "reduce the amount of data" error at ad level. */
const MAX_CHUNK_DAYS = 90;

/** Split an inclusive [since, until] (YYYY-MM-DD) into consecutive windows of <= maxDays. */
export function chunkRange(
  since: string,
  until: string,
  maxDays = MAX_CHUNK_DAYS,
): { since: string; until: string }[] {
  const windows: { since: string; until: string }[] = [];
  const end = new Date(`${until}T00:00:00Z`);
  let start = new Date(`${since}T00:00:00Z`);
  while (start <= end) {
    const stop = new Date(start);
    stop.setUTCDate(stop.getUTCDate() + (maxDays - 1));
    const clamped = stop < end ? stop : end;
    windows.push({
      since: start.toISOString().slice(0, 10),
      until: clamped.toISOString().slice(0, 10),
    });
    start = new Date(clamped);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return windows;
}

export async function syncInsights(
  client: InsightsClient,
  accountId: string,
  opts: { level: Level; days: number; today?: Date },
): Promise<number> {
  const { since, until } = trailingRange(opts.days, opts.today);
  let written = 0;
  // Long backfills are chunked so each request stays within Meta's per-call data limits.
  for (const window of chunkRange(since, until)) {
    const rows = await client.getInsights(accountId, {
      level: opts.level,
      time_range: { since: window.since, until: window.until },
      time_increment: 1,
      fields: [
        "spend",
        "impressions",
        "reach",
        "clicks",
        "inline_link_clicks",
        "ctr",
        "cpc",
        "cpm",
        "actions",
        "action_values",
        "purchase_roas",
        "account_id",
        "campaign_id",
        "adset_id",
        "ad_id",
      ],
      use_unified_attribution_setting: true,
    });
    for (const r of rows) {
      const entityId =
        opts.level === "account" ? accountId : String(r[ID_FIELD[opts.level]] ?? accountId);
      const v = normalizeInsightRow(r, opts.level, entityId, accountId);
      await db
        .insert(schema.insightsDaily)
        .values(v)
        .onConflictDoUpdate({
          target: [
            schema.insightsDaily.level,
            schema.insightsDaily.entityId,
            schema.insightsDaily.date,
          ],
          set: { ...v, syncedAt: new Date() },
        });
      written++;
    }
  }
  return written;
}
