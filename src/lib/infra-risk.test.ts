import { describe, expect, test } from "bun:test";
import { BM_STATUSES, PROFILE_STATUSES, type PageStatus, type PixelStatus } from "./infra-status";
import {
  VERIFICATION_OVERDUE_DAYS,
  isVerificationOverdue,
  pageRisk,
  pixelRisk,
  redundancy,
  usableBm,
  usableProfile,
} from "./infra-risk";

describe("redundancy", () => {
  test("zero access paths is critical", () => {
    expect(redundancy(0)).toEqual({ level: "critical", label: "No backup" });
  });

  test("exactly one access path is a warning", () => {
    expect(redundancy(1)).toEqual({ level: "warning", label: "Single access" });
  });

  test("two access paths is safe — the threshold the whole feature exists for", () => {
    expect(redundancy(2)).toEqual({ level: "safe", label: "Redundant" });
  });

  test("more than two stays safe", () => {
    expect(redundancy(7)).toEqual({ level: "safe", label: "Redundant" });
  });
});

describe("usableProfile", () => {
  test("only active and new profiles provide access", () => {
    const expected: Record<(typeof PROFILE_STATUSES)[number], boolean> = {
      new: true,
      active: true,
      in_review: false,
      suspended: false,
      banned: false,
      retired: false,
    };
    for (const s of PROFILE_STATUSES) expect(usableProfile(s)).toBe(expected[s]);
  });
});

describe("usableBm", () => {
  test("only active and pending_verification BMs are access paths", () => {
    const expected: Record<(typeof BM_STATUSES)[number], boolean> = {
      pending_verification: true,
      active: true,
      in_review: false,
      restricted: false,
      banned: false,
    };
    for (const s of BM_STATUSES) expect(usableBm(s)).toBe(expected[s]);
  });
});

describe("BM access paths", () => {
  test("a BM whose only three profiles are unusable reads critical", () => {
    const profiles = ["suspended", "banned", "in_review"] as const;
    expect(redundancy(profiles.filter(usableProfile).length)).toEqual({
      level: "critical",
      label: "No backup",
    });
  });
});

describe("ad account access paths", () => {
  test("an account reachable only through a banned BM is critical, not safe", () => {
    // The bug this rule fixes: counting raw links scores this account safe.
    const linked = ["banned"] as const;
    expect(redundancy(linked.filter(usableBm).length)).toEqual({
      level: "critical",
      label: "No backup",
    });
  });

  test("two live BMs is safe", () => {
    const linked = ["active", "pending_verification"] as const;
    expect(redundancy(linked.filter(usableBm).length)).toEqual({
      level: "safe",
      label: "Redundant",
    });
  });
});

describe("pixelRisk precedence", () => {
  test("an unusable root BM beats every other signal", () => {
    expect(pixelRisk({ status: "active", rootBmStatus: "banned", shareCount: 5 })).toEqual({
      level: "critical",
      label: "Root BM unusable",
    });
  });

  test("restricted beats not-shared", () => {
    expect(pixelRisk({ status: "restricted", rootBmStatus: "active", shareCount: 0 })).toEqual({
      level: "warning",
      label: "Restricted",
    });
  });

  test("zero shares is a warning even when everything else is healthy", () => {
    expect(pixelRisk({ status: "active", rootBmStatus: "active", shareCount: 0 })).toEqual({
      level: "warning",
      label: "Not shared",
    });
  });

  test("every pixel status is classified — a new status cannot become dead", () => {
    const expected: Record<PixelStatus, { level: string; label: string }> = {
      active: { level: "safe", label: "Shared" },
      inactive: { level: "warning", label: "Inactive" },
      restricted: { level: "warning", label: "Restricted" },
    };
    for (const status of Object.keys(expected) as PixelStatus[]) {
      expect(pixelRisk({ status, rootBmStatus: "active", shareCount: 1 })).toEqual(
        expected[status],
      );
    }
  });
});

describe("pageRisk precedence", () => {
  test("an unusable owner beats a banned page", () => {
    expect(
      pageRisk({ status: "banned", ownerStatus: "suspended", bmCount: 3, profileCount: 3 }),
    ).toEqual({ level: "critical", label: "No active owner" });
  });

  test("no added access is a warning when the page itself is healthy", () => {
    expect(
      pageRisk({ status: "active", ownerStatus: "active", bmCount: 0, profileCount: 0 }),
    ).toEqual({ level: "warning", label: "No added access" });
  });

  test("one additional profile and no BM still counts as added access", () => {
    expect(
      pageRisk({ status: "active", ownerStatus: "active", bmCount: 0, profileCount: 1 }),
    ).toEqual({ level: "safe", label: "Added" });
  });

  test("every page status is classified — a new status cannot become dead", () => {
    const expected: Record<PageStatus, { level: string; label: string }> = {
      active: { level: "safe", label: "Added" },
      in_review: { level: "warning", label: "In review" },
      restricted: { level: "warning", label: "Restricted" },
      banned: { level: "critical", label: "Banned" },
      unpublished: { level: "warning", label: "Unpublished" },
    };
    for (const status of Object.keys(expected) as PageStatus[]) {
      expect(pageRisk({ status, ownerStatus: "active", bmCount: 1, profileCount: 0 })).toEqual(
        expected[status],
      );
    }
  });
});

describe("isVerificationOverdue", () => {
  const now = new Date("2026-08-13T12:00:00Z");

  test("never verified is overdue", () => {
    expect(isVerificationOverdue(null, now)).toBe(true);
  });

  test("verified exactly at the threshold is not yet overdue", () => {
    const at = new Date(now.getTime() - VERIFICATION_OVERDUE_DAYS * 86_400_000);
    expect(isVerificationOverdue(at, now)).toBe(false);
  });

  test("a day past the threshold is overdue", () => {
    const at = new Date(now.getTime() - (VERIFICATION_OVERDUE_DAYS + 1) * 86_400_000);
    expect(isVerificationOverdue(at, now)).toBe(true);
  });
});
