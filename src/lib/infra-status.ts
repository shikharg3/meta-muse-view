/**
 * Status vocabularies for the infrastructure registry.
 *
 * Pure and client-safe: imports nothing, so route components and server fns share one definition.
 *
 * Per-entity vocabularies rather than one shared enum, because the words differ in kind — Facebook
 * *suspends* profiles and *restricts* BMs, and a pixel is never banned. The rule that keeps this from
 * sprawling: EVERY value must participate in at least one rule in `infra-risk.ts`. A status that
 * classifies nothing is invisible everywhere except its own badge, which is worse than not having it.
 *
 * `text` columns plus these guards, deliberately not `pgEnum`: migrations here are push-only, which
 * would make an enum change a manual `ALTER TYPE`.
 */

/** A Facebook personal profile used to administer BMs. */
export const PROFILE_STATUSES = [
  "new",
  "active",
  "in_review",
  "suspended",
  "banned",
  "retired",
] as const;

export const BM_STATUSES = [
  "pending_verification",
  "active",
  "in_review",
  "restricted",
  "banned",
] as const;

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
export type PixelStatus = (typeof PIXEL_STATUSES)[number];
export type PageStatus = (typeof PAGE_STATUSES)[number];
export type AdAccountUsage = (typeof AD_ACCOUNT_USAGE)[number];

/** The kinds addressable by `infra_status_events.kind`. */
export const INFRA_KINDS = ["profile", "bm", "ad_account", "pixel", "page"] as const;
export type InfraKind = (typeof INFRA_KINDS)[number];

function member<T extends readonly string[]>(
  vocab: T,
  value: string | null | undefined,
): value is T[number] {
  return value != null && (vocab as readonly string[]).includes(value);
}

export const isProfileStatus = (v: string | null | undefined): v is ProfileStatus =>
  member(PROFILE_STATUSES, v);
export const isBmStatus = (v: string | null | undefined): v is BmStatus => member(BM_STATUSES, v);
export const isPixelStatus = (v: string | null | undefined): v is PixelStatus =>
  member(PIXEL_STATUSES, v);
export const isPageStatus = (v: string | null | undefined): v is PageStatus =>
  member(PAGE_STATUSES, v);
export const isAdAccountUsage = (v: string | null | undefined): v is AdAccountUsage =>
  member(AD_ACCOUNT_USAGE, v);
export const isInfraKind = (v: string | null | undefined): v is InfraKind => member(INFRA_KINDS, v);
