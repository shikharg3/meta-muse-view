import { db, schema } from "@/db/client";
import {
  RISK_ORDER,
  isVerificationOverdue,
  pageRisk,
  pixelRisk,
  redundancy,
  usableBm,
  usableProfile,
  type Risk,
} from "@/lib/infra-risk";
import {
  isBmStatus,
  isPageStatus,
  isPixelStatus,
  isProfileStatus,
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
}

export interface InfraRiskMap {
  counts: { profiles: number; bms: number; adAccounts: number; pixels: number; pages: number };
  atRisk: number;
  bms: InfraRiskRow[];
  adAccounts: InfraRiskRow[];
  pixels: InfraRiskRow[];
  pages: InfraRiskRow[];
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

  const profileStatus = new Map<string, ProfileStatus>(
    profiles.map((p) => [p.id, isProfileStatus(p.status) ? p.status : "banned"]),
  );
  const bmStatus = new Map<string, BmStatus>(
    bms.map((b) => [b.id, isBmStatus(b.status) ? b.status : "banned"]),
  );
  const bmName = new Map(bms.map((b) => [b.id, b.name]));

  const usableProfilesPerBm = new Map<string, number>();
  for (const link of profileBm) {
    const status = profileStatus.get(link.profileId);
    if (status && usableProfile(status)) {
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
          rootBmStatus: bmStatus.get(p.rootBmId) ?? "banned",
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
          ownerStatus: profileStatus.get(p.ownerProfileId) ?? "banned",
          bmCount,
          profileCount,
        }),
        detail: `${bmCount} BM${bmCount === 1 ? "" : "s"} · ${profileCount} extra profile${profileCount === 1 ? "" : "s"}`,
      };
    })
    .sort(byRisk);

  return {
    counts: {
      profiles: profiles.length,
      bms: bms.length,
      adAccounts: adAccounts.length,
      pixels: pixels.length,
      pages: pages.length,
    },
    atRisk: [...bmRows, ...accountRows, ...pixelRows, ...pageRows].filter(
      (r) => r.risk.level !== "safe",
    ).length,
    bms: bmRows,
    adAccounts: accountRows,
    pixels: pixelRows,
    pages: pageRows,
  };
}

/** Authorised entry point. The guard is the whole reason this wrapper exists. */
export async function fetchRiskMap(): Promise<InfraRiskMap> {
  await requireAdmin();
  return buildRiskMap();
}
