import { describe, expect, test } from "bun:test";
import {
  buildInfraGraph,
  focusMain,
  nodeId,
  reachedFrom,
  type InfraGraph,
  type InfraGraphInput,
} from "./infra-graph";
import type { Risk } from "./infra-risk";

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

describe("nodeId", () => {
  test("is the composition the rest of the module relies on", () => {
    expect(nodeId("adAccount", "act_123")).toBe("adAccount:act_123");
  });
});

describe("reachedFrom", () => {
  test("a dead alternative path is not a survivor: it is drawn, but it cannot let anyone in", () => {
    const g = buildInfraGraph(
      input({
        profiles: [
          { ...entity("live"), usable: true },
          { ...entity("banned"), usable: false },
        ],
        bms: [
          { ...entity("b1"), usable: true, overdue: false },
          { ...entity("b2"), usable: true, overdue: false },
        ],
        adAccounts: [entity("act_1")],
        pages: [{ ...entity("pg_1"), ownerProfileId: "banned" }],
        profileBm: [
          { profileId: "live", bmId: "b1" },
          { profileId: "banned", bmId: "b2" },
        ],
        bmAdAccount: [
          { bmId: "b1", adAccountId: "act_1" },
          { bmId: "b2", adAccountId: "act_1" },
        ],
        pageBm: [{ pageId: "pg_1", bmId: "b1" }],
      }),
    );

    const reached = reachedFrom(g, nodeId("bm", "b1"));

    // b2 also reaches the account, but b2's only admin is banned, so losing b1 strands it anyway.
    expect(reached.adAccount).toEqual([
      { id: "act_1", name: "act_1", risk: "safe", detail: "", otherLivePaths: 1 },
    ]);
    // The page's owner profile is banned too, so the BM is its last live way in.
    expect(reached.page[0].otherLivePaths).toBe(0);
  });

  test("a pixel both rooted in and shared with the same BM is reached once, not twice", () => {
    const g = buildInfraGraph(
      input({
        bms: [{ ...entity("b1"), usable: true, overdue: false }],
        pixels: [{ ...entity("px_1"), rootBmId: "b1" }],
        pixelBm: [{ pixelId: "px_1", bmId: "b1" }],
      }),
    );

    expect(reachedFrom(g, nodeId("bm", "b1")).pixel).toHaveLength(1);
  });

  test("profiles and BMs are never reported as losses — they are the paths, not the assets", () => {
    const g = buildInfraGraph(
      input({
        profiles: [{ ...entity("p1"), usable: true }],
        bms: [{ ...entity("b1"), usable: true, overdue: false }],
        profileBm: [{ profileId: "p1", bmId: "b1" }],
      }),
    );

    expect(reachedFrom(g, nodeId("profile", "p1"))).toEqual({
      adAccount: [],
      pixel: [],
      page: [],
    });
  });
});

describe("focusMain", () => {
  test("keeps a starred BM, what admins it and what it reaches — and nothing else", () => {
    const g = buildInfraGraph(
      input({
        profiles: [
          { ...entity("admin-1"), usable: true },
          { ...entity("stranger"), usable: true },
        ],
        bms: [
          { ...entity("starred"), usable: true, overdue: false, main: true },
          { ...entity("other"), usable: true, overdue: false },
        ],
        adAccounts: [entity("act_kept"), entity("act_dropped")],
        profileBm: [
          { profileId: "admin-1", bmId: "starred" },
          { profileId: "stranger", bmId: "other" },
        ],
        bmAdAccount: [
          { bmId: "starred", adAccountId: "act_kept" },
          { bmId: "other", adAccountId: "act_dropped" },
        ],
      }),
    );

    const focused = focusMain(g);

    expect(focused.nodes.map((n) => n.id).sort()).toEqual([
      "adAccount:act_kept",
      "bm:starred",
      "profile:admin-1",
    ]);
    expect(focused.edges.map((e) => e.id).sort()).toEqual([
      "access|bm:starred|adAccount:act_kept",
      "admin|profile:admin-1|bm:starred",
    ]);
  });

  test("stops at one hop: the second BM of a kept admin is not pulled in", () => {
    const g = buildInfraGraph(
      input({
        profiles: [{ ...entity("shared-admin"), usable: true }],
        bms: [
          { ...entity("starred"), usable: true, overdue: false, main: true },
          { ...entity("also-admined"), usable: true, overdue: false },
        ],
        profileBm: [
          { profileId: "shared-admin", bmId: "starred" },
          { profileId: "shared-admin", bmId: "also-admined" },
        ],
      }),
    );

    // Two hops would reach every BM that profile touches, and the "main view" would be the estate.
    expect(focusMain(g).nodes.map((n) => n.id)).not.toContain("bm:also-admined");
  });

  test("an edge between two kept neighbours of different stars is not drawn", () => {
    const g = buildInfraGraph(
      input({
        profiles: [
          { ...entity("owner"), usable: true, main: true },
          { ...entity("other-owner"), usable: true },
        ],
        bms: [{ ...entity("starred"), usable: true, overdue: false, main: true }],
        pages: [{ ...entity("pg"), ownerProfileId: "other-owner" }],
        pageBm: [{ pageId: "pg", bmId: "starred" }],
        pageProfile: [{ pageId: "pg", profileId: "owner" }],
      }),
    );

    const focused = focusMain(g);

    // The page is kept (a star reaches it) and so is its owner (via the page), but owner→page is a
    // relationship neither star asked about.
    expect(focused.nodes.map((n) => n.id)).toContain("page:pg");
    expect(focused.edges.map((e) => e.id)).not.toContain("owns|profile:other-owner|page:pg");
  });

  test("nothing starred yields an empty graph, so the lens is offered only when it can work", () => {
    const g = buildInfraGraph(input({ bms: [{ ...entity("b1"), usable: true, overdue: false }] }));

    expect(focusMain(g)).toEqual({ nodes: [], edges: [] });
  });
});
