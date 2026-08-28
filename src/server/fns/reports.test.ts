import { test, expect } from "bun:test";
import { validateTemplate, nextExportFormats } from "./reports";

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
