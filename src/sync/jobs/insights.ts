import { db, schema } from "@/db/client";
import type { InsightRow, InsightsClient } from "@/meta/types";
import { normalizeInsightRow } from "@/meta/insights";
import { INSIGHT_METRIC_GROUPS, ATTRIBUTION_WINDOWS } from "@/meta/fieldsets";

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

/** Sync insights over an explicit [since, until] window (chunked), merging all metric groups. */
export async function syncInsightsRange(
  client: InsightsClient,
  accountId: string,
  level: Level,
  since: string,
  until: string,
  attributionWindows = false,
): Promise<number> {
  let written = 0;
  // Long ranges are chunked so each request stays within Meta's per-call data limits.
  for (const window of chunkRange(since, until)) {
    // Request every metric in compatible groups, merged by (entity, date) so each daily row carries
    // the full metric set. The merged row is stored in `raw`; high-value metrics are promoted.
    const byKey = new Map<string, InsightRow>();
    for (const group of INSIGHT_METRIC_GROUPS) {
      const rows = await client.getInsights(accountId, {
        level,
        time_range: { since: window.since, until: window.until },
        time_increment: 1,
        fields: [...group, "account_id", "campaign_id", "adset_id", "ad_id"],
        use_unified_attribution_setting: true,
      });
      for (const r of rows) {
        const entityId = level === "account" ? accountId : String(r[ID_FIELD[level]] ?? accountId);
        const key = `${entityId}:${String(r.date_start)}`;
        const merged = byKey.get(key) ?? ({ date_start: String(r.date_start) } as InsightRow);
        Object.assign(merged, r);
        byKey.set(key, merged);
      }
    }
    // Optionally capture conversions split by attribution window — a dedicated request stored in a
    // separate column, so the dashboards' unified-attribution conversion numbers are unchanged.
    const winMap = new Map<string, { actions: unknown; action_values: unknown }>();
    if (attributionWindows) {
      const winRows = await client.getInsights(accountId, {
        level,
        time_range: { since: window.since, until: window.until },
        time_increment: 1,
        fields: ["actions", "action_values", "account_id", "campaign_id", "adset_id", "ad_id"],
        action_attribution_windows: ATTRIBUTION_WINDOWS,
      });
      for (const r of winRows) {
        const entityId = level === "account" ? accountId : String(r[ID_FIELD[level]] ?? accountId);
        winMap.set(`${entityId}:${String(r.date_start)}`, {
          actions: r.actions ?? null,
          action_values: r.action_values ?? null,
        });
      }
    }
    for (const merged of byKey.values()) {
      const entityId =
        level === "account" ? accountId : String(merged[ID_FIELD[level]] ?? accountId);
      const base = normalizeInsightRow(merged, level, entityId, accountId);
      const win = attributionWindows ? winMap.get(`${entityId}:${base.date}`) : undefined;
      // When not capturing windows (backfill), omit the columns so an older chunk never nulls out
      // the windowed data a recent refresh wrote for overlapping dates.
      const values = attributionWindows
        ? {
            ...base,
            actionsByWindow: win?.actions ?? null,
            actionValuesByWindow: win?.action_values ?? null,
          }
        : base;
      await db
        .insert(schema.insightsDaily)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.insightsDaily.level,
            schema.insightsDaily.entityId,
            schema.insightsDaily.date,
          ],
          set: { ...values, syncedAt: new Date() },
        });
      written++;
    }
  }
  return written;
}

/** Sync the trailing `days` window (used for the recurring refresh). */
export async function syncInsights(
  client: InsightsClient,
  accountId: string,
  opts: { level: Level; days: number; today?: Date },
): Promise<number> {
  const { since, until } = trailingRange(opts.days, opts.today);
  // The recurring refresh captures attribution-window splits for recent (still-attributing) data.
  return syncInsightsRange(client, accountId, opts.level, since, until, true);
}
