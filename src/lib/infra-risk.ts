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
import {
  INFRA_STATUS_LABEL,
  PROFILE_BLOCKING_STATUSES,
  type BmStatus,
  type PageStatus,
  type PixelStatus,
  type ProfileStatus,
} from "./infra-status";

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

/**
 * A profile is an access path only while it is active AND nothing has taken its access away.
 *
 * The set matters: Meta commonly leaves a profile flagged `active` while stripping a capability, so
 * `active` alone is not evidence of access. Every other status blocks, `video_selfie` included — see
 * PROFILE_BLOCKING_STATUSES.
 */
export function usableProfile(statuses: readonly ProfileStatus[]): boolean {
  if (!statuses.includes("active")) return false;
  return !statuses.some((s) => (PROFILE_BLOCKING_STATUSES as readonly string[]).includes(s));
}

/** A BM is an access path only while active; `in_review` and `suspended` cannot be relied on. */
export function usableBm(status: BmStatus): boolean {
  return status === "active";
}

/**
 * Why a profile is not an access path, as operator-facing labels — empty exactly when
 * `usableProfile` is true.
 *
 * The registry deliberately accepts restricted assets: the operator registers the profile they
 * actually have, and the UI names the condition rather than hiding the profile. That only works if
 * this mirrors `usableProfile` branch for branch, which a test pins.
 *
 * Ordered by `PROFILE_BLOCKING_STATUSES`, not by the caller's array, so the same two conditions
 * always read the same way whatever order they were recorded in.
 */
export function profileIssues(statuses: readonly ProfileStatus[]): string[] {
  const blocking = PROFILE_BLOCKING_STATUSES.filter((s) => statuses.includes(s)).map(
    (s) => INFRA_STATUS_LABEL[s] ?? s,
  );
  if (blocking.length > 0) return blocking;
  // Nothing blocking is flagged, so the only fault left is a set that never claims `active`.
  return statuses.includes("active") ? [] : ["Not active"];
}

/** Why a BM is not an access path, or `null` while it is one. Mirrors `usableBm`. */
export function bmIssue(status: BmStatus): string | null {
  return usableBm(status) ? null : (INFRA_STATUS_LABEL[status] ?? status);
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
  ownerStatuses: readonly ProfileStatus[];
  bmCount: number;
  profileCount: number;
}): Risk {
  if (!usableProfile(input.ownerStatuses)) return { level: "critical", label: "No active owner" };
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
