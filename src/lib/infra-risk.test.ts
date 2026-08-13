import { describe, expect, test } from "bun:test";
import { BM_STATUSES, type PageStatus, type PixelStatus, type ProfileStatus } from "./infra-status";
import {
  VERIFICATION_OVERDUE_DAYS,
  isVerificationOverdue,
  pageRisk,
  pixelRisk,
  redundancy,
  usableBm,
  usableProfile,
  type Risk,
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
  test("active alone is usable", () => {
    expect(usableProfile(["active"])).toBe(true);
  });

  test("active plus video_selfie stays usable — a pending selfie is not lost access", () => {
    expect(usableProfile(["active", "video_selfie"])).toBe(true);
  });

  test("every blocking status defeats active, even when active is also set", () => {
    const blocking: ProfileStatus[] = [
      "suspended",
      "in_review",
      "cannot_use_page",
      "cannot_use_ads_manager",
      "read_only",
    ];
    for (const s of blocking) {
      expect(usableProfile(["active", s])).toBe(false);
    }
  });

  test("a profile without active is not usable however harmless the rest", () => {
    expect(usableProfile(["video_selfie"])).toBe(false);
  });

  test("an empty set is not usable", () => {
    expect(usableProfile([])).toBe(false);
  });
});

describe("usableBm", () => {
  test("only active BMs are access paths", () => {
    const expected: Record<(typeof BM_STATUSES)[number], boolean> = {
      active: true,
      in_review: false,
      suspended: false,
    };
    for (const s of BM_STATUSES) expect(usableBm(s)).toBe(expected[s]);
  });
});

describe("BM access paths", () => {
  test("a BM whose only profiles are all blocked reads critical", () => {
    const profiles: ProfileStatus[][] = [["suspended"], ["active", "read_only"], ["in_review"]];
    expect(redundancy(profiles.filter(usableProfile).length)).toEqual({
      level: "critical",
      label: "No backup",
    });
  });

  test("two clean profiles is redundant", () => {
    const profiles: ProfileStatus[][] = [["active"], ["active", "video_selfie"]];
    expect(redundancy(profiles.filter(usableProfile).length)).toEqual({
      level: "safe",
      label: "Redundant",
    });
  });
});

describe("ad account access paths", () => {
  test("an account reachable only through a suspended BM is critical, not safe", () => {
    const linked = ["suspended"] as const;
    expect(redundancy(linked.filter(usableBm).length)).toEqual({
      level: "critical",
      label: "No backup",
    });
  });

  test("an in_review BM is not a backup path", () => {
    const linked = ["active", "in_review"] as const;
    expect(redundancy(linked.filter(usableBm).length)).toEqual({
      level: "warning",
      label: "Single access",
    });
  });
});

describe("pixelRisk precedence", () => {
  test("an unusable root BM beats every other signal", () => {
    expect(pixelRisk({ status: "active", rootBmStatus: "suspended", shareCount: 5 })).toEqual({
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
    const expected: Record<PixelStatus, Risk> = {
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
      pageRisk({
        status: "banned",
        ownerStatuses: ["suspended"],
        bmCount: 3,
        profileCount: 3,
      }),
    ).toEqual({ level: "critical", label: "No active owner" });
  });

  test("an owner blocked while still marked active is not an owner", () => {
    expect(
      pageRisk({
        status: "active",
        ownerStatuses: ["active", "cannot_use_page"],
        bmCount: 2,
        profileCount: 0,
      }),
    ).toEqual({ level: "critical", label: "No active owner" });
  });

  test("no added access is a warning when the page itself is healthy", () => {
    expect(
      pageRisk({ status: "active", ownerStatuses: ["active"], bmCount: 0, profileCount: 0 }),
    ).toEqual({ level: "warning", label: "No added access" });
  });

  test("one additional profile and no BM still counts as added access", () => {
    expect(
      pageRisk({ status: "active", ownerStatuses: ["active"], bmCount: 0, profileCount: 1 }),
    ).toEqual({ level: "safe", label: "Added" });
  });

  test("every page status is classified — a new status cannot become dead", () => {
    const expected: Record<PageStatus, Risk> = {
      active: { level: "safe", label: "Added" },
      in_review: { level: "warning", label: "In review" },
      restricted: { level: "warning", label: "Restricted" },
      banned: { level: "critical", label: "Banned" },
      unpublished: { level: "warning", label: "Unpublished" },
    };
    for (const status of Object.keys(expected) as PageStatus[]) {
      expect(pageRisk({ status, ownerStatuses: ["active"], bmCount: 1, profileCount: 0 })).toEqual(
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
