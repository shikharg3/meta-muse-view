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

export async function syncInsights(
  client: InsightsClient,
  accountId: string,
  opts: { level: Level; days: number; today?: Date },
): Promise<number> {
  const { since, until } = trailingRange(opts.days, opts.today);
  const rows = await client.getInsights(accountId, {
    level: opts.level,
    time_range: { since, until },
    time_increment: 1,
    fields: [
      "spend", "impressions", "reach", "clicks", "inline_link_clicks", "ctr", "cpc", "cpm",
      "actions", "action_values", "purchase_roas",
      "account_id", "campaign_id", "adset_id", "ad_id",
    ],
    use_unified_attribution_setting: true,
  });

  let written = 0;
  for (const r of rows) {
    const entityId =
      opts.level === "account" ? accountId : String(r[ID_FIELD[opts.level]] ?? accountId);
    const v = normalizeInsightRow(r, opts.level, entityId, accountId);
    await db
      .insert(schema.insightsDaily)
      .values(v)
      .onConflictDoUpdate({
        target: [schema.insightsDaily.level, schema.insightsDaily.entityId, schema.insightsDaily.date],
        set: { ...v, syncedAt: new Date() },
      });
    written++;
  }
  return written;
}
