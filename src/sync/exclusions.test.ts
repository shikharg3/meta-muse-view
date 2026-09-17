import { describe, expect, it } from "bun:test";
import { EXCLUDED_NAME, EXCLUDED_NAME_SQL, matchesExcludedName } from "./exclusions";

/**
 * The exclusion pattern decides whether real spend disappears from the warehouse, so the thing worth
 * testing is not that it matches — it is where it STOPS. `KPI`, `Backpack` and `KP` as a syllable
 * inside a word are ordinary campaign-name material; sweeping one of those away would delete a
 * client's figures with no trace left to notice it by.
 */
describe("excluded campaign names", () => {
  it("matches the product line however it is written", () => {
    for (const name of [
      "KP",
      "KP - Sales",
      "US - KP",
      "kp",
      "KyloPeptides",
      "Kylo Peptides - Broad",
      "peptide retargeting",
      "Q4 | KP | prospecting",
      "sales-kp",
      "KP_2026",
    ])
      expect(matchesExcludedName(name)).toBe(true);
  });

  it("leaves names that merely contain those letters alone", () => {
    for (const name of [
      "KPI dashboard",
      "KPIs Q3",
      "Backpack - Broad",
      "SKP Media",
      "kpop fans - interests",
      "Skipping stones",
      "Corporate KPI review",
      "AKP1",
    ])
      expect(matchesExcludedName(name)).toBe(false);
  });

  it("ignores absent names rather than throwing", () => {
    expect(matchesExcludedName(null)).toBe(false);
    expect(matchesExcludedName(undefined)).toBe(false);
    expect(matchesExcludedName("")).toBe(false);
  });

  // The sweep runs the Postgres spelling and ingest runs the JS one; if they disagree, rows get
  // admitted and then deleted (or kept and never refreshed). Compare them on the same corpus using
  // the one POSIX-vs-JS difference that matters here: case-insensitivity is spelled by the caller.
  it("keeps the SQL spelling in step with the JS one", () => {
    const sqlEquivalent = new RegExp(EXCLUDED_NAME_SQL, "i");
    for (const name of [
      "KP",
      "KP - Sales",
      "KyloPeptides",
      "peptide",
      "KPI dashboard",
      "Backpack - Broad",
      "kpop fans - interests",
      "US - KP",
      "AKP1",
      "SKP Media",
    ])
      expect(sqlEquivalent.test(name)).toBe(EXCLUDED_NAME.test(name));
  });
});
