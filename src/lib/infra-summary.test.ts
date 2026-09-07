import { describe, expect, test } from "bun:test";
import { buildInfraGraph, type InfraGraphInput } from "./infra-graph";
import { buildRiskSummary } from "./infra-summary";
import type { InfraNodeKind } from "./infra-graph";
import type { Risk } from "./infra-risk";

const SAFE: Risk = { level: "safe", label: "Redundant" };
const CRITICAL: Risk = { level: "critical", label: "No backup" };
const WARNING: Risk = { level: "warning", label: "Single access" };

function entity(id: string, risk: Risk = SAFE) {
  return { id, name: id, status: "active", risk, detail: "" };
}

function profile(id: string, usable = true) {
  return { ...entity(id), usable };
}

function bm(id: string, risk: Risk = SAFE) {
  return { ...entity(id, risk), usable: true, overdue: false };
}

function graphOf(over: Partial<InfraGraphInput> = {}) {
  return buildInfraGraph({
    profiles: [],
    bms: [],
    adAccounts: [],
    pixels: [],
    pages: [],
    profileBm: [],
    bmAdAccount: [],
    pixelBm: [],
    pageBm: [],
    pageProfile: [],
    ...over,
  });
}

const NONE: Record<InfraNodeKind, number> = {
  profile: 0,
  bm: 0,
  adAccount: 0,
  pixel: 0,
  page: 0,
};

describe("buildRiskSummary tally", () => {
  test("a type's three severity columns add up to what the model scored, not to the registry", () => {
    const graph = graphOf({ adAccounts: [entity("a1", CRITICAL), entity("a2")] });

    const row = buildRiskSummary(graph, { ...NONE, adAccount: 4 }).tally.find(
      (r) => r.kind === "adAccount",
    );

    // Two retired accounts are registered but deliberately unscored, and the matrix has to be able
    // to say so rather than silently showing 2 of 4.
    expect(row).toMatchObject({ critical: 1, warning: 0, safe: 1, scored: 2, registered: 4 });
  });

  test("profiles are tallied but never counted as assets at risk", () => {
    const graph = graphOf({
      profiles: [{ ...entity("blocked", CRITICAL), usable: false }],
      bms: [bm("b1", WARNING)],
      profileBm: [{ profileId: "blocked", bmId: "b1" }],
    });

    const summary = buildRiskSummary(graph, { ...NONE, profile: 1, bm: 1 });

    expect(summary.atRisk).toBe(1);
    expect(summary.tally.find((r) => r.kind === "profile")).toMatchObject({ critical: 1 });
    expect(summary.tally.at(-1)?.kind).toBe("profile");
  });
});

describe("buildRiskSummary concentration", () => {
  test("a profile holding one BM alone is not a concentration", () => {
    const graph = graphOf({
      profiles: [profile("p1")],
      bms: [bm("b1")],
      profileBm: [{ profileId: "p1", bmId: "b1" }],
    });

    expect(buildRiskSummary(graph, { ...NONE, profile: 1, bm: 1 }).concentration).toBeNull();
  });

  test("a BM with a second usable admin has no sole holder", () => {
    const graph = graphOf({
      profiles: [profile("p1"), profile("p2")],
      bms: [bm("b1"), bm("b2")],
      profileBm: [
        { profileId: "p1", bmId: "b1" },
        { profileId: "p1", bmId: "b2" },
        { profileId: "p2", bmId: "b1" },
        { profileId: "p2", bmId: "b2" },
      ],
    });

    expect(buildRiskSummary(graph, { ...NONE, profile: 2, bm: 2 }).concentration).toBeNull();
  });

  test("a blocked profile whose BMs now have no usable admin is named as the cause", () => {
    const graph = graphOf({
      profiles: [{ ...entity("blocked", CRITICAL), usable: false }],
      bms: [bm("b1", CRITICAL), bm("b2", CRITICAL)],
      adAccounts: [entity("act_dark", CRITICAL)],
      profileBm: [
        { profileId: "blocked", bmId: "b1" },
        { profileId: "blocked", bmId: "b2" },
      ],
      bmAdAccount: [{ bmId: "b1", adAccountId: "act_dark" }],
    });

    // Measured on the live registry this is the ONLY form that occurs: one suspended profile is why
    // several BMs read "No backup", and the headline has to be able to say so. `assets` counts what
    // sits behind those BMs, not what is provably unreachable — `usableBm` reads BM status alone.
    expect(
      buildRiskSummary(graph, { ...NONE, profile: 1, bm: 2, adAccount: 1 }).concentration,
    ).toEqual({
      profileId: "blocked",
      name: "blocked",
      blocked: true,
      bms: 2,
      assets: 1,
    });
  });

  test("a realised loss outranks a hypothetical one", () => {
    const graph = graphOf({
      profiles: [
        { ...entity("dead-hand", CRITICAL), usable: false },
        profile("sole-live"),
      ],
      bms: [bm("b1"), bm("b2"), bm("b3"), bm("b4"), bm("b5")],
      profileBm: [
        { profileId: "dead-hand", bmId: "b1" },
        { profileId: "dead-hand", bmId: "b2" },
        { profileId: "sole-live", bmId: "b3" },
        { profileId: "sole-live", bmId: "b4" },
        { profileId: "sole-live", bmId: "b5" },
      ],
    });

    // The live profile holds more BMs, but its loss has not happened yet.
    expect(buildRiskSummary(graph, { ...NONE, profile: 2, bm: 5 }).concentration).toMatchObject({
      profileId: "dead-hand",
      blocked: true,
      bms: 2,
    });
  });

  test("an asset reached from two of the held BMs is still stranded by the one profile", () => {
    const graph = graphOf({
      profiles: [profile("svc")],
      bms: [bm("b1"), bm("b2")],
      adAccounts: [entity("act_both")],
      profileBm: [
        { profileId: "svc", bmId: "b1" },
        { profileId: "svc", bmId: "b2" },
      ],
      bmAdAccount: [
        { bmId: "b1", adAccountId: "act_both" },
        { bmId: "b2", adAccountId: "act_both" },
      ],
    });

    // Walking each BM separately would call this account a survivor — it survives the loss of either
    // BM, but not the loss of the profile that solely holds both.
    expect(buildRiskSummary(graph, { ...NONE, profile: 1, bm: 2, adAccount: 1 })).toMatchObject({
      concentration: { profileId: "svc", bms: 2, blocked: false, assets: 1 },
    });
  });

  test("an asset with an independent live path is not counted as stranded", () => {
    const graph = graphOf({
      profiles: [profile("svc"), profile("other")],
      bms: [bm("b1"), bm("b2"), bm("b3")],
      adAccounts: [entity("act_shared")],
      profileBm: [
        { profileId: "svc", bmId: "b1" },
        { profileId: "svc", bmId: "b2" },
        { profileId: "other", bmId: "b3" },
      ],
      bmAdAccount: [
        { bmId: "b1", adAccountId: "act_shared" },
        { bmId: "b3", adAccountId: "act_shared" },
      ],
    });

    expect(buildRiskSummary(graph, { ...NONE, profile: 2, bm: 3, adAccount: 1 })).toMatchObject({
      concentration: { profileId: "svc", bms: 2, assets: 0 },
    });
  });

  test("an asset nothing can reach today is not attributed to this ban", () => {
    const graph = graphOf({
      profiles: [profile("svc")],
      bms: [bm("b1"), bm("b2")],
      adAccounts: [entity("act_orphan", CRITICAL)],
      profileBm: [
        { profileId: "svc", bmId: "b1" },
        { profileId: "svc", bmId: "b2" },
      ],
    });

    expect(
      buildRiskSummary(graph, { ...NONE, profile: 1, bm: 2, adAccount: 1 }).concentration,
    ).toMatchObject({ assets: 0 });
  });

  test("the widest holder wins, and equal holders break on name", () => {
    const graph = graphOf({
      profiles: [profile("zeta"), profile("alpha"), profile("wide")],
      bms: [bm("b1"), bm("b2"), bm("b3"), bm("b4"), bm("b5"), bm("b6"), bm("b7")],
      profileBm: [
        { profileId: "zeta", bmId: "b1" },
        { profileId: "zeta", bmId: "b2" },
        { profileId: "alpha", bmId: "b3" },
        { profileId: "alpha", bmId: "b4" },
        { profileId: "wide", bmId: "b5" },
        { profileId: "wide", bmId: "b6" },
        { profileId: "wide", bmId: "b7" },
      ],
    });

    expect(buildRiskSummary(graph, { ...NONE, profile: 3, bm: 7 }).concentration).toMatchObject({
      profileId: "wide",
      bms: 3,
    });

    const tied = graphOf({
      profiles: [profile("zeta"), profile("alpha")],
      bms: [bm("b1"), bm("b2"), bm("b3"), bm("b4")],
      profileBm: [
        { profileId: "zeta", bmId: "b1" },
        { profileId: "zeta", bmId: "b2" },
        { profileId: "alpha", bmId: "b3" },
        { profileId: "alpha", bmId: "b4" },
      ],
    });

    expect(buildRiskSummary(tied, { ...NONE, profile: 2, bm: 4 }).concentration?.profileId).toBe(
      "alpha",
    );
  });
});
