/**
 * Where an ad actually sends someone who clicks it.
 *
 * A creative carries several URL-shaped fields and most of them are NOT click destinations. Only the
 * ones a person can land on by tapping the ad count here:
 *
 *   INCLUDED
 *     asset_feed_spec.link_urls[].website_url      dynamic creative — Meta rotates these per
 *                                                  impression, so every entry is a real destination
 *     object_story_spec.link_data.link             link ad
 *     ...link_data.child_attachments[].link        carousel — one destination per card
 *     ...link_data.call_to_action.value.link       an explicit CTA target overriding the above
 *     ...video_data.call_to_action.value.link      video ad
 *     ...photo_data.call_to_action.value.link      photo ad
 *
 *   EXCLUDED, deliberately
 *     link_data.caption / display_url   the domain SHOWN on the ad. Advertisers routinely display a
 *                                       brand domain while linking to a tracker, so this is the one
 *                                       field guaranteed to be a lie about the destination.
 *     link_data.picture / image_url     the creative image.
 *     instagram_permalink_url,          the post itself, not where it sends you.
 *       effective_object_story_id
 *     url_tags                          query parameters appended to a destination, not a URL.
 *     template_url                      catalog/DPA pattern full of {{product.*}} macros; it never
 *                                       resolves to one page.
 *     applink_treatment, deeplink       app targets, not web landing pages.
 */

/** A creative's two spec blobs, exactly as stored on `ad_creatives`. */
export interface CreativeSpecs {
  objectStorySpec?: unknown;
  assetFeedSpec?: unknown;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A click target, or null when the field is absent/blank/not a web URL. */
function webUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  // Only http(s): an app deeplink (fb://, myapp://) is not a landing page, and a macro-only value
  // ({{product.url}}) is not a page anyone lands on.
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

/** The CTA target nested under a *_data block, when it overrides the block's own link. */
function ctaLink(block: Record<string, unknown> | null): string | null {
  const cta = obj(block?.call_to_action);
  return webUrl(obj(cta?.value)?.link);
}

/**
 * Every distinct URL a click on this ad can land on, in a stable order.
 *
 * Dynamic creative wins outright when present: its `link_urls` are what Meta serves, and the
 * object_story_spec left beside it is the pre-DCO shell rather than a live destination. Mixing the
 * two would report a page the ad no longer sends anyone to.
 */
export function clickDestinations(creative: CreativeSpecs): string[] {
  const out: string[] = [];
  const push = (u: string | null) => {
    if (u && !out.includes(u)) out.push(u);
  };

  const feed = obj(creative.assetFeedSpec);
  const feedUrls = arr(feed?.link_urls);
  if (feedUrls.length > 0) {
    for (const lu of feedUrls) {
      const e = obj(lu);
      // `website_url` is the destination; `display_url` beside it is cosmetic.
      push(webUrl(e?.website_url));
      push(ctaLink(e));
    }
    if (out.length > 0) return out;
  }

  const oss = obj(creative.objectStorySpec);
  const link = obj(oss?.link_data);
  if (link) {
    push(webUrl(link.link));
    push(ctaLink(link));
    for (const ca of arr(link.child_attachments)) {
      const card = obj(ca);
      push(webUrl(card?.link));
      push(ctaLink(card));
    }
  }
  push(ctaLink(obj(oss?.video_data)));
  push(ctaLink(obj(oss?.photo_data)));
  return out;
}

/**
 * Collapse destinations that differ only by tracking parameters.
 *
 * One tracker URL carrying `utm_campaign={{campaign.name}}` per ad yields dozens of near-identical
 * strings, which is unreadable in a board cell. Grouping by origin + path keeps one row per real
 * landing page while preserving the first full URL seen, so nothing is silently rewritten.
 */
export function groupByLandingPage(urls: string[]): { page: string; full: string }[] {
  const seen = new Map<string, { page: string; full: string }>();
  for (const full of urls) {
    let page = full;
    try {
      const u = new URL(full);
      page = `${u.origin}${u.pathname}`.replace(/\/$/, "");
    } catch {
      // Not parseable — keep it whole rather than dropping a destination on the floor.
    }
    if (!seen.has(page)) seen.set(page, { page, full });
  }
  return [...seen.values()];
}
