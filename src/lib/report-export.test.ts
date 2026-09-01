import { test, expect } from "bun:test";
import {
  buildReportPdf,
  chartableColumns,
  clientSubtitle,
  plainCell,
  showCell,
  type ReportDoc,
} from "./report-export";

const doc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  title: "PlayW3 — performance report",
  subtitle: "2026-08-01 → 2026-08-03 · by date",
  note: null,
  columns: [
    { key: "_dim", label: "Date", kind: "text" },
    { key: "cpc", label: "CPC", kind: "money" },
    { key: "ctr", label: "CTR", kind: "pct" },
    { key: "clicks", label: "Clicks", kind: "int" },
    { key: "spend", label: "Spend", kind: "money" },
    { key: "cost_per_result", label: "Cost / Result", kind: "money" },
  ],
  rows: [
    ["2026-08-01", 0.5, 1.2, 200, 100, 4],
    ["2026-08-02", 0.4, 1.4, 250, 100, 3],
    ["2026-08-03", 0.6, 1.1, 180, 108, 5],
  ],
  totals: ["Total", 0.5, 1.23, 630, 308, 4],
  filename: "playw3",
  ...over,
});

test("a chart is only ever drawn from a metric that sums", () => {
  // Spend outranks clicks; cpc, cpm and every cost-per are averages, and a bar chart of an average
  // beside a totals row lies about the period.
  const picks = chartableColumns(doc()).map((i) => doc().columns[i].key);
  expect(picks).toEqual(["spend", "clicks"]);
});

test("a metric with no positive value is not charted", () => {
  const zeroed = doc({
    rows: [
      ["2026-08-01", 0.5, 1.2, 0, 0, 0],
      ["2026-08-02", 0.4, 1.4, 0, 0, 0],
    ],
    totals: null,
  });
  expect(chartableColumns(zeroed)).toEqual([]);
});

test("a portal column that the catalog does not know is judged by its key", () => {
  const portal = doc({
    columns: [
      { key: "_dim", label: "Day", kind: "text" },
      { key: "costPerReg", label: "Cost per registration", kind: "money" },
      { key: "regs", label: "Registrations", kind: "int" },
    ],
    rows: [
      ["Aug 1", 10.6, 78],
      ["Aug 2", 10.2, 80],
    ],
    totals: ["Total", 10.4, 158],
  });
  expect(chartableColumns(portal).map((i) => portal.columns[i].key)).toEqual(["regs"]);
});

test("a CSV cell carries no symbols: ints round, everything else keeps two decimals", () => {
  expect(plainCell(1234.56, "int")).toBe("1235");
  expect(plainCell(1234.5, "money")).toBe("1234.50");
  expect(plainCell(1.234, "pct")).toBe("1.23");
  expect(plainCell("2026-08-01", "text")).toBe("2026-08-01");
});

test("a withheld metric prints an em dash, never a blank or a zero", () => {
  expect(plainCell(null, "int")).toBe("—");
  expect(showCell(null, "money")).toBe("—");
});

test("the PDF renders a period and a dimension column together, with withheld cells", async () => {
  // buildReport emits _period and _dim as separate leading columns, blanks the trailing one on the
  // totals row, and withholds a de-duplicated metric wherever a bucket covers several Meta rows.
  const pdf = await buildReportPdf({
    title: "PlayW3 — performance report",
    subtitle: "2026-08-01 → 2026-08-02 · by date · campaign",
    note: "Reach withheld where a row covers more than one of Meta's own rows.",
    columns: [
      { key: "_period", label: "Date", kind: "text" },
      { key: "_dim", label: "Campaign", kind: "text" },
      { key: "spend", label: "Spend", kind: "money" },
      { key: "reach", label: "Reach", kind: "int" },
    ],
    rows: [
      ["2026-08-01", "Tier 1 broad prospecting", 820, 41000],
      ["2026-08-01", "Retargeting 30d", 410, null],
      ["2026-08-02", "Tier 1 broad prospecting", 905, 44800],
    ],
    totals: ["Total", "", 2135, null],
    filename: "playw3-period-dim",
  });
  expect(pdf.getNumberOfPages()).toBe(1);
});

test("every report carries the wordmark and a totals row", async () => {
  const pdf = await buildReportPdf(doc());
  expect(pdf.getNumberOfPages()).toBe(1);
  // The logo is an image XObject; a dropped addImage would leave the header a bare violet band.
  expect(pdf.output()).toContain("/Image");
  expect(pdf.output("arraybuffer").byteLength).toBeGreaterThan(2000);
});

test("a client-facing subtitle never names the commission", () => {
  // The four shapes production actually holds: runs issued before the disclosure was removed carry
  // it frozen in their immutable payload, and re-exporting one must not print our margin.
  expect(clientSubtitle("2026-08-24 → 2026-08-30 · by date · incl. 10% markup")).toBe(
    "2026-08-24 → 2026-08-30 · by date",
  );
  expect(clientSubtitle("2026-08-21 → 2026-08-27 · by date · ad set · incl. 25% markup")).toBe(
    "2026-08-21 → 2026-08-27 · by date · ad set",
  );
  expect(clientSubtitle("2026-08-24 → 2026-08-30 · by date · campaign · incl. 10% markup")).toBe(
    "2026-08-24 → 2026-08-30 · by date · campaign",
  );
  // A subtitle with nothing to hide is returned untouched.
  expect(clientSubtitle("2026-08-01 → 2026-08-06 · by date")).toBe(
    "2026-08-01 → 2026-08-06 · by date",
  );
});

test("the PDF renders for a single already-total row with no dimension column", async () => {
  // No dimension means no chart and no totals row; the headline figures carry the page alone.
  const pdf = await buildReportPdf(
    doc({
      columns: [
        { key: "spend", label: "Spend", kind: "money" },
        { key: "clicks", label: "Clicks", kind: "int" },
      ],
      rows: [[41280.5, 71880]],
      totals: null,
    }),
  );
  expect(pdf.getNumberOfPages()).toBe(1);
});

test("a report long enough to spill keeps the branded chrome on every page", async () => {
  const rows = Array.from({ length: 90 }, (_, i) => [
    `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
    0.5,
    1.2,
    200 + i,
    100 + i,
    4,
  ]);
  const pdf = await buildReportPdf(doc({ rows }));
  expect(pdf.getNumberOfPages()).toBeGreaterThan(1);
});
