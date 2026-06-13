import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { pickAction } from "@/meta/insights";
import { resultSpec, creativeFormat, creativeImageUrl } from "@/server/creative";
import { resolveRange } from "./report";

export type CreativeMetric =
  | "results"
  | "spend"
  | "impressions"
  | "ctr"
  | "cpc"
  | "cpm"
  | "roas"
  | "cost_per_result";

export interface CreativeCopy {
  title?: string;
  body?: string;
  cta?: string;
}

export interface CreativeRow {
  id: string;
  name: string;
  format: ReturnType<typeof creativeFormat>;
  thumbnailUrl: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  results: number;
  resultLabel: string;
  costPerResult: number;
  copy: CreativeCopy;
}

export interface CreativeImage {
  ref: string;
  mediaType: string;
  base64: string;
}

export interface CreativeAnalysis {
  name: string;
  since: string;
  until: string;
  metric: CreativeMetric;
  metricLabel: string;
  rows: CreativeRow[];
  images: CreativeImage[];
}

const METRIC_LABEL: Record<CreativeMetric, string> = {
  results: "Results",
  spend: "Spend",
  impressions: "Impressions",
  ctr: "CTR",
  cpc: "CPC",
  cpm: "CPM",
  roas: "ROAS",
  cost_per_result: "Cost / Result",
};

export function normalizeMetric(input: unknown): CreativeMetric {
  const v = String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (v.includes("costperresult") || v === "cpr") return "cost_per_result";
  if (v.includes("cpc")) return "cpc";
  if (v.includes("cpm")) return "cpm";
  if (v.includes("ctr") || v.includes("clickthrough")) return "ctr";
  if (v.includes("roas") || v.includes("return")) return "roas";
  if (v.includes("spend") || v.includes("cost") || v.includes("budget")) return "spend";
  if (v.includes("impression") || v.includes("reach")) return "impressions";
  return "results";
}

interface Agg {
  id: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  results: number;
  conversionValue: number;
  labelSpend: Map<string, number>;
}

interface InsightRowLite {
  entityId: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversionValues: number;
  actions: unknown;
}

const empty = (id: string): Agg => ({
  id,
  spend: 0,
  impressions: 0,
  reach: 0,
  clicks: 0,
  results: 0,
  conversionValue: 0,
  labelSpend: new Map(),
});

/** Extract headline/body/CTA from a stored creative's object_story_spec. */
export function extractCopy(raw: unknown): CreativeCopy {
  const spec =
    (
      raw as {
        object_story_spec?: Record<
          string,
          { message?: string; name?: string; title?: string; call_to_action?: { type?: string } }
        >;
      }
    )?.object_story_spec ?? {};
  const ld = spec.link_data ?? {};
  const vd = spec.video_data ?? {};
  const body = ld.message ?? vd.message;
  const title = ld.name ?? ld.title ?? vd.title;
  const cta = (ld.call_to_action ?? vd.call_to_action)?.type;
  return {
    title: title ? String(title).slice(0, 120) : undefined,
    body: body ? String(body).slice(0, 300) : undefined,
    cta: cta ? String(cta).replace(/_/g, " ").toLowerCase() : undefined,
  };
}

/**
 * Aggregate ad-level insight rows up to the creative each ad uses. Results are
 * objective-aware: each row contributes its campaign objective's result action
 * (reach for awareness). Pure — no I/O.
 */
export function aggregateByCreative(
  insights: InsightRowLite[],
  creativeByAd: Map<string, string>,
  objectiveByAd: Map<string, string | undefined>,
  creativeMeta: Map<string, { name: string | null; thumbnailUrl: string | null; raw: unknown }>,
): CreativeRow[] {
  const aggs = new Map<string, Agg>();
  for (const r of insights) {
    const creativeId = creativeByAd.get(r.entityId);
    if (!creativeId) continue;
    let a = aggs.get(creativeId);
    if (!a) {
      a = empty(creativeId);
      aggs.set(creativeId, a);
    }
    a.spend += r.spend;
    a.impressions += r.impressions;
    a.reach += r.reach;
    a.clicks += r.clicks;
    a.conversionValue += r.conversionValues;
    const spec = resultSpec(objectiveByAd.get(r.entityId));
    a.results +=
      spec.type === "reach"
        ? r.reach
        : pickAction(r.actions as { action_type: string; value: string }[] | undefined, spec.type);
    a.labelSpend.set(spec.label, (a.labelSpend.get(spec.label) ?? 0) + r.spend);
  }

  const rows: CreativeRow[] = [];
  for (const a of aggs.values()) {
    const meta = creativeMeta.get(a.id);
    // Dominant result label = objective that spent the most on this creative.
    let resultLabel = "Results";
    let best = -1;
    for (const [label, spend] of a.labelSpend) {
      if (spend > best) {
        best = spend;
        resultLabel = label;
      }
    }
    rows.push({
      id: a.id,
      name: meta?.name || a.id,
      format: creativeFormat(meta?.raw),
      thumbnailUrl: creativeImageUrl(meta?.raw, meta?.thumbnailUrl ?? null),
      spend: a.spend,
      impressions: a.impressions,
      clicks: a.clicks,
      ctr: a.impressions ? (a.clicks / a.impressions) * 100 : 0,
      cpc: a.clicks ? a.spend / a.clicks : 0,
      cpm: a.impressions ? (a.spend / a.impressions) * 1000 : 0,
      roas: a.spend ? a.conversionValue / a.spend : 0,
      results: a.results,
      resultLabel,
      costPerResult: a.results ? a.spend / a.results : 0,
      copy: extractCopy(meta?.raw),
    });
  }
  return rows;
}

const ASC_METRICS = new Set<CreativeMetric>(["cpc", "cpm", "cost_per_result"]);
const EFFICIENCY_METRICS = new Set<CreativeMetric>([
  "ctr",
  "cpc",
  "cpm",
  "cost_per_result",
  "roas",
]);
// Floor for efficiency rankings so a tiny-volume fluke can't top the list.
const MIN_IMPRESSIONS = 200;

function valueOf(r: CreativeRow, m: CreativeMetric): number {
  switch (m) {
    case "spend":
      return r.spend;
    case "impressions":
      return r.impressions;
    case "ctr":
      return r.ctr;
    case "cpc":
      return r.cpc;
    case "cpm":
      return r.cpm;
    case "roas":
      return r.roas;
    case "cost_per_result":
      return r.costPerResult;
    default:
      return r.results;
  }
}

/** Rank creatives by metric, applying a noise floor for efficiency metrics. */
export function rankCreatives(
  rows: CreativeRow[],
  metric: CreativeMetric,
  limit: number,
): CreativeRow[] {
  let pool = EFFICIENCY_METRICS.has(metric)
    ? rows.filter((r) => r.impressions >= MIN_IMPRESSIONS && r.spend > 0)
    : rows.slice();
  const asc = ASC_METRICS.has(metric);
  const val = (r: CreativeRow) => valueOf(r, metric);
  if (asc) pool = pool.filter((r) => val(r) > 0); // drop no-data rows that would sort "best"
  pool.sort((a, b) => (asc ? val(a) - val(b) : val(b) - val(a)) || b.spend - a.spend);
  return pool.slice(0, Math.max(1, Math.min(limit, 12)));
}

async function fetchImage(url: string): Promise<{ mediaType: string; base64: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 4_500_000) return null;
    return { mediaType: ct, base64: buf.toString("base64") };
  } catch {
    return null;
  }
}

export interface CreativeAnalysisArgs {
  name: string;
  accountIds: string[];
  days?: number;
  since?: string;
  until?: string;
  metric: CreativeMetric;
  limit: number;
}

/** Resolve creative metrics from synced data, rank, and fetch top images for the model. */
export async function analyzeCreatives(
  args: CreativeAnalysisArgs,
): Promise<CreativeAnalysis | { error: string }> {
  if (args.accountIds.length === 0)
    return { error: `No ad accounts are mapped to "${args.name}".` };
  const range = resolveRange(args);
  if (!range) return { error: "Pick a valid date range." };

  const adRows = await db
    .select({ id: schema.ads.id, creativeId: schema.ads.creativeId, adSetId: schema.ads.adSetId })
    .from(schema.ads)
    .where(inArray(schema.ads.accountId, args.accountIds));
  if (adRows.length === 0) return { error: `No ads found for "${args.name}".` };

  const creativeByAd = new Map<string, string>();
  const adSetIds = new Set<string>();
  for (const a of adRows) {
    if (a.creativeId) creativeByAd.set(a.id, a.creativeId);
    adSetIds.add(a.adSetId);
  }

  const [adSetRows, insightRows] = await Promise.all([
    db
      .select({ id: schema.adSets.id, campaignId: schema.adSets.campaignId })
      .from(schema.adSets)
      .where(inArray(schema.adSets.id, [...adSetIds])),
    db
      .select({
        entityId: schema.insightsDaily.entityId,
        spend: schema.insightsDaily.spend,
        impressions: schema.insightsDaily.impressions,
        reach: schema.insightsDaily.reach,
        clicks: schema.insightsDaily.clicks,
        conversionValues: schema.insightsDaily.conversionValues,
        actions: schema.insightsDaily.actions,
      })
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.level, "ad"),
          inArray(
            schema.insightsDaily.entityId,
            adRows.map((a) => a.id),
          ),
          gte(schema.insightsDaily.date, range.since),
          lte(schema.insightsDaily.date, range.until),
        ),
      ),
  ]);

  const campaignByAdSet = new Map(adSetRows.map((s) => [s.id, s.campaignId]));
  const campaignIds = [...new Set(adSetRows.map((s) => s.campaignId))];
  const campaignRows = campaignIds.length
    ? await db
        .select({ id: schema.campaigns.id, objective: schema.campaigns.objective })
        .from(schema.campaigns)
        .where(inArray(schema.campaigns.id, campaignIds))
    : [];
  const objByCampaign = new Map(campaignRows.map((c) => [c.id, c.objective ?? undefined]));

  const objectiveByAd = new Map<string, string | undefined>();
  for (const a of adRows) {
    objectiveByAd.set(a.id, objByCampaign.get(campaignByAdSet.get(a.adSetId) ?? "") ?? undefined);
  }

  const creativeIds = [...new Set([...creativeByAd.values()])];
  const creativeRows = creativeIds.length
    ? await db
        .select({
          id: schema.adCreatives.id,
          name: schema.adCreatives.name,
          thumbnailUrl: schema.adCreatives.thumbnailUrl,
          raw: schema.adCreatives.raw,
        })
        .from(schema.adCreatives)
        .where(inArray(schema.adCreatives.id, creativeIds))
    : [];
  const creativeMeta = new Map(creativeRows.map((c) => [c.id, c]));

  const all = aggregateByCreative(insightRows, creativeByAd, objectiveByAd, creativeMeta);
  if (all.length === 0) {
    return {
      error: `No creative performance data for "${args.name}" in ${range.since} → ${range.until}.`,
    };
  }
  const top = rankCreatives(all, args.metric, args.limit);

  // Fetch the top creatives' images for the model (skip failures).
  const images: CreativeImage[] = [];
  await Promise.all(
    top.map(async (r) => {
      if (!r.thumbnailUrl) return;
      const img = await fetchImage(r.thumbnailUrl);
      if (img) images.push({ ref: r.name, mediaType: img.mediaType, base64: img.base64 });
    }),
  );

  return {
    name: args.name,
    since: range.since,
    until: range.until,
    metric: args.metric,
    metricLabel: METRIC_LABEL[args.metric],
    rows: top,
    images,
  };
}
