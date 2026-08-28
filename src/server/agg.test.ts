import { test, expect } from "bun:test";
import { familyCount, familyValue, eventFamilyLabels, EVENT_MEMBERS } from "./agg";
import { EVENT_FAMILY_LABELS } from "@/lib/report-catalog";

test("a family matches even when only a late synonym is present", () => {
  // Measured on production: the purchase family returns eight action_types. A row carrying only the
  // in-store variant is still a purchase, and counting 0 would understate the client's results.
  expect(familyCount(new Map([["web_in_store_purchase", 12]]), "Purchases")).toBe(12);
  expect(familyCount(new Map([["onsite_web_app_purchase", 3]]), "Purchases")).toBe(3);
  expect(familyCount(new Map([["offsite_lead_add_20_s_calls", 9]]), "Leads")).toBe(9);
  expect(
    familyCount(new Map([["offsite_complete_registration_add_meta_leads", 4]]), "Registrations"),
  ).toBe(4);
});

test("preference order wins so synonyms never double-count", () => {
  // All eight purchase synonyms report the same conversion; summing them would be an 8x overcount.
  const sums = new Map([
    ["omni_purchase", 10],
    ["purchase", 10],
    ["offsite_conversion.fb_pixel_purchase", 10],
    ["onsite_web_purchase", 10],
    ["onsite_web_app_purchase", 10],
    ["web_in_store_purchase", 10],
    ["web_app_in_store_purchase", 10],
    ["offsite_purchase_add_20_s_calls", 10],
  ]);
  expect(familyCount(sums, "Purchases")).toBe(10);
});

test("familyValue reads the same variant familyCount does", () => {
  // A count and a value taken from different variants would yield an average order value that
  // belongs to neither.
  const counts = new Map([["purchase", 4]]);
  const values = new Map([["purchase", 400]]);
  expect(familyCount(counts, "Purchases")).toBe(4);
  expect(familyValue(values, "Purchases")).toBe(400);
});

test("an unknown family is zero, never a throw", () => {
  expect(familyCount(new Map([["purchase", 1]]), "Not A Family")).toBe(0);
  expect(familyValue(new Map([["purchase", 1]]), "Not A Family")).toBe(0);
});

test("catalog family labels match EVENT_FAMILIES exactly", () => {
  // The client-safe catalog cannot import this module, so it restates the labels. If they drift, an
  // event column silently resolves to 0 — a wrong number, not an error.
  // Received first: EVENT_FAMILY_LABELS is `as const`, so passing it as the *expected* value narrows
  // toEqual to its literal union and rejects the plain string[] the accessor returns.
  expect(eventFamilyLabels()).toEqual([...EVENT_FAMILY_LABELS]);
});

test("every family exposes its member action types", () => {
  for (const label of eventFamilyLabels()) {
    expect(EVENT_MEMBERS[label]?.length ?? 0, `${label} has no members`).toBeGreaterThan(0);
  }
});
