import { expect, test } from "bun:test";
import { insightRowsOf, parseAmount, parseCsv, planImport } from "./meta-import";

const HEADER =
  "Day,Account ID,Account name,Campaign ID,Campaign name,Ad set ID,Ad set name,Ad ID,Ad name," +
  "Amount spent (USD),Impressions,Reach,Clicks (all),Link clicks,Registrations Completed";

const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

test("parseCsv keeps quoted delimiters, doubled quotes and newlines inside a cell", () => {
  const { rows, error } = parseCsv('\uFEFFa,b\r\n"x, ""y""","line1\nline2"\r\n');
  expect(error).toBeNull();
  expect(rows).toEqual([
    ["a", "b"],
    ['x, "y"', "line1\nline2"],
  ]);
});

test("parseCsv reads a semicolon re-save and refuses a truncated quote", () => {
  expect(parseCsv("a;b\n1;2").rows).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
  expect(parseCsv('a,b\n"open').error).not.toBeNull();
});

test("parseAmount accepts thousands separators and blanks, refuses decimal commas", () => {
  expect(parseAmount("1,234.56")).toBe(1234.56);
  expect(parseAmount("")).toBe(0);
  expect(parseAmount("$12")).toBe(12);
  expect(parseAmount("12,5")).toBeNull();
  expect(parseAmount("-3")).toBeNull();
});

test("ad rows build every coarser level, summed, with the currency from the spend header", () => {
  const plan = planImport({
    csv: csv(
      "2026-10-01,123456789,Ext,111,Camp A,211,Set A1,311,Ad 1,10.50,1000,800,20,15,2",
      "2026-10-01,123456789,Ext,111,Camp A,211,Set A1,312,Ad 2,4.50,500,400,5,4,1",
      "2026-10-01,123456789,Ext,112,Camp B,212,Set B1,313,Ad 3,5,250,200,2,2,0",
      "2026-10-02,123456789,Ext,111,Camp A,211,Set A1,311,Ad 1,7,700,600,7,6,3",
    ),
  });
  expect(plan.errors).toEqual([]);
  expect(plan.accountId).toBe("act_123456789");
  expect(plan.currency).toBe("USD");
  expect(plan.levelsInFile).toEqual(["ad"]);
  expect(plan.derivedLevels).toEqual(["account", "campaign", "adset"]);
  expect(plan.rowsByLevel).toEqual({ account: 2, campaign: 3, adset: 3, ad: 4 });
  const acct = plan.insights.find((r) => r.level === "account" && r.date === "2026-10-01")!;
  expect(acct.m.spend).toBe(20);
  expect(acct.m.impressions).toBe(1750);
  expect(acct.m.counts.Registrations).toBe(3);
  const campA = plan.insights.find(
    (r) => r.level === "campaign" && r.entityId === "111" && r.date === "2026-10-01",
  )!;
  expect(campA.m.spend).toBe(15);
  // Registrations have the volume, so they label the results.
  expect(plan.resultEvent).toBe("COMPLETE_REGISTRATION");
  expect(plan.resultLabel).toBe("Registrations");
  // Summed reach is an over-count, and the operator is told.
  expect(plan.warnings.some((w) => w.message.includes("Reach"))).toBe(true);
});

test("each conversion is stored under ONE alias, so readers that take the first present count it once", () => {
  const plan = planImport({
    csv: csv("2026-10-01,123456789,Ext,111,Camp A,211,Set A1,,,10,1000,800,20,15,4"),
  });
  const row = insightRowsOf(plan).find((r) => r.level === "adset")!;
  expect(row.actions).toEqual([
    { action_type: "omni_complete_registration", value: "4" },
    { action_type: "link_click", value: "15" },
  ]);
  expect(row.raw.adset_id).toBe("211");
  expect(row.raw.campaign_id).toBe("111");
});

test("a parent row in the file wins over the sum of its children, and a mismatch is flagged", () => {
  const plan = planImport({
    csv: csv(
      "2026-10-01,123456789,Ext,111,Camp A,,,,,30,3000,2500,30,25,5",
      "2026-10-01,123456789,Ext,111,Camp A,211,Set A1,,,10,1000,900,10,8,2",
    ),
  });
  expect(plan.errors).toEqual([]);
  const camp = plan.insights.find((r) => r.level === "campaign")!;
  expect(camp.derived).toBe(false);
  expect(camp.m.spend).toBe(30);
  expect(camp.m.reach).toBe(2500);
  expect(plan.warnings.some((w) => w.message.includes("add up to 10"))).toBe(true);
});

test("'Clicks (all)' is a column, not a currency suffix", () => {
  const plan = planImport({
    csv: csv("2026-10-01,123456789,Ext,111,Camp A,211,Set A1,,,1,10,5,3,2,0"),
  });
  expect(plan.mappedColumns).toContainEqual({ header: "Clicks (all)", field: "clicks" });
  expect(plan.currency).toBe("USD");
});

test("refuses what would silently corrupt the import", () => {
  const errors = (body: string) =>
    planImport({ csv: csv(body) })
      .errors.map((e) => e.message)
      .join(" | ");
  // Excel's rounding of an 18-digit id.
  expect(errors("2026-10-01,123456789,Ext,1.20211E+17,Camp,211,Set,,,1,1,1,1,1,0")).toContain(
    "not a plain number",
  );
  // Not broken down by day.
  expect(
    planImport({
      csv: "Reporting starts,Reporting ends,Account ID,Campaign ID,Ad set ID,Amount spent,Impressions\n2026-10-01,2026-10-14,123456789,111,211,5,10",
    }).errors[0].message,
  ).toContain("not one day");
  // The same entity twice on one day.
  expect(
    errors(
      "2026-10-01,123456789,Ext,111,Camp,211,Set,,,1,1,1,1,1,0\n2026-10-01,123456789,Ext,111,Camp,211,Set,,,2,2,2,2,2,0",
    ),
  ).toContain("Duplicate adset row");
  // Two accounts in one file.
  expect(
    errors(
      "2026-10-01,123456789,Ext,111,Camp,211,Set,,,1,1,1,1,1,0\n2026-10-01,987654321,Other,112,Camp,212,Set,,,1,1,1,1,1,0",
    ),
  ).toContain("One account per file");
  // A campaign-level-only export cannot label results.
  expect(errors("2026-10-01,123456789,Ext,111,Camp,,,,,1,1,1,1,1,0")).toContain(
    "has no ad set rows",
  );
});

test("an Ads Manager totals line is skipped, not double-counted", () => {
  const plan = planImport({
    csv: csv(
      "2026-10-01,123456789,Ext,111,Camp A,211,Set A1,,,10,100,50,5,4,1",
      ",,,,,,,,,10,100,50,5,4,1",
    ),
  });
  expect(plan.errors).toEqual([]);
  expect(plan.insights.find((r) => r.level === "account")!.m.spend).toBe(10);
  expect(plan.warnings.some((w) => w.message.includes("totals row"))).toBe(true);
});
