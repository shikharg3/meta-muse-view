import { test, expect } from "bun:test";
import { canonicalEvents, accountStatus } from "./agg";

test("canonicalEvents collapses Meta's variant action_types into one event", () => {
  const events = canonicalEvents([
    {
      actions: [
        { action_type: "omni_purchase", value: "10" },
        { action_type: "purchase", value: "10" },
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "10" },
      ],
      actionValues: [{ action_type: "omni_purchase", value: "300" }],
    },
  ]);
  // counted ONCE (10), not summed across the 3 duplicate types (30)
  expect(events).toEqual([{ label: "Purchases", count: 10, value: 300 }]);
});

test("canonicalEvents surfaces leads/registrations even with zero purchases (Blockbet case)", () => {
  const events = canonicalEvents([
    {
      actions: [
        { action_type: "lead", value: "67" },
        { action_type: "onsite_web_lead", value: "67" },
        { action_type: "offsite_conversion.fb_pixel_lead", value: "67" },
        { action_type: "complete_registration", value: "4" },
        { action_type: "link_click", value: "156" },
      ],
      actionValues: null,
    },
  ]);
  const byLabel = Object.fromEntries(events.map((e) => [e.label, e.count]));
  expect(byLabel["Leads"]).toBe(67); // de-duplicated, not 3x
  expect(byLabel["Registrations"]).toBe(4);
  expect(byLabel["Link clicks"]).toBe(156);
  expect(byLabel["Purchases"]).toBeUndefined(); // none → omitted
  expect(events[0].label).toBe("Link clicks"); // sorted by count desc
});

test("canonicalEvents sums across rows and ignores unknown/custom action types", () => {
  const events = canonicalEvents([
    {
      actions: [
        { action_type: "lead", value: "5" },
        { action_type: "offsite_conversion.fb_pixel_custom", value: "99" },
      ],
      actionValues: null,
    },
    { actions: [{ action_type: "lead", value: "3" }], actionValues: null },
  ]);
  expect(events).toEqual([{ label: "Leads", count: 8, value: 0 }]);
});

test("canonicalEvents prefers the unified omni_* value within a family", () => {
  const events = canonicalEvents([
    {
      actions: [
        { action_type: "omni_purchase", value: "12" }, // cross-device unified — preferred
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "9" },
      ],
      actionValues: null,
    },
  ]);
  expect(events[0]).toEqual({ label: "Purchases", count: 12, value: 0 });
});

test("accountStatus maps Meta codes + labels; disabled codes are never ACTIVE", () => {
  expect(accountStatus("1")).toBe("ACTIVE");
  expect(accountStatus("2")).toBe("DISABLED"); // the CereBree case (account_status 2)
  expect(accountStatus("100")).toBe("DISABLED");
  expect(accountStatus("101")).toBe("DISABLED");
  expect(accountStatus("7")).toBe("PENDING");
  expect(accountStatus("DISABLED")).toBe("DISABLED"); // already-mapped label passthrough
  expect(accountStatus("999")).toBe("PENDING"); // unknown code → PENDING, not ACTIVE
  expect(accountStatus(null)).toBe("ACTIVE"); // documents the no-data default
});
