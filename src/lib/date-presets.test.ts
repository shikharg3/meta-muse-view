import { test, expect } from "bun:test";
import { DATE_PRESETS, resolvePreset } from "./date-presets";

// A Wednesday, mid-month, mid-quarter — so week, month and quarter boundaries are all non-trivial.
const TODAY = "2026-08-26";

test("presets are unique and cover every group", () => {
  // 19, not Meta's 20: `data_maximum` is in Meta's enum but undocumented, so its semantics cannot
  // be matched, and a `month_to_date` alias of `this_month` would be a second key for one behaviour.
  expect(DATE_PRESETS.length).toBe(19);
  const keys = DATE_PRESETS.map((p) => p.key);
  expect(new Set(keys).size).toBe(19);
  expect(new Set(DATE_PRESETS.map((p) => p.group))).toEqual(
    new Set(["relative", "calendar", "all"]),
  );
});

test("every preset resolves to an ordered ISO range", () => {
  for (const p of DATE_PRESETS) {
    const r = resolvePreset(p.key, TODAY);
    expect(r, `${p.key} did not resolve`).not.toBeNull();
    expect(r!.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r!.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r!.since <= r!.until, `${p.key}: ${r!.since} > ${r!.until}`).toBe(true);
  }
});

test("calendar presets land on real boundaries", () => {
  expect(resolvePreset("today", TODAY)).toEqual({ since: "2026-08-26", until: "2026-08-26" });
  expect(resolvePreset("yesterday", TODAY)).toEqual({ since: "2026-08-25", until: "2026-08-25" });
  expect(resolvePreset("this_month", TODAY)).toEqual({ since: "2026-08-01", until: "2026-08-26" });
  expect(resolvePreset("last_month", TODAY)).toEqual({ since: "2026-07-01", until: "2026-07-31" });
  expect(resolvePreset("this_quarter", TODAY)).toEqual({
    since: "2026-07-01",
    until: "2026-08-26",
  });
  expect(resolvePreset("last_quarter", TODAY)).toEqual({
    since: "2026-04-01",
    until: "2026-06-30",
  });
  expect(resolvePreset("this_year", TODAY)).toEqual({ since: "2026-01-01", until: "2026-08-26" });
  expect(resolvePreset("last_year", TODAY)).toEqual({ since: "2025-01-01", until: "2025-12-31" });
});

test("weeks respect their start day", () => {
  // 2026-08-26 is a Wednesday: Mon-start week began 08-24, Sun-start week began 08-23.
  expect(resolvePreset("this_week_mon_today", TODAY)).toEqual({
    since: "2026-08-24",
    until: "2026-08-26",
  });
  expect(resolvePreset("this_week_sun_today", TODAY)).toEqual({
    since: "2026-08-23",
    until: "2026-08-26",
  });
  expect(resolvePreset("last_week_mon_sun", TODAY)).toEqual({
    since: "2026-08-17",
    until: "2026-08-23",
  });
  expect(resolvePreset("last_week_sun_sat", TODAY)).toEqual({
    since: "2026-08-16",
    until: "2026-08-22",
  });
});

test("a Sunday does not fall into the previous Monday-week", () => {
  // The classic off-by-one: getUTCDay() is 0 on Sunday, so a naive shift lands a week early.
  const sunday = "2026-08-23";
  expect(resolvePreset("this_week_mon_today", sunday)).toEqual({
    since: "2026-08-17",
    until: "2026-08-23",
  });
  expect(resolvePreset("this_week_sun_today", sunday)).toEqual({
    since: "2026-08-23",
    until: "2026-08-23",
  });
});

test("relative presets end yesterday, because today is partial", () => {
  expect(resolvePreset("last_7d", TODAY)).toEqual({ since: "2026-08-19", until: "2026-08-25" });
  expect(resolvePreset("last_3d", TODAY)).toEqual({ since: "2026-08-23", until: "2026-08-25" });
  expect(resolvePreset("last_28d", TODAY)).toEqual({ since: "2026-07-29", until: "2026-08-25" });
});

test("month and quarter arithmetic crosses a year boundary", () => {
  const jan = "2026-01-15";
  expect(resolvePreset("last_month", jan)).toEqual({ since: "2025-12-01", until: "2025-12-31" });
  expect(resolvePreset("last_quarter", jan)).toEqual({ since: "2025-10-01", until: "2025-12-31" });
  expect(resolvePreset("this_quarter", jan)).toEqual({ since: "2026-01-01", until: "2026-01-15" });
});

test("last_month handles a 29-day February", () => {
  expect(resolvePreset("last_month", "2024-03-10")).toEqual({
    since: "2024-02-01",
    until: "2024-02-29",
  });
});

test("an unknown preset is null, never a silently wrong range", () => {
  expect(resolvePreset("nonsense", TODAY)).toBeNull();
  expect(resolvePreset("", TODAY)).toBeNull();
});
