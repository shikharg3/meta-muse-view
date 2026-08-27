// Client-safe report breakdown + range vocabulary (no DB/secret imports), shared by the Settings and
// chat UI with the server report engine.
//
// Column labels and kinds are NOT defined here any more: they live in report-catalog.ts, and this
// module only projects the subset the current picker shows. Two hand-maintained lists that had to
// agree is precisely the arrangement that crashed report generation when they did not.
import { LEGACY_UI_COLUMN_KEYS, metric, type ReportColumnKind } from "./report-catalog";

export type { ReportColumnKind };

export interface ReportColumnDef {
  key: string;
  label: string;
  kind: ReportColumnKind;
}

/** Catalog projection for the current chip-cloud picker. See LEGACY_UI_COLUMN_KEYS. */
export const REPORT_COLUMNS: ReportColumnDef[] = LEGACY_UI_COLUMN_KEYS.map((k) => {
  const m = metric(k)!;
  return { key: m.key, label: m.label, kind: m.kind };
});

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
