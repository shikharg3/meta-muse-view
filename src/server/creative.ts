import type { Ad } from "@/lib/types";

interface CreativeRaw {
  object_type?: string;
  image_url?: string;
  object_story_spec?: {
    link_data?: { child_attachments?: unknown[]; picture?: string };
    video_data?: { image_url?: string };
  };
}

/** Map a stored ad_creatives.raw payload to a display format. */
export function creativeFormat(raw: unknown): Ad["format"] {
  const r = (raw ?? {}) as CreativeRaw;
  if ((r.object_story_spec?.link_data?.child_attachments?.length ?? 0) > 1) return "Carousel";
  if (r.object_type === "VIDEO") return "Video";
  return "Image";
}

/**
 * Best display image for a creative: original image, then video poster, then
 * link picture, then the (1080px-requested) thumbnail.
 */
export function creativeImageUrl(raw: unknown, thumbnailUrl: string | null): string | null {
  const r = (raw ?? {}) as CreativeRaw;
  return (
    r.image_url ||
    r.object_story_spec?.video_data?.image_url ||
    r.object_story_spec?.link_data?.picture ||
    thumbnailUrl ||
    null
  );
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
