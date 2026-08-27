/**
 * Faceted filtering and URL export for the Pages registry screen.
 *
 * Pure: takes already-fetched row shapes plus name lookups, imports only the vocabularies and the
 * risk rules. `routes/infrastructure.pages.tsx` is the only caller and keeps nothing but state and
 * markup, which is what makes these rules testable — the repo has no component-test harness.
 *
 * Risk is decorated onto a row here rather than computed in a table cell, so the badge an operator
 * reads and the facet they filter by are the same value.
 */
import { RISK_ORDER, pageRisk, usableProfile, type Risk } from "./infra-risk";
import {
  INFRA_STATUS_LABEL,
  PAGE_STATUSES,
  isPageStatus,
  type ProfileStatus,
} from "./infra-status";

/**
 * Sentinel option values. Real ids are `randomUUID()`, so no collision is possible.
 *
 * `FACET_NONE` reads as "no BM access" in the BM facet and "owner only" in the profiles facet —
 * the same predicate (an empty link list) in both, labelled for its column.
 */
export const FACET_NONE = "__none__";
/** An `ownerProfileId` that resolves to no registered profile. */
export const FACET_UNKNOWN = "__unknown__";

/** The row fields the facets read. Structurally satisfied by `PageView`. */
export interface PageFacetInput {
  status: string;
  ownerProfileId: string;
  bmIds: readonly string[];
  profileIds: readonly string[];
}

export interface PageDecoration {
  risk: Risk;
  /** The owner's statuses, or the worst case when the owner does not resolve. */
  ownerStatuses: readonly ProfileStatus[];
  ownerUsable: boolean;
  ownerName: string | null;
  /** The owner id, or `FACET_UNKNOWN` — what both the facet and its option list key on. */
  ownerKey: string;
  /** `pageUrl` with a scheme, or null when the page has no URL. */
  href: string | null;
}

export type PageFacetRow = PageFacetInput & PageDecoration;

export type FacetKey = "status" | "owner" | "bm" | "risk" | "profiles";

export const FACET_KEYS: readonly FacetKey[] = ["status", "owner", "bm", "risk", "profiles"];

export const FACET_LABEL: Record<FacetKey, string> = {
  status: "Status",
  owner: "Owner",
  bm: "Linked BM",
  risk: "Risk",
  profiles: "Profiles",
};

export type Facets = Record<FacetKey, string[]>;

export const NO_FACETS: Facets = { status: [], owner: [], bm: [], risk: [], profiles: [] };

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/** A page whose owner is gone is treated as the worst case, never ignored. */
const MISSING_OWNER: readonly ProfileStatus[] = ["suspended"];

const RISK_LABEL: Record<Risk["level"], string> = {
  critical: "Critical",
  warning: "Warning",
  safe: "Safe",
};

/**
 * `pageUrl` with a scheme. Values are typed by hand and usually lack one, so an exported list would
 * not be clickable without this. Null for a blank URL — `pageUrl` is NOT NULL and required by the
 * form, but empty strings exist in older rows.
 */
export function pageHref(pageUrl: string): string | null {
  const trimmed = pageUrl.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Attach risk, owner resolution and the outbound href to every row, once.
 *
 * `ownerOf` returns undefined for an owner that no longer exists; an unrecognized status coerces to
 * `restricted` for risk purposes, the same conservative reading the screen has always used.
 */
export function decoratePages<T extends PageFacetInput & { pageUrl: string }>(
  pages: readonly T[],
  ownerOf: (id: string) => { name: string; statuses: readonly ProfileStatus[] } | undefined,
): (T & PageDecoration)[] {
  return pages.map((row) => {
    const owner = ownerOf(row.ownerProfileId);
    const ownerStatuses = owner ? owner.statuses : MISSING_OWNER;
    return {
      ...row,
      ownerStatuses,
      ownerUsable: usableProfile(ownerStatuses),
      ownerName: owner?.name ?? null,
      ownerKey: owner ? row.ownerProfileId : FACET_UNKNOWN,
      href: pageHref(row.pageUrl),
      risk: pageRisk({
        status: isPageStatus(row.status) ? row.status : "restricted",
        ownerStatuses,
        bmCount: row.bmIds.length,
        profileCount: row.profileIds.length,
      }),
    };
  });
}

/** OR within a facet. An empty selection is not a filter. */
export function matchesFacet(
  row: PageFacetRow,
  key: FacetKey,
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return true;
  switch (key) {
    case "status":
      return selected.includes(row.status);
    case "owner":
      return selected.includes(row.ownerKey);
    case "risk":
      return selected.includes(row.risk.level);
    case "bm":
      return matchesLinks(row.bmIds, selected);
    case "profiles":
      return matchesLinks(row.profileIds, selected);
  }
}

function matchesLinks(linked: readonly string[], selected: readonly string[]): boolean {
  if (linked.length === 0) return selected.includes(FACET_NONE);
  return linked.some((id) => selected.includes(id));
}

/**
 * AND across facets. `except` drops one facet from the conjunction — that is how a facet's own
 * option counts are taken, so an unselected value never shows `0` merely because a sibling value in
 * the same facet is selected.
 */
export function filterByFacets<T extends PageFacetRow>(
  rows: readonly T[],
  facets: Facets,
  except?: FacetKey,
): T[] {
  return rows.filter((row) =>
    FACET_KEYS.every((key) => key === except || matchesFacet(row, key, facets[key])),
  );
}

/**
 * The five option lists, each counted over the rows passing the search and every *other* facet.
 *
 * Fixed vocabularies (status, risk) list every value, because `banned · 0` is information. Entity
 * facets list only ids present in the data, because offering one of sixty registered profiles that
 * owns no page guarantees an empty table.
 *
 * A currently selected value is always offered, even at zero: it is scoped away by the other facets
 * that its own count deliberately ignores, and an option that disappears while checked cannot be
 * unchecked.
 */
export function facetOptions(
  rows: readonly PageFacetRow[],
  facets: Facets,
  names: { profile: (id: string) => string | undefined; bm: (id: string) => string | undefined },
): Record<FacetKey, FacetOption[]> {
  const tallyFor = (key: FacetKey, valuesOf: (row: PageFacetRow) => readonly string[]) =>
    tally(filterByFacets(rows, facets, key), valuesOf, facets[key]);

  const statusCounts = tallyFor("status", (r) => [r.status]);
  const extraStatuses = [...statusCounts.keys()].filter((s) => !isPageStatus(s)).sort();
  const status = [...PAGE_STATUSES, ...extraStatuses].map((s) => ({
    value: s,
    label: INFRA_STATUS_LABEL[s] ?? s,
    count: statusCounts.get(s) ?? 0,
  }));

  const riskCounts = tallyFor("risk", (r) => [r.risk.level]);
  const risk = (Object.keys(RISK_ORDER) as Risk["level"][])
    .sort((a, b) => RISK_ORDER[a] - RISK_ORDER[b])
    .map((level) => ({
      value: level,
      label: RISK_LABEL[level],
      count: riskCounts.get(level) ?? 0,
    }));

  const owner = entityOptions(
    tallyFor("owner", (r) => [r.ownerKey]),
    (id) => names.profile(id),
    "unknown owner",
  );

  const bm = entityOptions(
    tallyFor("bm", (r) => (r.bmIds.length === 0 ? [FACET_NONE] : r.bmIds)),
    (id) => names.bm(id),
    null,
    "no BM access",
  );

  const profiles = entityOptions(
    tallyFor("profiles", (r) => (r.profileIds.length === 0 ? [FACET_NONE] : r.profileIds)),
    (id) => names.profile(id),
    null,
    "owner only",
  );

  return { status, owner, bm, risk, profiles };
}

/** `seed` values are entered at zero so a checked option cannot vanish from its own list. */
function tally(
  rows: readonly PageFacetRow[],
  valuesOf: (row: PageFacetRow) => readonly string[],
  seed: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of seed) counts.set(value, 0);
  for (const row of rows) {
    for (const value of valuesOf(row)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * Named entities sorted A→Z, with the sentinel pinned: `no BM access` / `owner only` leads because
 * "which pages have no added access" is the question the screen exists to answer, while
 * `unknown owner` trails because it is a data defect, not a filter target.
 */
function entityOptions(
  counts: Map<string, number>,
  nameOf: (id: string) => string | undefined,
  unknownLabel: string | null,
  noneLabel: string | null = null,
): FacetOption[] {
  const named: FacetOption[] = [];
  let none: FacetOption | null = null;
  let unknown: FacetOption | null = null;
  for (const [value, count] of counts) {
    if (value === FACET_NONE) none = { value, label: noneLabel ?? "none", count };
    else if (value === FACET_UNKNOWN) unknown = { value, label: unknownLabel ?? "unknown", count };
    else named.push({ value, label: nameOf(value) ?? value, count });
  }
  named.sort((a, b) => a.label.localeCompare(b.label));
  return [...(none ? [none] : []), ...named, ...(unknown ? [unknown] : [])];
}

/**
 * The export payload: one normalized URL per line, in the order given.
 *
 * `missing` is reported rather than silently dropped — an operator handing over eleven URLs for
 * twelve selected pages needs to know which count is which.
 */
export function pageUrlExport(rows: readonly { pageUrl: string }[]): {
  urls: string[];
  text: string;
  missing: number;
} {
  const urls: string[] = [];
  let missing = 0;
  for (const row of rows) {
    const href = pageHref(row.pageUrl);
    if (href) urls.push(href);
    else missing += 1;
  }
  return { urls, text: urls.join("\n"), missing };
}
