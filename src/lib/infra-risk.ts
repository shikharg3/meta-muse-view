/**
 * Risk classification for the infrastructure registry.
 *
 * Pure: takes already-fetched shapes, imports only the vocabularies. The read model in
 * `server/fns/infra/risk.ts` is the ONLY caller, so the dashboard counts and the risk map cannot
 * disagree — they are the same computation. Never re-derive risk in a component.
 *
 * Note what the foreign keys removed from this module: `rootBmStatus` and `ownerStatus` are not
 * nullable, because `infra_pixels.root_bm_id` and `infra_pages.owner_profile_id` are NOT NULL with
 * RESTRICT. There is no "missing root BM" case left to classify.
 *
 * BM risk and ad-account risk are `redundancy()` applied to a count — deliberately not wrapped in
 * `bmRisk()` / `adAccountRisk()` aliases, because the caller's count is the only difference and
 * `redundancy(usableProfiles)` says what the rule is where an alias would hide it.
 */
import type { BmStatus, PageStatus, PixelStatus, ProfileStatus } from "./infra-status";

export type RiskLevel = "critical" | "warning" | "safe";
export interface Risk {
  level: RiskLevel;
  label: string;
}

/** A BM unverified for longer than this shows an overdue marker. Not configurable by design. */
export const VERIFICATION_OVERDUE_DAYS = 30;

/** Sort order for risk-first lists. */
export const RISK_ORDER: Record<RiskLevel, number> = { critical: 0, warning: 1, safe: 2 };

/**
 * The product thesis, in three lines: two independent access paths means one ban cannot lock you out.
 * Applied to a BM's usable admin profiles and to an ad account's usable BMs.
 */
export function redundancy(paths: number): Risk {
  if (paths === 0) return { level: "critical", label: "No backup" };
  if (paths === 1) return { level: "warning", label: "Single access" };
  return { level: "safe", label: "Redundant" };
}

/** A profile is an access path only while it can actually log in. */
export function usableProfile(status: ProfileStatus): boolean {
  return status === "active" || status === "new";
}

/**
 * A BM is an access path only while it is usable. `pending_verification` still works; `in_review`,
 * `restricted` and `banned` are not paths you can rely on as a backup.
 */
export function usableBm(status: BmStatus): boolean {
  return status === "active" || status === "pending_verification";
}

/** Ordered; first match wins. */
export function pixelRisk(input: {
  status: PixelStatus;
  rootBmStatus: BmStatus;
  shareCount: number;
}): Risk {
  if (!usableBm(input.rootBmStatus)) return { level: "critical", label: "Root BM unusable" };
  if (input.status === "restricted") return { level: "warning", label: "Restricted" };
  if (input.status === "inactive") return { level: "warning", label: "Inactive" };
  if (input.shareCount === 0) return { level: "warning", label: "Not shared" };
  return { level: "safe", label: "Shared" };
}

/** Ordered; first match wins. */
export function pageRisk(input: {
  status: PageStatus;
  ownerStatus: ProfileStatus;
  bmCount: number;
  profileCount: number;
}): Risk {
  if (!usableProfile(input.ownerStatus)) return { level: "critical", label: "No active owner" };
  if (input.status === "banned") return { level: "critical", label: "Banned" };
  if (input.status === "restricted") return { level: "warning", label: "Restricted" };
  if (input.status === "in_review") return { level: "warning", label: "In review" };
  if (input.status === "unpublished") return { level: "warning", label: "Unpublished" };
  if (input.bmCount === 0 && input.profileCount === 0) {
    return { level: "warning", label: "No added access" };
  }
  return { level: "safe", label: "Added" };
}

/** Never verified counts as overdue: an unattested BM is exactly what needs attention. */
export function isVerificationOverdue(verifiedAt: Date | null, now: Date): boolean {
  if (!verifiedAt) return true;
  return (now.getTime() - verifiedAt.getTime()) / 86_400_000 > VERIFICATION_OVERDUE_DAYS;
}
