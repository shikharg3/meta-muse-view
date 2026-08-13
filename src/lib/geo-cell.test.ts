import { test, expect } from "bun:test";
import { geoCell, UNKNOWN_GEO, type GeoSpend } from "./geo-cell";

const country = (value: string, spend: number): GeoSpend => ({ type: "country", value, spend });
const region = (value: string, spend: number): GeoSpend => ({ type: "region", value, spend });

test("a single delivering country drills into its regions", () => {
  // 79 of 93 spending campaigns deliver to one country, so without this the cell reads "US 100%"
  // on most rows and says nothing the brief did not already say.
  expect(
    geoCell([country("US", 1000), region("California", 500), region("Texas", 300), region("Florida", 200)]),
  ).toBe("US 100%\nCalifornia 50% · Texas 30% · Florida 20%");
});

test("a single country with no region rows writes one line", () => {
  expect(geoCell([country("AR", 2075)])).toBe("AR 100%");
});

test("several delivering countries stay at country level and the tail is counted", () => {
  // OneAgency / Slots.lv shape: 22 countries, 18 of them rounding to nothing. The region row is
  // present and must be ignored - regions are only meaningful under a single country.
  const rows = [
    country("US", 930),
    country("ZA", 20),
    country("GE", 20),
    country("IT", 10),
    ...Array.from({ length: 18 }, (_, i) => country(`X${i}`, 1)),
    region("California", 500),
  ];
  expect(geoCell(rows)).toBe("US 93% · GE 2% · ZA 2% · IT 1% · +18 more");
});

test("more than eight material countries collapse into a count", () => {
  const rows = Array.from({ length: 12 }, (_, i) => country(`C${i}`, 100 - i));
  const cell = geoCell(rows);
  expect(cell.split(" · ")).toHaveLength(9);
  expect(cell.endsWith("+4 more")).toBe(true);
});

test("`unknown` counts toward the split but never blocks or enters the drill", () => {
  // Meta's bucket for spend it could not place. It is real money, so it belongs in the denominator,
  // but it is not a country and must not stop the drill from firing on the one that is.
  expect(
    geoCell([country("US", 996), country(UNKNOWN_GEO, 4), region("California", 600), region("Texas", 400)]),
  ).toBe("US 100% · +1 more\nCalifornia 60% · Texas 40%");
});

test("two identified countries suppress the drill even when one is negligible", () => {
  // The region breakdown is not scoped by country, so CA's regions would be mixed into a line
  // labelled US. Silence beats a plausible lie.
  expect(geoCell([country("US", 996), country("CA", 4), region("California", 600)])).toBe(
    "US 100% · +1 more",
  );
});

test("no delivered spend produces no cell", () => {
  expect(geoCell([])).toBe("");
  expect(geoCell([country("US", 0)])).toBe("");
  // Regions with no country behind them are not a cell either.
  expect(geoCell([region("California", 500)])).toBe("");
});

test("a region line naming nothing but `unknown` is suppressed", () => {
  // Measured against production: 123 campaigns carry a positive `unknown` region bucket over 60
  // days. "US 100%\nunknown 100%" repeats line 1 and names no place.
  expect(geoCell([country("US", 1000), region(UNKNOWN_GEO, 1000)])).toBe("US 100%");
  // Beside a real region it stays, and stays in the denominator, so the placed share does not
  // silently absorb the unplaced spend.
  expect(geoCell([country("US", 1000), region("California", 700), region(UNKNOWN_GEO, 300)])).toBe(
    "US 100%\nCalifornia 70% · unknown 30%",
  );
});

test("exactly eight material entries get no `+0 more` suffix", () => {
  const cell = geoCell(Array.from({ length: 8 }, (_, i) => country(`C${i}`, 100 - i)));
  expect(cell.includes("more")).toBe(false);
  expect(cell.split(" · ")).toHaveLength(8);
});

test("when every share is sub-threshold the leader is still named", () => {
  // A worldwide campaign spread over 100+ buckets puts every entry under 1%, and a bare "+101 more"
  // is a cell with no content.
  expect(geoCell(Array.from({ length: 101 }, (_, i) => country(`C${i}`, 1)))).toBe("C0 1% · +100 more");
});

test("equal spends order by value, so the cell text is a function of the data alone", () => {
  const a = geoCell([country("US", 600), country("ZA", 200), country("GE", 200)]);
  const b = geoCell([country("GE", 200), country("US", 600), country("ZA", 200)]);
  expect(a).toBe(b);
  expect(a).toBe("US 60% · GE 20% · ZA 20%");
});

test("spend Meta cannot express as a positive number stays out of the denominator", () => {
  // A refund row must not shift the shares of the rows that did deliver.
  expect(geoCell([country("US", 100), country("CA", -5)])).toBe("US 100%");
});

test("a region line whose only surviving entry is `unknown` is suppressed too", () => {
  // The guard must test what the line will NAME, not the raw rows. Region attribution is mostly
  // unplaced, so a named region often falls under MIN_SHARE and is filtered out of the rendered
  // line, leaving `unknown` alone on it.
  expect(geoCell([country("US", 1000), region("California", 5), region(UNKNOWN_GEO, 995)])).toBe(
    "US 100%",
  );
  // Exactly MIN_SHARE is kept, so the named region survives and the line with it. Without this,
  // mutating the filter to `> MIN_SHARE` passes every other test in this file while silently
  // deleting the second line from rows like these.
  expect(geoCell([country("US", 1000), region("California", 10), region(UNKNOWN_GEO, 990)])).toBe(
    "US 100%\nunknown 99% · California 1%",
  );
});

test("a named region surviving only as the leader still gets its line", () => {
  // 101 thin named regions: none clears MIN_SHARE, so the leader exception names one. That line does
  // name a place, so the suppression rule must not swallow it.
  const regions = Array.from({ length: 101 }, (_, i) => region(`R${i}`, 1));
  expect(geoCell([country("US", 1000), ...regions])).toBe("US 100%\nR0 1% · +100 more");
});
