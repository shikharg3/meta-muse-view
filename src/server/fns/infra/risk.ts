import { db, schema } from "@/db/client";
import { buildInfraGraph, nodeId, reachedFrom, type InfraGraph } from "@/lib/infra-graph";
import {
  buildRiskSummary,
  type AccessConcentration,
  type InfraRiskSummary,
  type RiskTallyRow,
} from "@/lib/infra-summary";
import {
  RISK_ORDER,
  isVerificationOverdue,
  pageRisk,
  pixelRisk,
  profileRisk,
  redundancy,
  usableBm,
  usableProfile,
  type Risk,
} from "@/lib/infra-risk";
import {
  PROFILE_BLOCKING_STATUSES,
  isBmStatus,
  isPageStatus,
  isPixelStatus,
  parseProfileStatuses,
  type BmStatus,
  type ProfileStatus,
} from "@/lib/infra-status";
import { requireAdmin } from "../auth";

export interface InfraRiskRow {
  id: string;
  name: string;
  /** The entity's own status, shown alongside its risk — they answer different questions. */
  status: string;
  risk: Risk;
  /** Human summary of the access paths behind the verdict. */
  detail: string;
  /** BMs only: verification is overdue. */
  overdue?: boolean;
  /**
   * BMs only: what this BM is the last live path to, so the row can say what the ban costs rather
   * than only that it would hurt. Zeroes are informative — "strands nothing" is an answer.
   */
  strands?: { adAccounts: number; pixels: number; pages: number };
  /**
   * BMs and profiles only: the operator marked this as one of the ones that matter. Display priority,
   * never a risk input — `redundancy()` and friends cannot see it.
   */
  main?: boolean;
}

export interface InfraRiskMap {
  counts: { profiles: number; bms: number; adAccounts: number; pixels: number; pages: number };
  /** Non-safe assets. Profiles are excluded by design — see `buildRiskSummary`. */
  atRisk: number;
  /** The risk matrix, one row per entity type. */
  tally: RiskTallyRow[];
  /** The profile whose ban would cascade furthest, or null when no profile solely holds two BMs. */
  concentration: AccessConcentration | null;
  /** Counts for the operator's starred BMs and profiles — see `buildRiskSummary`. */
  main: InfraRiskSummary["main"];
  bms: InfraRiskRow[];
  adAccounts: InfraRiskRow[];
  pixels: InfraRiskRow[];
  pages: InfraRiskRow[];
  /** Access paths, not assets: shown as their own matrix line and never counted in `atRisk`. */
  profiles: InfraRiskRow[];
  /**
   * The same registry as a drawn access graph. Built from these very rows, so the map and the tables
   * can never disagree — they are one read.
   */
  graph: InfraGraph;
}

/**
 * The whole registry, classified.
 *
 * Ten selects joined in memory: the registry is a few hundred rows, so this is simpler and far easier
 * to test than clever SQL, and it keeps every risk rule in one pure module. If this ever passes a few
 * thousand rows, push the counting into SQL before reaching for pagination.
 *
 * Unguarded on purpose — `fetchRiskMap` is the authorised boundary. This inner function exists so the
 * DB-backed tests can exercise the real queries without a session cookie, rather than the guard being
 * weakened to make a test pass.
 *
 * A status failing its guard falls back to the most alarming interpretation instead of being dropped:
 * a row with a corrupt status is precisely what an operator needs to see.
 */
export async function buildRiskMap(): Promise<InfraRiskMap> {
  const [profiles, bms, adAccounts, pixels, pages] = await Promise.all([
    db.select().from(schema.infraProfiles),
    db.select().from(schema.infraBusinessManagers),
    db.select().from(schema.infraAdAccounts),
    db.select().from(schema.infraPixels),
    db.select().from(schema.infraPages),
  ]);
  const [profileBm, bmAccount, pixelBm, pageBm, pageProfile] = await Promise.all([
    db.select().from(schema.infraProfileBm),
    db.select().from(schema.infraBmAdAccount),
    db.select().from(schema.infraPixelBm),
    db.select().from(schema.infraPageBm),
    db.select().from(schema.infraPageProfile),
  ]);

  // A row whose set is unreadable parses to `suspended`, so it can never count as an access path.
  const profileStatuses = new Map<string, ProfileStatus[]>(
    profiles.map((p) => [p.id, parseProfileStatuses(p.statuses)]),
  );
  const bmStatus = new Map<string, BmStatus>(
    bms.map((b) => [b.id, isBmStatus(b.status) ? b.status : "suspended"]),
  );
  const bmName = new Map(bms.map((b) => [b.id, b.name]));

  const usableProfilesPerBm = new Map<string, number>();
  for (const link of profileBm) {
    const statuses = profileStatuses.get(link.profileId);
    if (statuses && usableProfile(statuses)) {
      usableProfilesPerBm.set(link.bmId, (usableProfilesPerBm.get(link.bmId) ?? 0) + 1);
    }
  }

  const usableBmsPerAccount = new Map<string, number>();
  const bmNamesPerAccount = new Map<string, string[]>();
  for (const link of bmAccount) {
    const names = bmNamesPerAccount.get(link.adAccountId) ?? [];
    names.push(bmName.get(link.bmId) ?? link.bmId);
    bmNamesPerAccount.set(link.adAccountId, names);
    const status = bmStatus.get(link.bmId);
    if (status && usableBm(status)) {
      usableBmsPerAccount.set(
        link.adAccountId,
        (usableBmsPerAccount.get(link.adAccountId) ?? 0) + 1,
      );
    }
  }

  const sharesPerPixel = new Map<string, number>();
  for (const link of pixelBm) {
    sharesPerPixel.set(link.pixelId, (sharesPerPixel.get(link.pixelId) ?? 0) + 1);
  }
  const bmsPerPage = new Map<string, number>();
  for (const link of pageBm) bmsPerPage.set(link.pageId, (bmsPerPage.get(link.pageId) ?? 0) + 1);
  const profilesPerPage = new Map<string, number>();
  for (const link of pageProfile) {
    profilesPerPage.set(link.pageId, (profilesPerPage.get(link.pageId) ?? 0) + 1);
  }

  // Profiles are graph nodes, not a risk table, so these counts exist only to tell an unusable
  // profile that strands something from one that is merely a dead registry entry.
  const bmsPerProfile = new Map<string, number>();
  for (const link of profileBm) {
    bmsPerProfile.set(link.profileId, (bmsPerProfile.get(link.profileId) ?? 0) + 1);
  }
  const pagesOwnedPerProfile = new Map<string, number>();
  for (const p of pages) {
    pagesOwnedPerProfile.set(
      p.ownerProfileId,
      (pagesOwnedPerProfile.get(p.ownerProfileId) ?? 0) + 1,
    );
  }

  const now = new Date();
  const byRisk = (a: InfraRiskRow, b: InfraRiskRow) =>
    RISK_ORDER[a.risk.level] - RISK_ORDER[b.risk.level] || a.name.localeCompare(b.name);

  const bmRows: InfraRiskRow[] = bms
    .map((b) => {
      const usable = usableProfilesPerBm.get(b.id) ?? 0;
      return {
        id: b.id,
        name: b.name,
        status: b.status,
        risk: redundancy(usable),
        detail: `${usable} usable profile${usable === 1 ? "" : "s"}`,
        overdue: isVerificationOverdue(b.verifiedAt, now),
        main: b.isMain,
      };
    })
    .sort(byRisk);

  // `retired` accounts are excluded: a retired account with no access path is not a problem to solve.
  const accountRows: InfraRiskRow[] = adAccounts
    .filter((a) => a.usageState !== "retired")
    .map((a) => {
      const usable = usableBmsPerAccount.get(a.id) ?? 0;
      const names = bmNamesPerAccount.get(a.id) ?? [];
      return {
        id: a.id,
        name: a.label?.trim() || a.id,
        status: a.usageState,
        risk: redundancy(usable),
        detail: names.length ? `via ${names.join(", ")}` : "no BM linked",
      };
    })
    .sort(byRisk);

  const pixelRows: InfraRiskRow[] = pixels
    .map((p) => {
      const shares = sharesPerPixel.get(p.id) ?? 0;
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        risk: pixelRisk({
          status: isPixelStatus(p.status) ? p.status : "restricted",
          rootBmStatus: bmStatus.get(p.rootBmId) ?? "suspended",
          shareCount: shares,
        }),
        detail: `root ${bmName.get(p.rootBmId) ?? p.rootBmId} · ${shares} share${shares === 1 ? "" : "s"}`,
      };
    })
    .sort(byRisk);

  const pageRows: InfraRiskRow[] = pages
    .map((p) => {
      const bmCount = bmsPerPage.get(p.id) ?? 0;
      const profileCount = profilesPerPage.get(p.id) ?? 0;
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        risk: pageRisk({
          status: isPageStatus(p.status) ? p.status : "restricted",
          ownerStatuses: profileStatuses.get(p.ownerProfileId) ?? ["suspended"],
          bmCount,
          profileCount,
        }),
        detail: `${bmCount} BM${bmCount === 1 ? "" : "s"} · ${profileCount} extra profile${profileCount === 1 ? "" : "s"}`,
      };
    })
    .sort(byRisk);

  // The graph reuses the verdicts computed above rather than reclassifying anything; the two lookups
  // exist only to carry the structural foreign keys the risk rows have no reason to hold.
  const pixelRowById = new Map(pixelRows.map((r) => [r.id, r]));
  const pageRowById = new Map(pageRows.map((r) => [r.id, r]));
  // Hoisted out of the graph call because the profile rows on the screen and the profile nodes on
  // the map are the same classification, and computing it twice is how two screens start disagreeing.
  const profileEntities = profiles.map((p) => {
    const statuses = profileStatuses.get(p.id) ?? ["suspended"];
    const usable = usableProfile(statuses);
    const bmCount = bmsPerProfile.get(p.id) ?? 0;
    const owned = pagesOwnedPerProfile.get(p.id) ?? 0;
    return {
      id: p.id,
      name: p.name,
      // The first blocking status is the reason this profile is not an access path. The full set
      // is one click away on the profiles page; a row has room for the reason, not the list.
      status:
        statuses.find((s) => (PROFILE_BLOCKING_STATUSES as readonly string[]).includes(s)) ??
        "active",
      risk: profileRisk({ usable, dependents: bmCount + owned }),
      detail: `${bmCount} BM${bmCount === 1 ? "" : "s"} · ${owned} page${owned === 1 ? "" : "s"} owned`,
      main: p.isMain,
      usable,
    };
  });

  const graph = buildInfraGraph({
    profiles: profileEntities,
    bms: bmRows.map((r) => ({
      ...r,
      overdue: r.overdue ?? false, // optional on the row (BMs only); definite on a BM node
      usable: usableBm(bmStatus.get(r.id) ?? "suspended"),
    })),
    adAccounts: accountRows,
    pixels: pixels.flatMap((p) => {
      const row = pixelRowById.get(p.id);
      return row ? [{ ...row, rootBmId: p.rootBmId }] : [];
    }),
    pages: pages.flatMap((p) => {
      const row = pageRowById.get(p.id);
      return row ? [{ ...row, ownerProfileId: p.ownerProfileId }] : [];
    }),
    profileBm,
    bmAdAccount: bmAccount,
    pixelBm,
    pageBm,
    pageProfile,
  });

  const summary = buildRiskSummary(graph, {
    profile: profiles.length,
    bm: bms.length,
    adAccount: adAccounts.length,
    pixel: pixels.length,
    page: pages.length,
  });

  return {
    counts: {
      profiles: profiles.length,
      bms: bms.length,
      adAccounts: adAccounts.length,
      pixels: pixels.length,
      pages: pages.length,
    },
    atRisk: summary.atRisk,
    tally: summary.tally,
    concentration: summary.concentration,
    main: summary.main,
    // `strands` needs the finished graph, so it is attached here rather than where the row is built.
    bms: bmRows.map((r) => {
      const reached = reachedFrom(graph, nodeId("bm", r.id));
      return {
        ...r,
        strands: {
          adAccounts: reached.adAccount.filter((a) => !a.otherLivePaths).length,
          pixels: reached.pixel.filter((a) => !a.otherLivePaths).length,
          pages: reached.page.filter((a) => !a.otherLivePaths).length,
        },
      };
    }),
    adAccounts: accountRows,
    pixels: pixelRows,
    pages: pageRows,
    profiles: profileEntities
      .map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        risk: p.risk,
        detail: p.detail,
        main: p.main,
      }))
      .sort(byRisk),
    graph,
  };
}

/** Authorised entry point. The guard is the whole reason this wrapper exists. */
export async function fetchRiskMap(): Promise<InfraRiskMap> {
  await requireAdmin();
  return buildRiskMap();
}
