import type { Ad } from "@/lib/types";

/**
 * The only creative fields the UI actually needs. Projected directly in SQL, because the stored
 * `ad_creatives.raw` payloads total ~77 MB — loading them to read five fields cost ~3s per request.
 */
export interface CreativeFacts {
  objectType: string | null;
  imageUrl: string | null;
  videoImageUrl: string | null;
  linkPicture: string | null;
  /** Number of carousel child attachments (>1 means Carousel). */
  childAttachments: number;
  thumbnailUrl: string | null;
}

/** Display format for a creative. */
export function creativeFormat(f: CreativeFacts | undefined): Ad["format"] {
  if ((f?.childAttachments ?? 0) > 1) return "Carousel";
  if (f?.objectType === "VIDEO") return "Video";
  return "Image";
}

/**
 * Best display image for a creative: original image, then video poster, then
 * link picture, then the (1080px-requested) thumbnail.
 */
export function creativeImageUrl(f: CreativeFacts | undefined): string | null {
  return f?.imageUrl || f?.videoImageUrl || f?.linkPicture || f?.thumbnailUrl || null;
}

export interface ResultSpec {
  /** Action type summed from insights `actions`, or "reach" for awareness objectives. */
  type: string;
  label: string;
}

// Meta's "Results" is objective-dependent. Covers both legacy and ODAX names.
const RESULT_BY_OBJECTIVE: Record<string, ResultSpec> = {
  OUTCOME_SALES: { type: "omni_purchase", label: "Purchases" },
  CONVERSIONS: { type: "omni_purchase", label: "Purchases" },
  PRODUCT_CATALOG_SALES: { type: "omni_purchase", label: "Purchases" },
  OUTCOME_LEADS: { type: "lead", label: "Leads" },
  LEAD_GENERATION: { type: "lead", label: "Leads" },
  OUTCOME_TRAFFIC: { type: "link_click", label: "Link clicks" },
  TRAFFIC: { type: "link_click", label: "Link clicks" },
  LINK_CLICKS: { type: "link_click", label: "Link clicks" },
  OUTCOME_ENGAGEMENT: { type: "post_engagement", label: "Engagements" },
  ENGAGEMENT: { type: "post_engagement", label: "Engagements" },
  POST_ENGAGEMENT: { type: "post_engagement", label: "Engagements" },
  OUTCOME_APP_PROMOTION: { type: "omni_app_install", label: "App installs" },
  APP_INSTALLS: { type: "omni_app_install", label: "App installs" },
  VIDEO_VIEWS: { type: "video_view", label: "Video views" },
  OUTCOME_AWARENESS: { type: "reach", label: "Reach" },
  BRAND_AWARENESS: { type: "reach", label: "Reach" },
  REACH: { type: "reach", label: "Reach" },
};

/** What counts as a "result" for a campaign objective (defaults to purchases). */
export function resultSpec(objective: string | null | undefined): ResultSpec {
  return RESULT_BY_OBJECTIVE[objective ?? ""] ?? { type: "omni_purchase", label: "Purchases" };
}

/** Stable placeholder hue (0-359) derived from an id, for ads without a thumbnail. */
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
