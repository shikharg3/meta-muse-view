/**
 * Derives the delivery half of the Notion board's `Account Status` column from Meta.
 *
 * Pure by design: the caller passes already-fetched rows and two pre-computed booleans per account,
 * so this module imports nothing from `sync/`, `db/` or `server/`. `canDeliver` and `accountStatus`
 * stay where they live; pulling them in here would invert the layering.
 *
 * Machine-owned and human-owned values are DISJOINT. That is the load-bearing property of the whole
 * feature: the value sitting on the board says who owns it, so no timestamps, no last-writer column
 * and no provenance bookkeeping are needed. Never add a value to both sets.
 */

/** Delivery states the machine owns and may overwrite. */
export const MACHINE_STATUSES = [
  "Live",
  "Paused",
  "Ad Account Disabled",
  "Ad Account Blocked",
  "All ads rejected",
] as const;

/** Commercial lifecycle states only a human can know. The machine never writes these. */
export const HUMAN_STATUSES = [
  "On Boarding",
  "Not started",
  "Full Budget Finished",
  "Budget Finished - Top Up",
] as const;

export type MachineStatus = (typeof MACHINE_STATUSES)[number];
export type HumanStatus = (typeof HUMAN_STATUSES)[number];

export function isMachineStatus(value: string | null | undefined): value is MachineStatus {
  return value != null && (MACHINE_STATUSES as readonly string[]).includes(value);
}

/** One ad account, reduced to the two facts the ladder needs. */
export interface StatusAccount {
  /** `accountStatus(raw) === "DISABLED"`. */
  disabled: boolean;
  /** `canDeliver(account)` — active AND with prepaid headroom left. */
  deliverable: boolean;
}

export interface StatusCampaign {
  id: string;
  /** `effective_status === "ACTIVE"`. */
  active: boolean;
}

export interface StatusAdSet {
  id: string;
  campaignId: string;
  active: boolean;
}

export interface StatusAd {
  adSetId: string;
  /** `effective_status === "DISAPPROVED"`. WITH_ISSUES and PENDING_REVIEW are different states. */
  disapproved: boolean;
}

export interface StatusInput {
  accounts: StatusAccount[];
  campaigns: StatusCampaign[];
  adSets: StatusAdSet[];
  ads: StatusAd[];
}

/**
 * The ladder. Returns null when the inputs cannot support a verdict — a missing child collection is a
 * sync gap, not a delivery state, and silence is the only honest answer.
 *
 * Account-level rungs precede campaign-level ones because Meta stops delivery at the account level
 * while campaigns keep reporting ACTIVE.
 *
 * Every `every()` and every "none are active" test below is guarded by a non-empty check, because
 * both are vacuously TRUE on an empty collection and would otherwise produce a confident wrong value.
 */
export function deriveStatus(input: StatusInput): MachineStatus | null {
  const { accounts, campaigns, adSets, ads } = input;

  if (accounts.length === 0 || campaigns.length === 0) return null;
  if (accounts.every((a) => a.disabled)) return "Ad Account Disabled";
  if (!accounts.some((a) => a.deliverable)) return "Ad Account Blocked";

  const activeCampaignIds = new Set(campaigns.filter((c) => c.active).map((c) => c.id));
  if (activeCampaignIds.size === 0) return "Paused";

  const setsUnderActive = adSets.filter((s) => activeCampaignIds.has(s.campaignId));
  if (setsUnderActive.length === 0) return null;

  const activeSetIds = new Set(setsUnderActive.filter((s) => s.active).map((s) => s.id));
  if (activeSetIds.size === 0) return "Paused";

  const adsUnderActive = ads.filter((a) => activeSetIds.has(a.adSetId));
  if (adsUnderActive.length === 0) return null;
  if (adsUnderActive.every((a) => a.disapproved)) return "All ads rejected";

  return "Live";
}
