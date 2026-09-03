import type { Ad } from "@/lib/types";
import { EVENT_MEMBERS } from "./agg";

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
  /**
   * Action types in preference order (Meta's unified `omni_*` first). The first type PRESENT in the
   * data is read — never the sum. Meta reports one conversion under several aliases with identical
   * counts, so adding them multiplies the result: betonline's 47 registrations arrive five times over
   * as `complete_registration`, `omni_complete_registration`,
   * `offsite_conversion.fb_pixel_complete_registration` and two more.
   *
   * `["reach"]` is the sentinel for awareness objectives, where the result is the reach column rather
   * than an action.
   */
  types: string[];
  label: string;
}

/**
 * A result spec backed by one canonical event family, so the alias list has exactly one home.
 * Throws on an unknown family: a typo would otherwise resolve to no action types at all and report a
 * confident zero, which is the failure mode this whole helper exists to prevent.
 */
function fromFamily(family: string, label: string = family): ResultSpec {
  const types = EVENT_MEMBERS[family];
  if (!types) throw new Error(`resultSpec: unknown event family "${family}"`);
  return { types, label };
}

const REACH: ResultSpec = { types: ["reach"], label: "Reach" };

// Meta's "Results" is objective-dependent. Covers both legacy and ODAX names.
const RESULT_BY_OBJECTIVE: Record<string, ResultSpec> = {
  OUTCOME_SALES: fromFamily("Purchases"),
  CONVERSIONS: fromFamily("Purchases"),
  PRODUCT_CATALOG_SALES: fromFamily("Purchases"),
  OUTCOME_LEADS: fromFamily("Leads"),
  LEAD_GENERATION: fromFamily("Leads"),
  OUTCOME_TRAFFIC: fromFamily("Link clicks"),
  TRAFFIC: fromFamily("Link clicks"),
  LINK_CLICKS: fromFamily("Link clicks"),
  OUTCOME_ENGAGEMENT: fromFamily("Post engagements", "Engagements"),
  ENGAGEMENT: fromFamily("Post engagements", "Engagements"),
  POST_ENGAGEMENT: fromFamily("Post engagements", "Engagements"),
  OUTCOME_APP_PROMOTION: fromFamily("App installs"),
  APP_INSTALLS: fromFamily("App installs"),
  VIDEO_VIEWS: fromFamily("Video views"),
  OUTCOME_AWARENESS: REACH,
  BRAND_AWARENESS: REACH,
  REACH: REACH,
};

/**
 * The conversion the ad sets actually optimise for (`promoted_object.custom_event_type`).
 *
 * This is the real answer and it outranks the objective, because an objective is a FAMILY of
 * conversions rather than one. `OUTCOME_LEADS` covers both an on-Meta instant form — which Meta
 * reports as `lead` — and a website pixel registration, which it reports as `complete_registration`
 * and never as `lead`. Reading the objective alone therefore counted an action type that does not
 * exist for such a campaign and printed a confident "0 Leads" over 47 real registrations.
 */
const RESULT_BY_CUSTOM_EVENT: Record<string, ResultSpec> = {
  PURCHASE: fromFamily("Purchases"),
  COMPLETE_REGISTRATION: fromFamily("Registrations"),
  LEAD: fromFamily("Leads"),
  ADD_TO_CART: fromFamily("Add to cart"),
  INITIATED_CHECKOUT: fromFamily("Checkouts initiated"),
  CONTENT_VIEW: fromFamily("View content"),
  SUBSCRIBE: fromFamily("Subscriptions"),
  START_TRIAL: fromFamily("Trials started"),
  ADD_PAYMENT_INFO: fromFamily("Add payment info"),
  CONTACT: fromFamily("Contacts"),
  SEARCH: fromFamily("Searches"),
};

/**
 * What counts as a "result" for a campaign: the event its ad sets optimise for when that is known,
 * else the objective's default, else purchases.
 *
 * `customEventType` comes from the AD SET (`promoted_object.custom_event_type`) — campaigns leave
 * `promoted_object` empty. Pass null when a campaign's ad sets disagree; there is no single honest
 * label for a campaign optimising two different conversions, and the objective default is the safer
 * answer than picking one arbitrarily.
 */
export function resultSpec(
  objective: string | null | undefined,
  customEventType?: string | null,
): ResultSpec {
  const byEvent = customEventType ? RESULT_BY_CUSTOM_EVENT[customEventType] : undefined;
  return byEvent ?? RESULT_BY_OBJECTIVE[objective ?? ""] ?? fromFamily("Purchases");
}

/**
 * The one conversion a campaign's ad sets agree on, or null when they disagree.
 *
 * Ad sets declaring no event are skipped rather than treated as disagreement, so one leftover
 * engagement ad set cannot mask an otherwise unanimous conversion event. Disagreement yields null so
 * the caller falls back to the objective: a campaign optimising two different conversions has no
 * single honest result label, and picking one of them would misreport the other.
 */
export function unanimousEvent(events: (string | null | undefined)[]): string | null {
  let found: string | null = null;
  for (const e of events) {
    if (!e) continue;
    if (found === null) found = e;
    else if (found !== e) return null;
  }
  return found;
}

/**
 * Read a result count using the first action type that is PRESENT, matching `canonicalEvents` and
 * `familyCount` so the headline result and the event breakdown can never disagree.
 *
 * `lookup` returns undefined for an action type Meta did not report — distinct from a reported zero,
 * which is a real "it fired zero times" and must stop the search.
 */
export function resultCount(
  spec: ResultSpec,
  lookup: (type: string) => number | undefined,
): number {
  for (const type of spec.types) {
    const v = lookup(type);
    if (v !== undefined) return Math.round(v);
  }
  return 0;
}

/** True when the result is the reach column rather than a conversion action. */
export function isReachSpec(spec: ResultSpec): boolean {
  return spec.types[0] === "reach";
}

/** Stable placeholder hue (0-359) derived from an id, for ads without a thumbnail. */
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
