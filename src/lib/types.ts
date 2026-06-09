export type AccountStatus = "ACTIVE" | "PAUSED" | "DISABLED" | "PENDING";
export type CampaignObjective =
  | "CONVERSIONS" | "TRAFFIC" | "REACH" | "VIDEO_VIEWS"
  | "APP_INSTALLS" | "LEAD_GEN" | "BRAND_AWARENESS";
export type CampaignStatus = "ACTIVE" | "PAUSED" | "LEARNING" | "COMPLETED";

export interface AdAccount {
  id: string; name: string; currency: string; status: AccountStatus;
  spend: number; impressions: number; clicks: number; conversions: number;
  revenue: number; ctr: number; cpc: number; cpm: number; roas: number;
  reach: number; frequency: number; spark: number[];
}
export interface Ad {
  id: string; name: string; status: CampaignStatus; spend: number;
  impressions: number; ctr: number; cpc: number; roas: number; conversions: number;
  format: "Image" | "Video" | "Carousel" | "Collection"; thumbHue: number; thumbnailUrl?: string | null;
}
export interface AdSet {
  id: string; name: string; status: CampaignStatus; spend: number;
  ctr: number; roas: number; audience: string; ads: Ad[];
}
export interface Campaign {
  id: string; name: string; status: CampaignStatus; objective: CampaignObjective;
  accountId: string; accountName: string; spend: number; impressions: number;
  conversions: number; ctr: number; cpc: number; cpm: number; roas: number; adSets: AdSet[];
}
export interface CreativeCard extends Ad { campaign: string; account: string; }
export interface BreakdownRow { label: string; spend: number; conversions: number; roas: number; }
export interface Kpis {
  spend: number; impressions: number; clicks: number; conversions: number; revenue: number;
  reach: number; ctr: number; cpc: number; cpm: number; roas: number; frequency: number;
}
export interface TrendPoint { date: string; spend: number; conversions: number; revenue: number; }
