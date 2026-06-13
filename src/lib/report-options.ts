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
];

export const DEFAULT_REPORT_COLUMN_KEYS = ["spend", "impressions", "ctr", "cpc", "results"];

export const REPORT_BREAKDOWNS: { key: string; label: string }[] = [
  { key: "none", label: "Total (no breakdown)" },
  { key: "day", label: "By day" },
  { key: "platform", label: "By platform" },
  { key: "placement", label: "By placement" },
  { key: "age", label: "By age" },
  { key: "gender", label: "By gender" },
  { key: "country", label: "By country" },
  { key: "region", label: "By region" },
];

export const REPORT_RANGE_PRESETS = [7, 14, 30, 90];
