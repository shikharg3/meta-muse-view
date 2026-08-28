// Client-safe report breakdown + range vocabulary (no DB/secret imports), shared by the Settings and
// chat UI with the server report engine.
//
// Column labels, kinds and groups are NOT defined here any more: they live in report-catalog.ts, and
// this module projects all of them for the picker. Two hand-maintained lists that had to agree is
// precisely the arrangement that crashed report generation when they did not.
import { REPORT_METRICS, type MetricGroup, type ReportColumnKind } from "./report-catalog";

export type { ReportColumnKind };

export interface ReportColumnDef {
  key: string;
  label: string;
  kind: ReportColumnKind;
  group: MetricGroup;
}

/** Every catalog metric, projected for the picker. */
export const REPORT_COLUMNS: ReportColumnDef[] = REPORT_METRICS.map((m) => ({
  key: m.key,
  label: m.label,
  kind: m.kind,
  group: m.group,
}));

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
