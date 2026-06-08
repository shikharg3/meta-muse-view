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
  };
}

/** Map a Graph object id to its insights level. */
export function levelForId(id: string): "account" | "campaign" | "adset" | "ad" {
  if (id.startsWith("act_")) return "account";
  return "campaign"; // jobs pass an explicit level; this is only a fallback
}
