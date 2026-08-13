/**
 * Status vocabularies for the infrastructure registry.
 *
 * Pure and client-safe: imports nothing, so route components and server fns share one definition.
 *
 * Per-entity vocabularies rather than one shared enum, because the words differ in kind — a profile
 * can be told to record a video selfie, a pixel cannot. The rule that keeps this from sprawling:
 * EVERY value must participate in at least one rule in `infra-risk.ts`. A status that classifies
 * nothing is invisible everywhere except its own badge, which is worse than not having it.
 *
 * `text` columns plus these guards, deliberately not `pgEnum`: migrations here are push-only, which
 * would make an enum change a manual `ALTER TYPE`.
 */

/**
 * Conditions on a Facebook personal profile. A profile carries a SET of these, not one — Meta can
 * restrict several capabilities at once, and "active but read only" is a real and common state.
 */
export const PROFILE_STATUSES = [
  "active",
  "video_selfie",
  "suspended",
  "in_review",
  "cannot_use_page",
  "cannot_use_ads_manager",
  "read_only",
] as const;

/**
 * Statuses that cost a profile its access, even alongside `active`.
 *
 * This is every status except `active` — a profile is an access path only when nothing at all is
 * flagged against it. `video_selfie` is included because an unmet verification request does gate the
 * profile in practice: Meta will keep prompting until the selfie is recorded, so the profile cannot be
 * relied on as the way back into a BM.
 *
 * Kept as its own list rather than derived from `PROFILE_STATUSES` so that adding a genuinely benign
 * status later is a deliberate omission here, not an accidental promotion to blocking.
 */
export const PROFILE_BLOCKING_STATUSES = [
  "video_selfie",
  "suspended",
  "in_review",
  "cannot_use_page",
  "cannot_use_ads_manager",
  "read_only",
] as const;

export const BM_STATUSES = ["active", "in_review", "suspended"] as const;

/** What the BM is for. Metadata, not health — it does not feed risk. */
export const BM_TYPES = ["verified", "non_verified", "used_for_dot_apps"] as const;

export const PIXEL_STATUSES = ["active", "inactive", "restricted"] as const;

export const PAGE_STATUSES = [
  "active",
  "in_review",
  "restricted",
  "banned",
  "unpublished",
] as const;

/** Operator-owned lifecycle for a registered ad account. Not a Meta concept. */
export const AD_ACCOUNT_USAGE = ["in_use", "spare", "retired"] as const;

export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export type BmStatus = (typeof BM_STATUSES)[number];
export type BmType = (typeof BM_TYPES)[number];
export type PixelStatus = (typeof PIXEL_STATUSES)[number];
export type PageStatus = (typeof PAGE_STATUSES)[number];
export type AdAccountUsage = (typeof AD_ACCOUNT_USAGE)[number];

/** The kinds addressable by `infra_status_events.kind`. */
export const INFRA_KINDS = ["profile", "bm", "ad_account", "pixel", "page"] as const;
export type InfraKind = (typeof INFRA_KINDS)[number];

/**
 * Display labels. Every vocabulary value needs one, asserted by a test — `StatusPill` would otherwise
 * render a raw identifier like `cannot_use_ads_manager` at an operator.
 */
export const INFRA_STATUS_LABEL: Record<string, string> = {
  // Profile
  active: "Active",
  video_selfie: "Video selfie",
  suspended: "Suspended",
  in_review: "In review",
  cannot_use_page: "Cannot use page",
  cannot_use_ads_manager: "Cannot use Ads Manager",
  read_only: "Read only",
  // BM type
  verified: "Verified",
  non_verified: "Non-verified",
  used_for_dot_apps: "Used for DOT apps",
  // Pixel
  inactive: "Inactive",
  restricted: "Restricted",
  // Page
  banned: "Banned",
  unpublished: "Unpublished",
  // Ad account usage
  in_use: "In use",
  spare: "Spare",
  retired: "Retired",
};

function member<T extends readonly string[]>(
  vocab: T,
  value: string | null | undefined,
): value is T[number] {
  return value != null && (vocab as readonly string[]).includes(value);
}

export const isProfileStatus = (v: string | null | undefined): v is ProfileStatus =>
  member(PROFILE_STATUSES, v);
export const isBmStatus = (v: string | null | undefined): v is BmStatus => member(BM_STATUSES, v);
export const isBmType = (v: string | null | undefined): v is BmType => member(BM_TYPES, v);
export const isPixelStatus = (v: string | null | undefined): v is PixelStatus =>
  member(PIXEL_STATUSES, v);
export const isPageStatus = (v: string | null | undefined): v is PageStatus =>
  member(PAGE_STATUSES, v);
export const isAdAccountUsage = (v: string | null | undefined): v is AdAccountUsage =>
  member(AD_ACCOUNT_USAGE, v);
export const isInfraKind = (v: string | null | undefined): v is InfraKind => member(INFRA_KINDS, v);

/**
 * Coerce a stored or submitted status set into a clean, ordered, deduped list.
 *
 * Falls back to `["suspended"]` rather than `["active"]` when nothing readable survives: an
 * unreadable status set must never make a profile count as an access path, because that would hide
 * risk instead of showing it. Ordering follows `PROFILE_STATUSES` so badges render consistently
 * regardless of the order boxes were ticked.
 */
export function parseProfileStatuses(input: unknown): ProfileStatus[] {
  const raw = Array.isArray(input) ? input : [];
  const kept = PROFILE_STATUSES.filter((s) => raw.includes(s));
  return kept.length > 0 ? [...kept] : ["suspended"];
}
