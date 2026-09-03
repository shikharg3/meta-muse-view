import { test, expect } from "bun:test";
import { validateTemplate, nextExportFormats, asMarkup } from "./reports";

test("a generic template may not carry campaign ids", () => {
  // Campaign ids belong to exactly one client; on a generic template they would save a filter that
  // can never match whichever client is chosen at run time.
  expect(validateTemplate({ name: "Monthly", columns: ["spend"], campaignIds: ["c1"] })).toEqual({
    ok: false,
    error: "Campaign filters need a client-bound template",
  });
  expect(
    validateTemplate({
      name: "Monthly",
      columns: ["spend"],
      clientId: "acme",
      campaignIds: ["c1"],
    }),
  ).toEqual({ ok: true });
});

test("a template needs a name and at least one known column", () => {
  expect(validateTemplate({ name: "  ", columns: ["spend"] }).ok).toBe(false);
  expect(validateTemplate({ name: "X", columns: [] }).ok).toBe(false);
  expect(validateTemplate({ name: "X", columns: ["not_a_metric"] }).ok).toBe(false);
  expect(validateTemplate({ name: "X", columns: ["spend", "purchases"] }).ok).toBe(true);
});

test("exporting the same run twice appends the format without moving the first stamp", () => {
  expect(nextExportFormats(null, "csv")).toEqual(["csv"]);
  expect(nextExportFormats(["csv"], "pdf")).toEqual(["csv", "pdf"]);
  expect(nextExportFormats(["csv"], "csv")).toEqual(["csv"]); // idempotent
});

test("the ledger reads a run's markup off jsonb text, and no markup is a dash not +0%", () => {
  // `params->>'markup'` comes back as text, so the cast happens here rather than in SQL where one
  // malformed row would fail the whole list query.
  expect(asMarkup("0.15")).toBeCloseTo(0.15, 6);
  expect(asMarkup(0.15)).toBeCloseTo(0.15, 6);
  expect(asMarkup(null)).toBeNull(); // key absent — the common case
  expect(asMarkup("0")).toBeNull(); // zero is "no markup", not a rate worth printing
  expect(asMarkup("not-a-number")).toBeNull();
});
