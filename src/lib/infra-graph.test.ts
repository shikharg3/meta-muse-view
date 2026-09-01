import { describe, expect, test } from "bun:test";
import {
  buildInfraGraph,
  focusOnRisk,
  neighbourhood,
  nodeId,
  subgraph,
  type InfraGraph,
  type InfraGraphInput,
} from "./infra-graph";
import { redundancy, type Risk } from "./infra-risk";

const SAFE: Risk = { level: "safe", label: "Redundant" };
const CRITICAL: Risk = { level: "critical", label: "No backup" };
const WARNING: Risk = { level: "warning", label: "Single access" };

function entity(id: string, risk: Risk = SAFE) {
  return { id, name: id, status: "active", risk, detail: "" };
}

function input(over: Partial<InfraGraphInput> = {}): InfraGraphInput {
  return {
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
  };
}

const relationOf = (g: InfraGraph, source: string, target: string) =>
  g.edges.find((e) => e.source === source && e.target === target)?.relation;

describe("buildInfraGraph", () => {
  test("node ids are namespaced by kind, so a page and a BM sharing a row id do not collide", () => {
    const g = buildInfraGraph(
      input({
        bms: [{ ...entity("x"), usable: true, overdue: false }],
        pages: [{ ...entity("x"), ownerProfileId: "p" }],
        profiles: [{ ...entity("p"), usable: true }],
      }),
    );
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(3);
    expect(g.nodes.map((n) => n.id)).toContain("bm:x");
    expect(g.nodes.map((n) => n.id)).toContain("page:x");
  });

  test("access flows profile → BM → ad account", () => {
    const g = buildInfraGraph(
      input({
        profiles: [{ ...entity("p1"), usable: true }],
        bms: [{ ...entity("b1"), usable: true, overdue: false }],
        adAccounts: [entity("act_1")],
        profileBm: [{ profileId: "p1", bmId: "b1" }],
        bmAdAccount: [{ bmId: "b1", adAccountId: "act_1" }],
      }),
    );
    expect(relationOf(g, "profile:p1", "bm:b1")).toBe("admin");
    expect(relationOf(g, "bm:b1", "adAccount:act_1")).toBe("access");
  });

  test("a pixel's root BM and its shares are distinguishable edges", () => {
    const g = buildInfraGraph(
      input({
        bms: [
          { ...entity("root"), usable: true, overdue: false },
          { ...entity("shared"), usable: true, overdue: false },
        ],
        pixels: [{ ...entity("px"), rootBmId: "root" }],
        pixelBm: [{ pixelId: "px", bmId: "shared" }],
      }),
    );
    expect(relationOf(g, "bm:root", "pixel:px")).toBe("root");
    expect(relationOf(g, "bm:shared", "pixel:px")).toBe("share");
  });

  test("a page's owner profile is `owns`; additional profiles and BMs are `access`", () => {
    const g = buildInfraGraph(
      input({
        profiles: [
          { ...entity("owner"), usable: true },
          { ...entity("extra"), usable: true },
        ],
        bms: [{ ...entity("b1"), usable: true, overdue: false }],
        pages: [{ ...entity("pg"), ownerProfileId: "owner" }],
        pageProfile: [{ pageId: "pg", profileId: "extra" }],
        pageBm: [{ pageId: "pg", bmId: "b1" }],
      }),
    );
    expect(relationOf(g, "profile:owner", "page:pg")).toBe("owns");
    expect(relationOf(g, "profile:extra", "page:pg")).toBe("access");
    expect(relationOf(g, "bm:b1", "page:pg")).toBe("access");
  });

  test("edges leaving an unusable source are dead — the point of drawing them at all", () => {
    const g = buildInfraGraph(
      input({
        profiles: [
          { ...entity("blocked"), usable: false },
          { ...entity("live"), usable: true },
        ],
        bms: [{ ...entity("b1"), usable: false, overdue: true }],
        adAccounts: [entity("act_1")],
        profileBm: [
          { profileId: "blocked", bmId: "b1" },
          { profileId: "live", bmId: "b1" },
        ],
        bmAdAccount: [{ bmId: "b1", adAccountId: "act_1" }],
      }),
    );
    const dead = (s: string, t: string) =>
      g.edges.find((e) => e.source === s && e.target === t)?.dead;
    expect(dead("profile:blocked", "bm:b1")).toBe(true);
    expect(dead("profile:live", "bm:b1")).toBe(false);
    // A suspended BM cannot carry access onward, even though the link row exists.
    expect(dead("bm:b1", "adAccount:act_1")).toBe(true);
  });

  test("a link to an entity that is not a node is dropped, not left dangling", () => {
    // Retired ad accounts are filtered out upstream; their link rows still exist in the DB.
    const g = buildInfraGraph(
      input({
        bms: [{ ...entity("b1"), usable: true, overdue: false }],
        adAccounts: [],
        bmAdAccount: [{ bmId: "b1", adAccountId: "act_retired" }],
      }),
    );
    expect(g.edges).toEqual([]);
  });

  test("duplicate link rows collapse to one edge", () => {
    const g = buildInfraGraph(
      input({
        profiles: [{ ...entity("p1"), usable: true }],
        bms: [{ ...entity("b1"), usable: true, overdue: false }],
        profileBm: [
          { profileId: "p1", bmId: "b1" },
          { profileId: "p1", bmId: "b1" },
        ],
      }),
    );
    expect(g.edges).toHaveLength(1);
  });

  test("nodes come out grouped by kind then name, so the layout is stable across loads", () => {
    const g = buildInfraGraph(
      input({
        profiles: [
          { ...entity("zed"), usable: true },
          { ...entity("amy"), usable: true },
        ],
        bms: [{ ...entity("bee"), usable: true, overdue: false }],
      }),
    );
    expect(g.nodes.map((n) => n.id)).toEqual(["profile:amy", "profile:zed", "bm:bee"]);
  });

  test("BM overdue verification rides along on the node", () => {
    const g = buildInfraGraph(input({ bms: [{ ...entity("b1"), usable: true, overdue: true }] }));
    expect(g.nodes[0].overdue).toBe(true);
  });
});

describe("focusOnRisk", () => {
  const risky = buildInfraGraph(
    input({
      profiles: [
        { ...entity("p_attached"), usable: true },
        { ...entity("p_orphan"), usable: true },
      ],
      bms: [
        { ...entity("b_broken", CRITICAL), usable: false, overdue: true },
        { ...entity("b_fine"), usable: true, overdue: false },
      ],
      adAccounts: [entity("act_far")],
      profileBm: [{ profileId: "p_attached", bmId: "b_broken" }],
      bmAdAccount: [{ bmId: "b_fine", adAccountId: "act_far" }],
    }),
  );

  test("keeps at-risk nodes and their one-hop neighbours", () => {
    const focused = focusOnRisk(risky);
    expect(focused.nodes.map((n) => n.id).sort()).toEqual(["bm:b_broken", "profile:p_attached"]);
  });

  test("drops safe nodes that are not adjacent to anything at risk", () => {
    const kept = new Set(focusOnRisk(risky).nodes.map((n) => n.id));
    expect(kept.has("profile:p_orphan")).toBe(false);
    expect(kept.has("adAccount:act_far")).toBe(false);
  });

  test("an entirely healthy registry focuses to nothing rather than to everything", () => {
    const healthy = buildInfraGraph(
      input({
        profiles: [{ ...entity("p1"), usable: true }],
        bms: [{ ...entity("b1"), usable: true, overdue: false }],
        profileBm: [{ profileId: "p1", bmId: "b1" }],
      }),
    );
    expect(focusOnRisk(healthy)).toEqual({ nodes: [], edges: [] });
  });

  test("a warning is at risk too, not just a critical", () => {
    const g = buildInfraGraph(
      input({ bms: [{ ...entity("b1", WARNING), usable: true, overdue: false }] }),
    );
    expect(focusOnRisk(g).nodes.map((n) => n.id)).toEqual(["bm:b1"]);
    expect(redundancy(1).level).toBe("warning"); // the rule this test is standing in for
  });
});

describe("subgraph", () => {
  test("an edge whose endpoint was filtered out goes with it", () => {
    const g = buildInfraGraph(
      input({
        profiles: [{ ...entity("p1"), usable: true }],
        bms: [{ ...entity("b1"), usable: true, overdue: false }],
        profileBm: [{ profileId: "p1", bmId: "b1" }],
      }),
    );
    expect(subgraph(g, new Set(["bm:b1"]))).toEqual({ nodes: [g.nodes[1]], edges: [] });
  });
});

describe("neighbourhood", () => {
  test("reaches both upstream and downstream, and includes the node itself", () => {
    const g = buildInfraGraph(
      input({
        profiles: [{ ...entity("p1"), usable: true }],
        bms: [{ ...entity("b1"), usable: true, overdue: false }],
        adAccounts: [entity("act_1"), entity("act_2")],
        profileBm: [{ profileId: "p1", bmId: "b1" }],
        bmAdAccount: [{ bmId: "b1", adAccountId: "act_1" }],
      }),
    );
    expect([...neighbourhood(g, "bm:b1")].sort()).toEqual([
      "adAccount:act_1",
      "bm:b1",
      "profile:p1",
    ]);
  });
});

describe("nodeId", () => {
  test("is the composition the rest of the module relies on", () => {
    expect(nodeId("adAccount", "act_123")).toBe("adAccount:act_123");
  });
});
