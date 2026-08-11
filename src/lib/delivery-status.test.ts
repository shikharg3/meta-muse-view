import { test, expect } from "bun:test";
import { deriveStatus, MACHINE_STATUSES, HUMAN_STATUSES, isMachineStatus } from "./delivery-status";

const acct = (o: Partial<{ disabled: boolean; deliverable: boolean }> = {}) => ({
  disabled: o.disabled ?? false,
  deliverable: o.deliverable ?? true,
});
const camp = (id: string, active = true) => ({ id, active });
const set = (id: string, campaignId: string, active = true) => ({ id, campaignId, active });
const ad = (adSetId: string, disapproved = false) => ({ adSetId, disapproved });

// A fully healthy row: one live account, one active campaign, one active ad set, one running ad.
const healthy = {
  accounts: [acct()],
  campaigns: [camp("c1")],
  adSets: [set("s1", "c1")],
  ads: [ad("s1")],
};

test("a delivering row is Live", () => {
  expect(deriveStatus(healthy)).toBe("Live");
});

test("every account disabled reads as Ad Account Disabled", () => {
  expect(
    deriveStatus({ ...healthy, accounts: [acct({ disabled: true, deliverable: false })] }),
  ).toBe("Ad Account Disabled");
});

test("one live account among disabled ones still reads Live", () => {
  // Strict all-or-nothing: partial breakage is not the status column's job.
  expect(
    deriveStatus({
      ...healthy,
      accounts: [acct({ disabled: true, deliverable: false }), acct()],
    }),
  ).toBe("Live");
});

test("accounts active but none able to deliver reads as Ad Account Blocked", () => {
  // The Slots.lv shape: account_status ACTIVE, prepaid cap exhausted, campaigns still ACTIVE.
  expect(deriveStatus({ ...healthy, accounts: [acct({ deliverable: false })] })).toBe(
    "Ad Account Blocked",
  );
});

test("all accounts disabled outranks all accounts undeliverable", () => {
  // A disabled account is also undeliverable; the more specific reason must win.
  expect(
    deriveStatus({
      ...healthy,
      accounts: [acct({ disabled: true, deliverable: false })],
    }),
  ).toBe("Ad Account Disabled");
});

test("no active campaign reads as Paused", () => {
  expect(deriveStatus({ ...healthy, campaigns: [camp("c1", false)] })).toBe("Paused");
});

test("active campaign with every ad set paused reads as Paused", () => {
  expect(deriveStatus({ ...healthy, adSets: [set("s1", "c1", false)] })).toBe("Paused");
});

test("every ad under the active ad sets disapproved reads as All ads rejected", () => {
  expect(deriveStatus({ ...healthy, ads: [ad("s1", true)] })).toBe("All ads rejected");
});

test("one running ad among disapproved ones still reads Live", () => {
  expect(deriveStatus({ ...healthy, ads: [ad("s1", true), ad("s1")] })).toBe("Live");
});

test("ads under paused ad sets are ignored when testing for rejection", () => {
  // An ad under a paused ad set is not rejected, it is simply not running. Counting it would let
  // ordinary ad-set pausing masquerade as a policy problem.
  expect(
    deriveStatus({
      ...healthy,
      adSets: [set("s1", "c1"), set("s2", "c1", false)],
      ads: [ad("s1"), ad("s2", true)],
    }),
  ).toBe("Live");
});

test("no accounts writes nothing", () => {
  // every() over an empty set is true, which would otherwise derive Ad Account Disabled.
  expect(deriveStatus({ ...healthy, accounts: [] })).toBeNull();
});

test("no attributed campaigns writes nothing", () => {
  expect(deriveStatus({ ...healthy, campaigns: [] })).toBeNull();
});

test("active campaign with no synced ad sets writes nothing", () => {
  // "no ad set is active" is vacuously true here; that is a sync gap, not a delivery state.
  expect(deriveStatus({ ...healthy, adSets: [], ads: [] })).toBeNull();
});

test("active ad sets with no synced ads writes nothing", () => {
  // "every ad is disapproved" is vacuously true here.
  expect(deriveStatus({ ...healthy, ads: [] })).toBeNull();
});

test("ad sets belonging to inactive campaigns do not satisfy the ad-set check", () => {
  const r = deriveStatus({
    accounts: [acct()],
    campaigns: [camp("c1"), camp("c2", false)],
    adSets: [set("s2", "c2")],
    ads: [ad("s2")],
  });
  expect(r).toBeNull(); // c1 is active but has no synced ad sets
});

test("the machine and human value sets are disjoint", () => {
  // The whole design rests on this: the value alone says who owns it.
  for (const h of HUMAN_STATUSES) expect(isMachineStatus(h)).toBe(false);
  for (const m of MACHINE_STATUSES) expect(isMachineStatus(m)).toBe(true);
  expect(MACHINE_STATUSES).toHaveLength(5);
  expect(HUMAN_STATUSES).toHaveLength(4);
});
