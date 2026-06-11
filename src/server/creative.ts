import type { Ad } from "@/lib/types";

interface CreativeRaw {
  object_type?: string;
  object_story_spec?: { link_data?: { child_attachments?: unknown[] } };
}

/** Map a stored ad_creatives.raw payload to a display format. */
export function creativeFormat(raw: unknown): Ad["format"] {
  const r = (raw ?? {}) as CreativeRaw;
  if ((r.object_story_spec?.link_data?.child_attachments?.length ?? 0) > 1) return "Carousel";
  if (r.object_type === "VIDEO") return "Video";
  return "Image";
}

/** Stable placeholder hue (0-359) derived from an id, for ads without a thumbnail. */
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
