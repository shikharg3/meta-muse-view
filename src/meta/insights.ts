import type { InsightRow } from "./types";

type ActionArr = { action_type: string; value: string }[] | undefined;

/** The conversion action type we treat as "the" conversion by default (revisable; raw is kept). */
export const DEFAULT_CONVERSION_TYPE = "omni_purchase";

export function pickAction(actions: ActionArr, type: string): number {
  if (!actions) return 0;
  return actions
    .filter((a) => a.action_type === type)
    .reduce((sum, a) => sum + (Number(a.value) || 0), 0);
}

const n = (v: unknown): number => (v == null ? 0 : Number(v) || 0);
const sOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export interface NormalizedInsight {
  level: string;
  entityId: string;
  accountId: string;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  inlineLinkClicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  conversions: number;
  conversionValues: number;
  purchaseRoas: number;
  actions: unknown;
  actionValues: unknown;
  raw: unknown;
  frequency: number | null;
  qualityRanking: string | null;
  engagementRateRanking: string | null;
  conversionRateRanking: string | null;
  estimatedAdRecallRate: number | null;
  uniqueClicks: number | null;
  uniqueCtr: number | null;
  inlinePostEngagement: number | null;
  fullViewImpressions: number | null;
  fullViewReach: number | null;
}

export function normalizeInsightRow(
  row: InsightRow,
  level: string,
  entityId: string,
  accountId: string,
): NormalizedInsight {
  return {
    level,
    entityId,
    accountId,
    date: row.date_start,
    spend: n(row.spend),
    impressions: n(row.impressions),
    reach: n(row.reach),
    clicks: n(row.clicks),
    inlineLinkClicks: n(row.inline_link_clicks),
    ctr: n(row.ctr),
    cpc: n(row.cpc),
    cpm: n(row.cpm),
    conversions: pickAction(row.actions, DEFAULT_CONVERSION_TYPE),
    conversionValues: pickAction(row.action_values, DEFAULT_CONVERSION_TYPE),
    purchaseRoas: pickAction(row.purchase_roas, DEFAULT_CONVERSION_TYPE),
    actions: row.actions ?? null,
    actionValues: row.action_values ?? null,
    raw: row,
    frequency: numOrNull(row.frequency),
    qualityRanking: sOrNull(row.quality_ranking),
    engagementRateRanking: sOrNull(row.engagement_rate_ranking),
    conversionRateRanking: sOrNull(row.conversion_rate_ranking),
    estimatedAdRecallRate: numOrNull(row.estimated_ad_recall_rate),
    uniqueClicks: numOrNull(row.unique_clicks),
    uniqueCtr: numOrNull(row.unique_ctr),
    inlinePostEngagement: numOrNull(row.inline_post_engagement),
    fullViewImpressions: numOrNull(row.full_view_impressions),
    fullViewReach: numOrNull(row.full_view_reach),
  };
}

/** Map a Graph object id to its insights level. */
export function levelForId(id: string): "account" | "campaign" | "adset" | "ad" {
  if (id.startsWith("act_")) return "account";
  return "campaign"; // jobs pass an explicit level; this is only a fallback
}
