import { describe, expect, test } from "bun:test";
import {
  PROFILE_STATUSES,
  PROFILE_BLOCKING_STATUSES,
  BM_STATUSES,
  BM_TYPES,
  PIXEL_STATUSES,
  PAGE_STATUSES,
  AD_ACCOUNT_USAGE,
  INFRA_STATUS_LABEL,
  isProfileStatus,
  isBmStatus,
  isBmType,
  isPixelStatus,
  isPageStatus,
  isAdAccountUsage,
  parseProfileStatuses,
} from "./infra-status";

describe("vocabularies", () => {
  // Pinned so a reorder or a silent removal is a test failure, not a surprise in the UI.
  test("profile statuses are the seven agreed values, in display order", () => {
    expect([...PROFILE_STATUSES]).toEqual([
      "active",
      "video_selfie",
      "suspended",
      "in_review",
      "cannot_use_page",
      "cannot_use_ads_manager",
      "read_only",
    ]);
  });

  test("bm statuses are exactly active, in_review, suspended", () => {
    expect([...BM_STATUSES]).toEqual(["active", "in_review", "suspended"]);
  });

  test("bm types are exactly verified, non_verified, used_for_dot_apps", () => {
    expect([...BM_TYPES]).toEqual(["verified", "non_verified", "used_for_dot_apps"]);
  });

  test("pixel statuses unchanged", () => {
    expect([...PIXEL_STATUSES]).toEqual(["active", "inactive", "restricted"]);
  });

  test("page statuses unchanged", () => {
    expect([...PAGE_STATUSES]).toEqual([
      "active",
      "in_review",
      "restricted",
      "banned",
      "unpublished",
    ]);
  });

  test("ad account usage states unchanged", () => {
    expect([...AD_ACCOUNT_USAGE]).toEqual(["in_use", "spare", "retired"]);
  });
});

describe("PROFILE_BLOCKING_STATUSES", () => {
  test("every profile status except active and video_selfie blocks access", () => {
    expect([...PROFILE_BLOCKING_STATUSES].map(String).sort()).toEqual(
      ["cannot_use_ads_manager", "cannot_use_page", "in_review", "read_only", "suspended"].sort(),
    );
  });

  test("active is never blocking", () => {
    expect((PROFILE_BLOCKING_STATUSES as readonly string[]).includes("active")).toBe(false);
  });

  test("video_selfie is not blocking — it is a pending verification prompt, not lost access", () => {
    expect((PROFILE_BLOCKING_STATUSES as readonly string[]).includes("video_selfie")).toBe(false);
  });

  test("blocking is a strict subset of the vocabulary", () => {
    for (const s of PROFILE_BLOCKING_STATUSES) {
      expect((PROFILE_STATUSES as readonly string[]).includes(s)).toBe(true);
    }
  });
});

describe("labels", () => {
  test("every value of every vocabulary has a display label", () => {
    const all = [
      ...PROFILE_STATUSES,
      ...BM_STATUSES,
      ...BM_TYPES,
      ...PIXEL_STATUSES,
      ...PAGE_STATUSES,
      ...AD_ACCOUNT_USAGE,
    ];
    for (const key of all) {
      expect(INFRA_STATUS_LABEL[key]).toBeTruthy();
    }
  });

  test("underscored keys read as prose, not as identifiers", () => {
    expect(INFRA_STATUS_LABEL.cannot_use_ads_manager).toBe("Cannot use Ads Manager");
    expect(INFRA_STATUS_LABEL.video_selfie).toBe("Video selfie");
    expect(INFRA_STATUS_LABEL.used_for_dot_apps).toBe("Used for DOT apps");
    expect(INFRA_STATUS_LABEL.non_verified).toBe("Non-verified");
  });
});

describe("guards", () => {
  test("each guard accepts its own vocabulary", () => {
    for (const s of PROFILE_STATUSES) expect(isProfileStatus(s)).toBe(true);
    for (const s of BM_STATUSES) expect(isBmStatus(s)).toBe(true);
    for (const s of BM_TYPES) expect(isBmType(s)).toBe(true);
    for (const s of PIXEL_STATUSES) expect(isPixelStatus(s)).toBe(true);
    for (const s of PAGE_STATUSES) expect(isPageStatus(s)).toBe(true);
    for (const s of AD_ACCOUNT_USAGE) expect(isAdAccountUsage(s)).toBe(true);
  });

  test("statuses retired from the vocabulary are rejected", () => {
    // These were real values before this change; they must not silently pass again.
    expect(isProfileStatus("new")).toBe(false);
    expect(isProfileStatus("banned")).toBe(false);
    expect(isProfileStatus("retired")).toBe(false);
    expect(isBmStatus("pending_verification")).toBe(false);
    expect(isBmStatus("restricted")).toBe(false);
    expect(isBmStatus("banned")).toBe(false);
  });

  test("guards reject empty string, null and undefined", () => {
    expect(isProfileStatus("")).toBe(false);
    expect(isProfileStatus(null)).toBe(false);
    expect(isBmType(undefined)).toBe(false);
  });
});

describe("parseProfileStatuses", () => {
  test("keeps known values in vocabulary order, not insertion order", () => {
    expect(parseProfileStatuses(["read_only", "active"])).toEqual(["active", "read_only"]);
  });

  test("drops unknown values rather than throwing", () => {
    expect(parseProfileStatuses(["active", "banned", "nonsense"])).toEqual(["active"]);
  });

  test("dedupes", () => {
    expect(parseProfileStatuses(["active", "active"])).toEqual(["active"]);
  });

  test("an empty or all-unknown set falls back to suspended, never to usable", () => {
    // A profile whose status set cannot be read must not be treated as an access path.
    expect(parseProfileStatuses([])).toEqual(["suspended"]);
    expect(parseProfileStatuses(["garbage"])).toEqual(["suspended"]);
    expect(parseProfileStatuses(null)).toEqual(["suspended"]);
  });
});
