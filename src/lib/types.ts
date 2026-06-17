export type AccountStatus = "ACTIVE" | "PAUSED" | "DISABLED" | "PENDING";
export type CampaignObjective =
  | "CONVERSIONS"
  | "TRAFFIC"
  | "REACH"
  | "VIDEO_VIEWS"
  | "APP_INSTALLS"
  | "LEAD_GEN"
  | "BRAND_AWARENESS";
export type CampaignStatus = "ACTIVE" | "PAUSED" | "LEARNING" | "COMPLETED";

export interface AdAccount {
  id: string;
  name: string;
  currency: string;
  status: AccountStatus;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  reach: number;
  spark: number[];
  /** Objective-aware "Results" total (leads/purchases/etc.) across the account. */
  results: number;
  resultLabel: string;
  /** Human disable_reason + best-known disabled date; both null unless the account is disabled. */
  disableReason: string | null;
  disabledSince: string | null;
}
export interface Ad {
  id: string;
  name: string;
  status: CampaignStatus;
  spend: number;
  impressions: number;
  ctr: number;
  cpc: number;
  roas: number;
  conversions: number;
  /** Objective-dependent "Results" count (e.g. purchases, leads, link clicks). */
  results: number;
  resultLabel: string;
  format: "Image" | "Video" | "Carousel" | "Collection";
  thumbHue: number;
  thumbnailUrl?: string | null;
}
export interface AdSet {
  id: string;
  name: string;
  status: CampaignStatus;
  spend: number;
  ctr: number;
  roas: number;
  results: number;
  resultLabel: string;
  audience: string;
  frequency: number;
  ads: Ad[];
}
export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  objective: CampaignObjective;
  accountId: string;
  accountName: string;
  spend: number;
  impressions: number;
  conversions: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  frequency: number;
  results: number;
  resultLabel: string;
  adSets: AdSet[];
}
export interface CreativeCard extends Ad {
  campaign: string;
  account: string;
  accountId: string;
  title?: string | null;
  body?: string | null;
  callToActionType?: string | null;
}
export interface BreakdownRow {
  label: string;
  spend: number;
  conversions: number;
  roas: number;
}
export interface Kpis {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  reach: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
}
export interface TrendPoint {
  date: string;
  spend: number;
  conversions: number;
  revenue: number;
  impressions: number;
  clicks: number;
  reach: number;
}
/** Percent change vs the preceding window of equal length; null = no baseline. */
export interface KpiDeltas {
  spend: number | null;
  revenue: number | null;
  roas: number | null;
  ctr: number | null;
  conversions: number | null;
  impressions: number | null;
  cpc: number | null;
  cpm: number | null;
  reach: number | null;
}
