import { db, schema } from "@/db/client";
import type { InsightRow, InsightsClient } from "@/meta/types";
import { isZeroedInsightRow, normalizeInsightRow } from "@/meta/insights";
import {
  ATTRIBUTION_WINDOWS,
  CORE_METRICS,
  INSIGHT_METRIC_GROUPS,
  SPEND_CORRUPTING_METRICS,
} from "@/meta/fieldsets";
import { MetaAuthError, MetaCircuitOpenError } from "@/meta/client";
import { accountIsExcludedOnly, loadExclusions } from "../exclusions";

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

/**
 * Sync insights over an explicit [since, until] window (chunked), merging the requested metric
 * `groups` (default: all). The CORE-only subset powers the fast hourly refresh; the full set is the
 * daily refresh + backfill.
 * `useAsync` routes each group through an async report run instead of a synchronous GET — used for
 * the heavy historical backfill so its compute lands on Meta's async budget (eases the #80004 /
 * cputime throttles that hit the foreground refresh).
 */
export async function syncInsightsRange(
  client: InsightsClient,
  accountId: string,
  level: Level,
  since: string,
  until: string,
  attributionWindows = false,
  useAsync = false,
  groups: string[][] = INSIGHT_METRIC_GROUPS,
): Promise<number> {
  let written = 0;
  // Excluded campaigns must not reach this table either. Every non-account request already asks for
  // `campaign_id` (it is in each metric group), so a row can be judged on its own contents; the
  // account level carries no campaign id at all, which is why an account whose whole campaign list
  // was excluded is dropped wholesale instead. See `src/sync/exclusions.ts`.
  const excluded = await loadExclusions();
  if (level === "account" && (await accountIsExcludedOnly(accountId, excluded))) return 0;
  const isExcludedRow = (row: InsightRow, entityId: string): boolean =>
    Boolean(excluded[entityId]) ||
    Boolean(row.campaign_id && excluded[String(row.campaign_id)]) ||
    Boolean(row.adset_id && excluded[String(row.adset_id)]);
  // Long ranges are chunked so each request stays within Meta's per-call data limits.
  for (const window of chunkRange(since, until)) {
    // Request every metric in compatible groups, merged by (entity, date) so each daily row carries
    // the full metric set. The merged row is stored in `raw`; high-value metrics are promoted.
    const byKey = new Map<string, InsightRow>();
    const keyOf = (r: InsightRow): string =>
      `${level === "account" ? accountId : String(r[ID_FIELD[level]] ?? accountId)}:${String(r.date_start)}`;
    const request = (fields: string[]): Promise<InsightRow[]> => {
      const params = {
        level,
        time_range: { since: window.since, until: window.until },
        time_increment: 1,
        // De-dupe: the metric groups already include the id fields, so appending them again
        // would trigger Meta error 2500 ("Field account_id specified more than once").
        fields: [...new Set([...fields, "account_id", "campaign_id", "adset_id", "ad_id"])],
        use_unified_attribution_setting: true,
      };
      return useAsync
        ? client.runAsyncInsights(accountId, params, { memoKey: `insights:${level}:` })
        : client.getInsights(accountId, params);
    };
    // Fetch every metric group concurrently. The client's Limiter still caps real HTTP concurrency,
    // but firing them together overlaps the async reports' 5s poll latency instead of serializing it
    // — 15 groups × 4 levels run serially was the backfill bottleneck.
    const groupRows = await Promise.all(
      groups.map(async (group) => {
        try {
          return await request(group);
        } catch (e) {
          // A dead token, or Meta failing every call, must abort — not be logged as a skipped group
          // and retried across every remaining account.
          if (e instanceof MetaAuthError || e instanceof MetaCircuitOpenError) throw e;
          console.error(
            `[insights] ${level} metric group skipped:`,
            e instanceof Error ? e.message : e,
          );
          return [] as InsightRow[];
        }
      }),
    );
    for (const rows of groupRows) {
      for (const r of rows) {
        const key = keyOf(r);
        const merged = byKey.get(key) ?? ({ date_start: String(r.date_start) } as InsightRow);
        Object.assign(merged, r);
        byKey.set(key, merged);
      }
    }
    // Rows Meta zeroed because the request also asked for action metrics (`SPEND_CORRUPTING_METRICS`)
    // get their figures from one more request for the rest of CORE without those fields, which Meta
    // answers correctly. Only a window that shows the damage pays for it. A damaged row that request
    // cannot repair is not written: the stored figures beat a zero that never happened.
    const zeroed = [...byKey].filter(([, row]) => isZeroedInsightRow(row));
    const unrepaired = new Set<string>();
    if (zeroed.length > 0) {
      const requested = new Set(groups.flat());
      const repairFields = CORE_METRICS.filter(
        (m) => requested.has(m) && !SPEND_CORRUPTING_METRICS.includes(m),
      );
      let fixes = new Map<string, InsightRow>();
      try {
        fixes = new Map((await request(repairFields)).map((r) => [keyOf(r), r]));
      } catch (e) {
        if (e instanceof MetaAuthError || e instanceof MetaCircuitOpenError) throw e;
        console.error(
          `[insights] ${level} zeroed-row re-request failed:`,
          e instanceof Error ? e.message : e,
        );
      }
      for (const [key, row] of zeroed) {
        const fix = fixes.get(key);
        if (!fix) {
          unrepaired.add(key);
          continue;
        }
        for (const m of repairFields) if (fix[m] !== undefined) row[m] = fix[m];
        // Meta's link_click action is the same count (matched row for row at every level), and the
        // action list survives the damage, so it stands in for the zeroed inline_link_clicks.
        if (requested.has("inline_link_clicks")) {
          const linkClicks = row.actions?.find((a) => a.action_type === "link_click")?.value;
          row.inline_link_clicks = linkClicks ?? "0";
        }
      }
      console.warn(
        `[insights] ${accountId} ${level} ${window.since}..${window.until}: ${zeroed.length} rows zeroed by Meta, ` +
          `${zeroed.length - unrepaired.size} repaired, ${unrepaired.size} left as stored`,
      );
    }
    // Optionally capture conversions split by attribution window — a dedicated request stored in a
    // separate column, so the dashboards' unified-attribution conversion numbers are unchanged.
    const winMap = new Map<string, { actions: unknown; action_values: unknown }>();
    if (attributionWindows) {
      try {
        const winRows = await client.getInsights(accountId, {
          level,
          time_range: { since: window.since, until: window.until },
          time_increment: 1,
          fields: [
            ...new Set([
              "actions",
              "action_values",
              "account_id",
              "campaign_id",
              "adset_id",
              "ad_id",
            ]),
          ],
          action_attribution_windows: ATTRIBUTION_WINDOWS,
        });
        for (const r of winRows) {
          winMap.set(keyOf(r), {
            actions: r.actions ?? null,
            action_values: r.action_values ?? null,
          });
        }
      } catch (e) {
        console.error(
          `[insights] ${level} attribution-window request skipped:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    for (const [key, merged] of byKey) {
      if (unrepaired.has(key)) continue;
      const entityId =
        level === "account" ? accountId : String(merged[ID_FIELD[level]] ?? accountId);
      if (isExcludedRow(merged, entityId)) continue;
      const base = normalizeInsightRow(merged, level, entityId, accountId);
      const win = attributionWindows ? winMap.get(key) : undefined;
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
  opts: { level: Level; days: number; today?: Date; groups?: string[][] },
): Promise<number> {
  const { since, until } = trailingRange(opts.days, opts.today);
  // The recurring refresh captures attribution-window splits for recent (still-attributing) data.
  return syncInsightsRange(client, accountId, opts.level, since, until, true, false, opts.groups);
}
