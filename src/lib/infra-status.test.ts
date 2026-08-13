import { describe, expect, test } from "bun:test";
import {
  PROFILE_STATUSES,
  BM_STATUSES,
  PIXEL_STATUSES,
  PAGE_STATUSES,
  AD_ACCOUNT_USAGE,
  isProfileStatus,
  isBmStatus,
  isPixelStatus,
  isPageStatus,
  isAdAccountUsage,
} from "./infra-status";

describe("vocabularies", () => {
  // Pinned so a reorder or a silent removal is a test failure, not a surprise in the UI.
  test("profile statuses are exactly the six agreed values", () => {
    expect([...PROFILE_STATUSES]).toEqual([
      "new",
      "active",
      "in_review",
      "suspended",
      "banned",
      "retired",
    ]);
  });

  test("bm statuses are exactly the five agreed values", () => {
    expect([...BM_STATUSES]).toEqual([
      "pending_verification",
      "active",
      "in_review",
      "restricted",
      "banned",
    ]);
  });

  test("pixel statuses are exactly the three agreed values", () => {
    expect([...PIXEL_STATUSES]).toEqual(["active", "inactive", "restricted"]);
  });

  test("page statuses are exactly the five agreed values", () => {
    expect([...PAGE_STATUSES]).toEqual([
      "active",
      "in_review",
      "restricted",
      "banned",
      "unpublished",
    ]);
  });

  test("ad account usage states are exactly the three agreed values", () => {
    expect([...AD_ACCOUNT_USAGE]).toEqual(["in_use", "spare", "retired"]);
  });
});

describe("guards", () => {
  test("each guard accepts its own vocabulary", () => {
    for (const s of PROFILE_STATUSES) expect(isProfileStatus(s)).toBe(true);
    for (const s of BM_STATUSES) expect(isBmStatus(s)).toBe(true);
    for (const s of PIXEL_STATUSES) expect(isPixelStatus(s)).toBe(true);
    for (const s of PAGE_STATUSES) expect(isPageStatus(s)).toBe(true);
    for (const s of AD_ACCOUNT_USAGE) expect(isAdAccountUsage(s)).toBe(true);
  });

  test("guards reject values belonging to a different entity", () => {
    expect(isProfileStatus("pending_verification")).toBe(false); // a BM status
    expect(isBmStatus("suspended")).toBe(false); // a profile status
    expect(isPixelStatus("banned")).toBe(false); // pixels are never banned
    expect(isPageStatus("inactive")).toBe(false);
    expect(isAdAccountUsage("active")).toBe(false);
  });

  test("guards reject empty string, null and undefined", () => {
    expect(isProfileStatus("")).toBe(false);
    expect(isProfileStatus(null)).toBe(false);
    expect(isProfileStatus(undefined)).toBe(false);
  });
});
