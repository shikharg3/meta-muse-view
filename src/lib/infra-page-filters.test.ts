import { describe, expect, test } from "bun:test";
import {
  FACET_NONE,
  FACET_UNKNOWN,
  NO_FACETS,
  decoratePages,
  facetOptions,
  filterByFacets,
  matchesFacet,
  pageHref,
  pageUrlExport,
  type Facets,
  type PageFacetRow,
} from "./infra-page-filters";
import type { ProfileStatus } from "./infra-status";

interface RawPage {
  id: string;
  name: string;
  pageUrl: string;
  status: string;
  ownerProfileId: string;
  bmIds: string[];
  profileIds: string[];
}

const page = (over: Partial<RawPage> & { id: string }): RawPage => ({
  name: over.id,
  pageUrl: `facebook.com/${over.id}`,
  status: "active",
  ownerProfileId: "owner-a",
  bmIds: [],
  profileIds: [],
  ...over,
});

const PROFILES: Record<string, { name: string; statuses: ProfileStatus[] }> = {
  "owner-a": { name: "Alice", statuses: ["active"] },
  "owner-b": { name: "Bob", statuses: ["suspended"] },
  "prof-c": { name: "Carol", statuses: ["active"] },
};

const BMS: Record<string, string> = { "bm-1": "Main BM", "bm-2": "Backup BM" };

const decorate = (pages: RawPage[]) => decoratePages(pages, (id) => PROFILES[id]);

const names = {
  profile: (id: string) => PROFILES[id]?.name,
  bm: (id: string) => BMS[id],
};

const facets = (over: Partial<Facets>): Facets => ({ ...NO_FACETS, ...over });

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

describe("pageHref", () => {
  test("adds https to a scheme-less value — an exported list must be clickable", () => {
    expect(pageHref("facebook.com/acme")).toBe("https://facebook.com/acme");
  });

  test("leaves an existing scheme alone, including http", () => {
    expect(pageHref("https://facebook.com/acme")).toBe("https://facebook.com/acme");
    expect(pageHref("http://facebook.com/acme")).toBe("http://facebook.com/acme");
  });

  test("a blank or whitespace-only URL is null, not 'https://'", () => {
    expect(pageHref("")).toBeNull();
    expect(pageHref("   ")).toBeNull();
  });
});

describe("decoratePages", () => {
  test("resolves the owner and carries its statuses", () => {
    const [row] = decorate([
      page({ id: "p1", ownerProfileId: "owner-a", bmIds: ["bm-1", "bm-2"] }),
    ]);
    expect(row.ownerName).toBe("Alice");
    expect(row.ownerKey).toBe("owner-a");
    expect(row.ownerUsable).toBe(true);
    expect(row.risk.level).toBe("safe");
  });

  test("a missing owner is the worst case and keys as unknown, never dropped", () => {
    const [row] = decorate([page({ id: "p1", ownerProfileId: "ghost" })]);
    expect(row.ownerName).toBeNull();
    expect(row.ownerKey).toBe(FACET_UNKNOWN);
    expect(row.ownerUsable).toBe(false);
    expect(row.risk).toEqual({ level: "critical", label: "No active owner" });
  });

  test("an unrecognized status reads as restricted for risk, not as safe", () => {
    const [row] = decorate([page({ id: "p1", status: "whatever", bmIds: ["bm-1"] })]);
    expect(row.risk).toEqual({ level: "warning", label: "Restricted" });
  });
});

describe("matchesFacet", () => {
  const [row] = decorate([page({ id: "p1", status: "banned", bmIds: ["bm-1"] })]);

  test("an empty selection is not a filter", () => {
    expect(matchesFacet(row, "status", [])).toBe(true);
  });

  test("OR within a facet", () => {
    expect(matchesFacet(row, "status", ["restricted", "banned"])).toBe(true);
    expect(matchesFacet(row, "status", ["restricted", "in_review"])).toBe(false);
  });

  test("a link facet matches on any selected id", () => {
    expect(matchesFacet(row, "bm", ["bm-2", "bm-1"])).toBe(true);
    expect(matchesFacet(row, "bm", ["bm-2"])).toBe(false);
  });

  test("the none sentinel matches only an empty link list", () => {
    const [linked] = decorate([page({ id: "p1", bmIds: ["bm-1"] })]);
    const [bare] = decorate([page({ id: "p2" })]);
    expect(matchesFacet(bare, "bm", [FACET_NONE])).toBe(true);
    expect(matchesFacet(linked, "bm", [FACET_NONE])).toBe(false);
  });

  test("the none sentinel beside a real id matches either", () => {
    const [linked] = decorate([page({ id: "p1", profileIds: ["prof-c"] })]);
    const [bare] = decorate([page({ id: "p2" })]);
    const selection = [FACET_NONE, "prof-c"];
    expect(matchesFacet(linked, "profiles", selection)).toBe(true);
    expect(matchesFacet(bare, "profiles", selection)).toBe(true);
  });

  test("risk filters on the decorated level", () => {
    expect(matchesFacet(row, "risk", ["critical"])).toBe(true);
    expect(matchesFacet(row, "risk", ["safe", "warning"])).toBe(false);
  });
});

describe("filterByFacets", () => {
  const rows = decorate([
    page({ id: "p1", status: "banned", ownerProfileId: "owner-a", bmIds: ["bm-1"] }),
    page({ id: "p2", status: "restricted", ownerProfileId: "owner-a", bmIds: ["bm-1", "bm-2"] }),
    page({ id: "p3", status: "banned", ownerProfileId: "owner-b", bmIds: ["bm-2"] }),
    page({ id: "p4", status: "active", ownerProfileId: "owner-a", profileIds: ["prof-c"] }),
  ]);

  test("no facets selected returns everything", () => {
    expect(ids(filterByFacets(rows, NO_FACETS))).toEqual(["p1", "p2", "p3", "p4"]);
  });

  test("AND across facets — the whole point of the feature", () => {
    const selected = facets({ status: ["banned"], bm: ["bm-1"] });
    expect(ids(filterByFacets(rows, selected))).toEqual(["p1"]);
  });

  test("OR inside a facet widens, AND across facets narrows", () => {
    expect(ids(filterByFacets(rows, facets({ status: ["banned", "restricted"] })))).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    expect(
      ids(filterByFacets(rows, facets({ status: ["banned", "restricted"], owner: ["owner-a"] }))),
    ).toEqual(["p1", "p2"]);
  });

  test("owner-only pages are reachable through the profiles sentinel", () => {
    expect(ids(filterByFacets(rows, facets({ profiles: [FACET_NONE] })))).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  test("no-BM-access pages are reachable through the bm sentinel", () => {
    expect(ids(filterByFacets(rows, facets({ bm: [FACET_NONE] })))).toEqual(["p4"]);
  });

  test("except drops exactly one facet from the conjunction", () => {
    const selected = facets({ status: ["banned"], bm: ["bm-1"] });
    expect(ids(filterByFacets(rows, selected, "status"))).toEqual(["p1", "p2"]);
    expect(ids(filterByFacets(rows, selected, "bm"))).toEqual(["p1", "p3"]);
  });
});

describe("facetOptions", () => {
  const rows = decorate([
    page({ id: "p1", status: "banned", ownerProfileId: "owner-a", bmIds: ["bm-1"] }),
    page({ id: "p2", status: "restricted", ownerProfileId: "owner-b", bmIds: ["bm-1", "bm-2"] }),
    page({ id: "p3", status: "active", ownerProfileId: "ghost", profileIds: ["prof-c"] }),
  ]);

  test("every fixed status is offered, including ones no page has", () => {
    const { status } = facetOptions(rows, NO_FACETS, names);
    expect(status.map((o) => o.value)).toEqual([
      "active",
      "in_review",
      "restricted",
      "banned",
      "unpublished",
    ]);
    expect(status.find((o) => o.value === "banned")?.count).toBe(1);
    expect(status.find((o) => o.value === "unpublished")?.count).toBe(0);
  });

  test("an unrecognized status present in the data is appended so those rows stay reachable", () => {
    const odd = decorate([page({ id: "p9", status: "shadowbanned" })]);
    const { status } = facetOptions(odd, NO_FACETS, names);
    expect(status.at(-1)).toEqual({ value: "shadowbanned", label: "shadowbanned", count: 1 });
  });

  test("all three risk levels are offered, worst first", () => {
    const { risk } = facetOptions(rows, NO_FACETS, names);
    expect(risk.map((o) => o.value)).toEqual(["critical", "warning", "safe"]);
  });

  test("entity facets list only ids present, named and sorted A-Z", () => {
    const { owner } = facetOptions(rows, NO_FACETS, names);
    expect(owner).toEqual([
      { value: "owner-a", label: "Alice", count: 1 },
      { value: "owner-b", label: "Bob", count: 1 },
      { value: FACET_UNKNOWN, label: "unknown owner", count: 1 },
    ]);
  });

  test("the none sentinel leads its list and counts the unlinked rows", () => {
    const { bm } = facetOptions(rows, NO_FACETS, names);
    expect(bm).toEqual([
      { value: FACET_NONE, label: "no BM access", count: 1 },
      { value: "bm-2", label: "Backup BM", count: 1 },
      { value: "bm-1", label: "Main BM", count: 2 },
    ]);
  });

  test("counts respect other facets", () => {
    const { bm } = facetOptions(rows, facets({ status: ["banned"] }), names);
    expect(bm.find((o) => o.value === "bm-1")?.count).toBe(1);
  });

  test("a facet's own selection never zeroes its siblings", () => {
    const selected = facets({ status: ["banned"] });
    const { status } = facetOptions(rows, selected, names);
    expect(status.find((o) => o.value === "restricted")?.count).toBe(1);
    expect(status.find((o) => o.value === "banned")?.count).toBe(1);
  });

  test("a selected value stays offered at zero even when other facets scope it away", () => {
    // bm-2 appears only on the `restricted` page, so filtering to `banned` scopes it out of its own
    // list — but it is checked, and an option that disappears cannot be unchecked.
    const selected = facets({ status: ["banned"], bm: ["bm-2"] });
    const { bm } = facetOptions(rows, selected, names);
    expect(bm.find((o) => o.value === "bm-2")).toEqual({
      value: "bm-2",
      label: "Backup BM",
      count: 0,
    });
  });
});

describe("pageUrlExport", () => {
  test("one normalized URL per line, in the order given", () => {
    const out = pageUrlExport([
      { pageUrl: "facebook.com/one" },
      { pageUrl: "https://facebook.com/two" },
    ]);
    expect(out.text).toBe("https://facebook.com/one\nhttps://facebook.com/two");
    expect(out.urls).toHaveLength(2);
    expect(out.missing).toBe(0);
  });

  test("blank URLs are dropped and counted, not exported as empty lines", () => {
    const out = pageUrlExport([
      { pageUrl: "facebook.com/one" },
      { pageUrl: "" },
      { pageUrl: "  " },
    ]);
    expect(out.text).toBe("https://facebook.com/one");
    expect(out.missing).toBe(2);
  });

  test("an all-blank selection exports nothing", () => {
    const out = pageUrlExport([{ pageUrl: "" }]);
    expect(out.urls).toEqual([]);
    expect(out.text).toBe("");
    expect(out.missing).toBe(1);
  });
});

describe("type surface", () => {
  test("a decorated row satisfies PageFacetRow", () => {
    const [row] = decorate([page({ id: "p1" })]);
    const asFacetRow: PageFacetRow = row;
    expect(asFacetRow.risk.level).toBeDefined();
  });
});
