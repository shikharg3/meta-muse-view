import { describe, expect, it } from "bun:test";
import {
  claimCampaigns,
  defaultCommissionLookup,
  narrowToPortalBrands,
  portalBrands,
  portalClients,
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

describe("claimCampaigns", () => {
  // Two clients of one owner covering the same account: the campaign is billed through ONE of them,
  // and it must be the same one on every load — and the one the staff dialog prices (first by name).
  const sports = {
    brandId: "b_sports",
    clientId: "owner",
    name: "Acme Sports",
    campaigns: [
      { id: "c_shared", group: { key: "sports", name: "Sports" }, groupId: "owner:sports" },
    ],
  };
  const casino = {
    brandId: "b_casino",
    clientId: "owner",
    name: "Acme Casino",
    campaigns: [
      { id: "c_shared", group: undefined, groupId: undefined },
      { id: "c_own", group: { key: "casino", name: "Casino" }, groupId: "owner:casino" },
    ],
  };

  it("gives a shared campaign to the first client by name, whatever order the rows arrive in", () => {
    for (const order of [
      [sports, casino],
      [casino, sports],
    ]) {
      const { brandOf, groupOf } = claimCampaigns(order);
      expect(brandOf.get("c_shared")).toBe("b_casino");
      // Its Brand comes from the same client: Casino covers it under no row, so it has none,
      // rather than pairing Sports' Brand with Casino's default.
      expect(groupOf.has("c_shared")).toBe(false);
      expect(brandOf.get("c_own")).toBe("b_casino");
    }
  });
});

/** When the fixtures' commission entries start; `ON` is a day they are all in force. */
const SINCE = "2025-03-24";
const ON = "2026-06-15";

/** A one-entry schedule from `SINCE`, or none: what a rate set once and never changed looks like. */
const since = (rate: number | null) => (rate === null ? [] : [{ fromDate: SINCE, rate }]);

const brand = (id: string, commission: number | null): ScopedBrand => ({
  id,
  clientId: "owner",
  name: id,
  pageName: null,
  pageAvatarUrl: null,
  commission: since(commission),
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
  commission: since(commission),
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
    expect(rateOf("c_override", ON)).toBe(25);
  });

  it("honours a group deliberately set to 0% instead of falling through to the brand", () => {
    expect(rateOf("c_zero", ON)).toBe(0);
  });

  it("inherits the brand's rate when the group sets none, or the campaign has no group", () => {
    expect(rateOf("c_inherit", ON)).toBe(15);
    expect(rateOf("c_no_group", ON)).toBe(15);
  });

  it("falls back to the default when neither group nor brand sets a rate", () => {
    expect(rateOf("c_unset", ON)).toBe(10);
  });

  it("sets nothing before the entries begin, so those days fall through to the default", () => {
    expect(rateOf("c_override", "2025-03-23")).toBe(10);
    expect(rateOf("c_override", SINCE)).toBe(25);
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
      { id: "b1", name: "Acme Holdings", clientId: "b1" },
      { id: "owner:acme", name: "acme", clientId: "b1" },
      { id: "owner:zeta", name: "zeta", clientId: "b1" },
    ]);
  });

  it("lists a group two clients reach under one of them, whatever order campaigns arrive in", () => {
    // Two `brands` rows of one owner can cover the same group. It must appear once and under the
    // same client on every load; `campaignIds` follows database order, so it cannot decide.
    const clients = [
      { ...brand("b_zulu", null), name: "Zulu" },
      { ...brand("b_alpha", null), name: "Alpha" },
    ];
    const groups = [group("shared", "b_zulu", null)];
    const zuluFirst = scopeOf(
      clients,
      { c_z: { brand: "b_zulu", group: "shared" }, c_a: { brand: "b_alpha", group: "shared" } },
      groups,
    );
    const alphaFirst = scopeOf(
      clients,
      { c_a: { brand: "b_alpha", group: "shared" }, c_z: { brand: "b_zulu", group: "shared" } },
      groups,
    );
    const expected = [{ id: "owner:shared", name: "shared", clientId: "b_alpha" }];
    expect(portalBrands(zuluFirst)).toEqual(expected);
    expect(portalBrands(alphaFirst)).toEqual(expected);
    // …and the client it is not listed under is not offered as an empty one.
    expect(portalClients(zuluFirst, portalBrands(zuluFirst))).toEqual([
      { id: "b_alpha", name: "Alpha" },
    ]);
  });

  it("projects clients to an id and a name only", () => {
    // `ScopedBrand` carries the default commission and ad accounts; neither may reach a client.
    expect(portalClients(scope, portalBrands(scope))).toEqual([
      { id: "b1", name: "Acme Holdings" },
    ]);
  });

  it("narrows to one group's campaigns and keeps billing them at their client's default", () => {
    // Dropping the client from the narrowed scope would silently re-price them at the fallback.
    const narrowed = narrowToPortalBrands(scope, ["owner:acme"]);
    expect(narrowed.campaignIds).toEqual(["c_sept", "c_aug"]);
    expect(defaultCommissionLookup(narrowed, 10)("c_aug", ON)).toBe(15);
  });

  it("treats the client's own id as its row-less campaigns only, not the whole client", () => {
    // Otherwise picking it beside a group would count that group's campaigns twice.
    expect(narrowToPortalBrands(scope, ["b1"]).campaignIds).toEqual(["c_manual"]);
  });

  it("shows everything for a selection naming nothing in scope", () => {
    expect(narrowToPortalBrands(scope, ["stale-id"]).campaignIds).toEqual(scope.campaignIds);
  });
});
