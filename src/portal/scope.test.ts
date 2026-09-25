import { describe, expect, it } from "bun:test";
import {
  defaultCommissionLookup,
  visibleUnderGrants,
  type GrantNarrowing,
  type PortalScope,
  type ScopedBrand,
  type ScopedProject,
} from "@/portal/scope";

/**
 * Pure halves of `portalScope()`: which campaigns a set of grants opens, and which rate a campaign
 * is marked up at. Both decide what a client sees, so the cases are the ways a grant or a setting
 * could reach further than intended.
 */

const narrowing = (over: Partial<GrantNarrowing>): GrantNarrowing => ({
  wholeBrands: new Set(),
  projects: new Map(),
  campaigns: new Set(),
  ...over,
});

const campaigns = [
  { id: "c_sept", projectId: "p_sept" },
  { id: "c_aug", projectId: "p_aug" },
  { id: "c_manual", projectId: undefined }, // on an account no covered project lists
];

describe("visibleUnderGrants", () => {
  it("opens every campaign of a brand granted outright", () => {
    const n = narrowing({ wholeBrands: new Set(["b1"]) });
    expect(visibleUnderGrants("b1", campaigns, n)).toEqual(["c_sept", "c_aug", "c_manual"]);
  });

  it("opens only the granted project's campaigns", () => {
    const n = narrowing({ projects: new Map([["b1", new Set(["p_sept"])]]) });
    expect(visibleUnderGrants("b1", campaigns, n)).toEqual(["c_sept"]);
  });

  it("opens nothing for a project granted through a different brand", () => {
    // Two brands of one owner can cover the same board row. A grant is held THROUGH one of them,
    // and must not surface the row's campaigns under the other brand's name and rates.
    const n = narrowing({ projects: new Map([["b2", new Set(["p_sept"])]]) });
    expect(visibleUnderGrants("b1", campaigns, n)).toEqual([]);
  });

  it("never reaches a project-less campaign through a project grant, only through its own", () => {
    const viaProject = narrowing({ projects: new Map([["b1", new Set(["p_sept", "p_aug"])]]) });
    expect(visibleUnderGrants("b1", campaigns, viaProject)).not.toContain("c_manual");
    const viaCampaign = narrowing({ campaigns: new Set(["c_manual"]) });
    expect(visibleUnderGrants("b1", campaigns, viaCampaign)).toEqual(["c_manual"]);
  });
});

const brand = (id: string, defaultCommission: number | null): ScopedBrand => ({
  id,
  clientId: "owner",
  name: id,
  pageName: null,
  pageAvatarUrl: null,
  defaultCommission,
  accountIds: [],
});

const project = (pageId: string, brandId: string, commission: number | null): ScopedProject => ({
  pageId,
  title: pageId,
  brandId,
  pageName: null,
  pageAvatarUrl: null,
  commission,
});

const scopeOf = (
  brands: ScopedBrand[],
  placement: Record<string, { brand: string; project?: string }>,
  projects: ScopedProject[],
): PortalScope => ({
  actor: { id: "u", email: "u@example.com", name: null, status: "approved" },
  brands,
  campaignIds: Object.keys(placement),
  aliasOf: new Map(Object.keys(placement).map((id) => [id, id])),
  brandOf: new Map(Object.entries(placement).map(([id, p]) => [id, p.brand])),
  projectOf: new Map(
    Object.entries(placement).flatMap(([id, p]) => (p.project ? [[id, p.project]] : [])),
  ),
  projects: new Map(projects.map((p) => [p.pageId, p])),
});

describe("defaultCommissionLookup", () => {
  const scope = scopeOf(
    [brand("b1", 15), brand("b_unset", null)],
    {
      c_override: { brand: "b1", project: "p_own" },
      c_zero: { brand: "b1", project: "p_zero" },
      c_inherit: { brand: "b1", project: "p_inherit" },
      c_no_project: { brand: "b1" },
      c_unset: { brand: "b_unset", project: "p_unset" },
    },
    [
      project("p_own", "b1", 25),
      project("p_zero", "b1", 0),
      project("p_inherit", "b1", null),
      project("p_unset", "b_unset", null),
    ],
  );
  const rateOf = defaultCommissionLookup(scope, 10);

  it("uses the project's own rate over its brand's", () => {
    expect(rateOf("c_override")).toBe(25);
  });

  it("honours a project deliberately set to 0% instead of falling through to the brand", () => {
    expect(rateOf("c_zero")).toBe(0);
  });

  it("inherits the brand's rate when the project sets none, or the campaign has no project", () => {
    expect(rateOf("c_inherit")).toBe(15);
    expect(rateOf("c_no_project")).toBe(15);
  });

  it("falls back to the default when neither project nor brand sets a rate", () => {
    expect(rateOf("c_unset")).toBe(10);
  });
});
