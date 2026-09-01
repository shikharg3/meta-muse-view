import { runReport, resolveRange, normalizeColumns, parseBreakdown } from "../report";
import { REPORT_METRICS } from "@/lib/report-catalog";
import { isResolveError, resolveSubject, type AgentTool } from "./kit";

/**
 * The advertised column list is generated from the catalog rather than hand-written.
 *
 * The hand-written list named 22 of the ~120 metrics `normalizeColumns` actually accepts, so the
 * model could not ask for video hook rate, ThruPlays, unique CTR or any cost-per-event family — they
 * worked, but nothing told it they existed.
 */
const COLUMN_KEYS = Object.keys(REPORT_METRICS).sort();

export const generateReport: AgentTool = {
  label: "report",
  definition: {
    name: "generate_report",
    description:
      "Generate a downloadable CSV/PDF performance report for a client or ad account, built from our synced Meta insights (NOT a live Meta API call — figures match the dashboards). Use for the /reports command or any request to 'generate/export/download a report'. Ask the user for missing details before calling: a report REQUIRES a subject (client or account) and a date range. Columns and breakdown are optional.",
    input_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: "Client or ad-account name, e.g. 'PlayW3'. Fuzzy-matched.",
        },
        preset: {
          type: "string",
          description:
            "Named range — PREFER over hand-computed dates: today, yesterday, last_7d, last_14d, last_30d, last_60d, last_90d, this_week_mon_today, last_week_mon_sun, this_month, last_month, this_quarter, last_quarter, this_year, last_year, maximum.",
        },
        days: { type: "integer", description: "Trailing window in days. Use this OR since+until." },
        since: { type: "string", description: "Start date YYYY-MM-DD (with until)." },
        until: { type: "string", description: "End date YYYY-MM-DD (with since)." },
        columns: {
          type: "array",
          items: { type: "string", enum: COLUMN_KEYS },
          description:
            "Metrics in order. Defaults to spend, impressions, ctr, cpc, results. The full catalog is available — including video (hook_rate, hold_rate, thruplays), unique_*, and cost_per_* families.",
        },
        campaign_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Restrict the report to these campaign ids (from search_entities or get_client_stats). Omit for every campaign on the subject's accounts.",
        },
        markup: {
          type: "number",
          description:
            "Percentage uplift applied to spend/cost columns for client-facing reports, e.g. 20 for +20%. Omit for raw cost.",
        },
        breakdown: {
          type: "string",
          enum: [
            "none",
            "day",
            "campaign",
            "adset",
            "ad",
            "platform",
            "placement",
            "device",
            "age",
            "gender",
            "age_gender",
            "country",
            "region",
            "market",
            "hour",
            "hour_audience",
            "frequency",
            "product",
            "image_asset",
            "video_asset",
            "title_asset",
            "body_asset",
            "cta_asset",
            "description_asset",
            "link_asset",
          ],
          description:
            "Row dimension. Entity grains: campaign / adset / ad (one row per entity; same-named entities merge). Meta dimensions: platform, placement, device, age, gender, age_gender, country, region, market (DMA), hour / hour_audience, frequency, product, and dynamic-creative asset dims. 'day' = daily totals. Default none (single total row).",
        },
        time_increment: {
          type: "string",
          enum: ["all_days", "1", "7", "28", "monthly"],
          description:
            "The time axis. all_days = one row per dimension value over the whole range (default). 1 = per day, 7 = 7-day buckets, 28 = 28-day buckets, monthly = calendar months clipped to the range. Combines with any breakdown. NOTE: reach, frequency and unique_* metrics are de-duplicated per row, so they are withheld from any row wider than a single day on a single account — use time_increment=1 when the user wants them.",
        },
      },
      required: ["subject"],
    },
  },
  async run(input) {
    const subject = await resolveSubject(String(input.subject ?? ""));
    if (isResolveError(subject)) return subject;
    const range = resolveRange(input);
    if (!range)
      return { error: "What date range? e.g. 'last 7 days' or specific since/until dates." };
    const bd = parseBreakdown(input.breakdown, input.time_increment);
    const campaignIds = Array.isArray(input.campaign_ids)
      ? input.campaign_ids.map(String).filter(Boolean)
      : undefined;
    const markup = Number(input.markup);
    return await runReport({
      name: subject.name,
      accountIds: subject.accountIds,
      since: range.since,
      until: range.until,
      columns: normalizeColumns(Array.isArray(input.columns) ? input.columns.map(String) : []),
      breakdown: bd.dim,
      timeIncrement: bd.timeIncrement,
      ...(campaignIds?.length ? { campaignIds } : {}),
      ...(Number.isFinite(markup) && markup > 0 ? { markup } : {}),
    });
  },
};
