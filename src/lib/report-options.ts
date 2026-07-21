// Client-safe report column + breakdown catalog (no DB/secret imports) so both
// the Settings/chat UI and the server report engine share one source of truth.
export type ReportColumnKind = "text" | "int" | "money" | "float" | "pct";

export interface ReportColumnDef {
  key: string;
  label: string;
  kind: ReportColumnKind;
}

export const REPORT_COLUMNS: ReportColumnDef[] = [
  { key: "spend", label: "Spend", kind: "money" },
  { key: "impressions", label: "Impressions", kind: "int" },
  { key: "reach", label: "Reach", kind: "int" },
  { key: "clicks", label: "Clicks", kind: "int" },
  { key: "link_clicks", label: "Link Clicks", kind: "int" },
  { key: "ctr", label: "CTR", kind: "pct" },
  { key: "cpc", label: "CPC", kind: "money" },
  { key: "cpm", label: "CPM", kind: "money" },
  { key: "frequency", label: "Frequency", kind: "float" },
  { key: "results", label: "Results", kind: "int" },
  { key: "cost_per_result", label: "Cost / Result", kind: "money" },
  { key: "conversions", label: "Conversions", kind: "int" },
  { key: "conversion_value", label: "Conv. Value", kind: "money" },
  { key: "roas", label: "ROAS", kind: "float" },
  { key: "registrations", label: "Registrations", kind: "int" },
  { key: "leads", label: "Leads", kind: "int" },
  { key: "initiate_checkout", label: "Checkouts", kind: "int" },
  { key: "purchases", label: "Purchases", kind: "int" },
  { key: "landing_page_views", label: "Landing Page Views", kind: "int" },
  { key: "cost_per_registration", label: "Cost / Reg.", kind: "money" },
  { key: "cost_per_lead", label: "Cost / Lead", kind: "money" },
  { key: "cost_per_purchase", label: "Cost / Purchase", kind: "money" },
];

export const DEFAULT_REPORT_COLUMN_KEYS = ["spend", "impressions", "ctr", "cpc", "results"];

/** Report dimensions (keys must match the server's Breakdown union). All compose with "Split by day". */
export const REPORT_BREAKDOWNS: { key: string; label: string }[] = [
  { key: "none", label: "Total (no breakdown)" },
  { key: "campaign", label: "By campaign" },
  { key: "adset", label: "By ad set" },
  { key: "ad", label: "By ad" },
  { key: "platform", label: "By platform" },
  { key: "placement", label: "By placement (platform · position · device)" },
  { key: "device", label: "By device platform" },
  { key: "age", label: "By age" },
  { key: "gender", label: "By gender" },
  { key: "age_gender", label: "By age · gender" },
  { key: "country", label: "By country" },
  { key: "region", label: "By region" },
  { key: "market", label: "By market (DMA)" },
  { key: "hour", label: "By hour (account time)" },
  { key: "hour_audience", label: "By hour (audience time)" },
  { key: "frequency", label: "By frequency" },
  { key: "product", label: "By product" },
  { key: "image_asset", label: "By image asset" },
  { key: "video_asset", label: "By video asset" },
  { key: "title_asset", label: "By headline asset" },
  { key: "body_asset", label: "By body text asset" },
  { key: "cta_asset", label: "By CTA asset" },
  { key: "description_asset", label: "By description asset" },
  { key: "link_asset", label: "By link URL asset" },
];

export const REPORT_RANGE_PRESETS = [7, 14, 30, 90];
