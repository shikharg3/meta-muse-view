import { describe, expect, it } from "bun:test";
import {
  defaultCommissionLookup,
  narrowToPortalBrands,
  portalBrands,
  visibleUnderGrants,
  type GrantNarrowing,
  type PortalScope,
  type ScopedBrand,
  type ScopedGroup,
} from "@/portal/scope";

/**
 * Pure halves of `portalScope()`: which campaigns a set of grants opens, which rate a campaign is
 * marked up at, and which brand a customer sees it under. All three decide what a client sees, so
 * the cases are the ways a grant or a setting could reach further than intended.
 */

const narrowing = (over: Partial<GrantNarrowing>): GrantNarrowing => ({
  wholeBrands: new Set(),
  groups: new Map(),
  campaigns: new Set(),
  ...over,
});

const campaigns = [
  { id: "c_sept", groupId: "owner:acme" },
  { id: "c_other", groupId: "owner:zeta" },
  { id: "c_manual", groupId: undefined }, // on an account no covered board row lists
];

describe("visibleUnderGrants", () => {
  it("opens every campaign of a brand granted outright", () => {
    const n = narrowing({ wholeBrands: new Set(["b1"]) });
    expect(visibleUnderGrants("b1", campaigns, n)).toEqual(["c_sept", "c_other", "c_manual"]);
  });

  it("opens only the granted group's campaigns", () => {
    const n = narrowing({ groups: new Map([["b1", new Set(["owner:acme"])]]) });
    expect(visibleUnderGrants("b1", campaigns, n)).toEqual(["c_sept"]);
  });

  it("opens nothing for a group granted through a different brand", () => {
    // Two brands of one owner can cover the same group. A grant is held THROUGH one of them, and
    // must not surface the group's campaigns under the other brand's name and rates.
    const n = narrowing({ groups: new Map([["b2", new Set(["owner:acme"])]]) });
    expect(visibleUnderGrants("b1", campaigns, n)).toEqual([]);
  });

  it("never reaches a group-less campaign through a group grant, only through its own", () => {
    const viaGroup = narrowing({
      groups: new Map([["b1", new Set(["owner:acme", "owner:zeta"])]]),
    });
    expect(visibleUnderGrants("b1", campaigns, viaGroup)).not.toContain("c_manual");
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

const group = (key: string, brandId: string, commission: number | null): ScopedGroup => ({
  id: `owner:${key}`,
  key,
  clientId: "owner",
  brandId,
  name: key,
  pageName: null,
  pageAvatarUrl: null,
  commission,
});

const scopeOf = (
  brands: ScopedBrand[],
  placement: Record<string, { brand: string; group?: string }>,
  groups: ScopedGroup[],
): PortalScope => ({
  actor: { id: "u", email: "u@example.com", name: null, status: "approved" },
  brands,
  campaignIds: Object.keys(placement),
  aliasOf: new Map(Object.keys(placement).map((id) => [id, id])),
  brandOf: new Map(Object.entries(placement).map(([id, p]) => [id, p.brand])),
  groupOf: new Map(
    Object.entries(placement).flatMap(([id, p]) => (p.group ? [[id, `owner:${p.group}`]] : [])),
  ),
  groups: new Map(groups.map((g) => [g.id, g])),
});

describe("defaultCommissionLookup", () => {
  const scope = scopeOf(
    [brand("b1", 15), brand("b_unset", null)],
    {
      c_override: { brand: "b1", group: "own" },
      c_zero: { brand: "b1", group: "zero" },
      c_inherit: { brand: "b1", group: "inherit" },
      c_no_group: { brand: "b1" },
      c_unset: { brand: "b_unset", group: "unset" },
    },
    [
      group("own", "b1", 25),
      group("zero", "b1", 0),
      group("inherit", "b1", null),
      group("unset", "b_unset", null),
    ],
  );
  const rateOf = defaultCommissionLookup(scope, 10);

  it("uses the group's own rate over its brand's", () => {
    expect(rateOf("c_override")).toBe(25);
  });

  it("honours a group deliberately set to 0% instead of falling through to the brand", () => {
    expect(rateOf("c_zero")).toBe(0);
  });

  it("inherits the brand's rate when the group sets none, or the campaign has no group", () => {
    expect(rateOf("c_inherit")).toBe(15);
    expect(rateOf("c_no_group")).toBe(15);
  });

  it("falls back to the default when neither group nor brand sets a rate", () => {
    expect(rateOf("c_unset")).toBe(10);
  });
});

describe("portal brands", () => {
  // One client with two Brands (groups), plus a campaign on an account no row lists.
  const scope = scopeOf(
    [{ ...brand("b1", 15), name: "Acme Holdings" }],
    {
      c_sept: { brand: "b1", group: "acme" },
      c_aug: { brand: "b1", group: "acme" },
      c_zeta: { brand: "b1", group: "zeta" },
      c_manual: { brand: "b1" },
    },
    [group("acme", "b1", null), group("zeta", "b1", null)],
  );

  it("lists each group once, and the client only for campaigns no row lists", () => {
    expect(portalBrands(scope).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "b1", name: "Acme Holdings" },
      { id: "owner:acme", name: "acme" },
      { id: "owner:zeta", name: "zeta" },
    ]);
  });

  it("narrows to one group's campaigns and keeps billing them at their client's default", () => {
    // Dropping the client from the narrowed scope would silently re-price them at the fallback.
    const narrowed = narrowToPortalBrands(scope, ["owner:acme"]);
    expect(narrowed.campaignIds).toEqual(["c_sept", "c_aug"]);
    expect(defaultCommissionLookup(narrowed, 10)("c_aug")).toBe(15);
  });

  it("treats the client's own id as its row-less campaigns only, not the whole client", () => {
    // Otherwise picking it beside a group would count that group's campaigns twice.
    expect(narrowToPortalBrands(scope, ["b1"]).campaignIds).toEqual(["c_manual"]);
  });

  it("shows everything for a selection naming nothing in scope", () => {
    expect(narrowToPortalBrands(scope, ["stale-id"]).campaignIds).toEqual(scope.campaignIds);
  });
});
