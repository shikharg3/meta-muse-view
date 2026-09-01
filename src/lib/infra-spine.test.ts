import { describe, expect, test } from "bun:test";
import { buildInfraGraph, type InfraGraphInput } from "./infra-graph";
import { buildSpine } from "./infra-spine";
import type { Risk } from "./infra-risk";

const SAFE: Risk = { level: "safe", label: "Redundant" };
const CRITICAL: Risk = { level: "critical", label: "No backup" };
const WARNING: Risk = { level: "warning", label: "Single access" };

function entity(id: string, risk: Risk = SAFE) {
  return { id, name: id, status: "active", risk, detail: "" };
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

const profile = (id: string, usable = true, risk: Risk = SAFE) => ({ ...entity(id, risk), usable });
const bm = (id: string, usable = true, risk: Risk = SAFE) => ({
  ...entity(id, risk),
  usable,
  overdue: false,
});

describe("buildSpine — admins", () => {
  test("a profile admining one BM is drawn inside it, with no edge to trace", () => {
    const spine = buildSpine(
      graphOf({
        profiles: [profile("solo")],
        bms: [bm("b1")],
        profileBm: [{ profileId: "solo", bmId: "b1" }],
      }),
    );
    expect(spine.bms[0].inside.map((a) => a.profile.entityId)).toEqual(["solo"]);
    expect(spine.bms[0].shared).toEqual([]);
    expect(spine.sharedProfiles).toEqual([]);
  });

  test("a profile admining two BMs is pulled outside both — the shared-failure signal", () => {
    const spine = buildSpine(
      graphOf({
        profiles: [profile("shared"), profile("solo")],
        bms: [bm("b1"), bm("b2")],
        profileBm: [
          { profileId: "shared", bmId: "b1" },
          { profileId: "shared", bmId: "b2" },
          { profileId: "solo", bmId: "b1" },
        ],
      }),
    );
    expect(spine.sharedProfiles.map((p) => p.entityId)).toEqual(["shared"]);
    for (const entry of spine.bms) {
      expect(entry.shared.map((a) => a.profile.entityId)).toEqual(["shared"]);
      expect(entry.inside.map((a) => a.profile.entityId)).not.toContain("shared");
    }
    expect(
      spine.bms.find((e) => e.bm.entityId === "b1")?.inside.map((a) => a.profile.entityId),
    ).toEqual(["solo"]);
  });

  test("a shared profile is listed once however many cards it touches", () => {
    const spine = buildSpine(
      graphOf({
        profiles: [profile("hub")],
        bms: [bm("b1"), bm("b2"), bm("b3")],
        profileBm: [
          { profileId: "hub", bmId: "b1" },
          { profileId: "hub", bmId: "b2" },
          { profileId: "hub", bmId: "b3" },
        ],
      }),
    );
    expect(spine.sharedProfiles).toHaveLength(1);
    expect(spine.bms.every((e) => e.shared.length === 1)).toBe(true);
  });

  test("usableAdmins counts only live admins, inside and shared alike", () => {
    const spine = buildSpine(
      graphOf({
        profiles: [profile("live"), profile("blocked", false), profile("liveShared")],
        bms: [bm("b1"), bm("b2")],
        profileBm: [
          { profileId: "live", bmId: "b1" },
          { profileId: "blocked", bmId: "b1" },
          { profileId: "liveShared", bmId: "b1" },
          { profileId: "liveShared", bmId: "b2" },
        ],
      }),
    );
    const b1 = spine.bms.find((e) => e.bm.entityId === "b1");
    expect(b1?.usableAdmins).toBe(2);
    expect(b1?.inside.find((a) => a.profile.entityId === "blocked")?.dead).toBe(true);
  });

  test("a BM with no admin at all still gets a card — that is the thing to see", () => {
    const spine = buildSpine(graphOf({ bms: [bm("orphan", false, CRITICAL)] }));
    expect(spine.bms).toHaveLength(1);
    expect(spine.bms[0].inside).toEqual([]);
    expect(spine.bms[0].usableAdmins).toBe(0);
  });

  test("cards are ordered worst first", () => {
    const spine = buildSpine(
      graphOf({
        bms: [
          bm("zzz-safe", true, SAFE),
          bm("aaa-warn", true, WARNING),
          bm("mmm-crit", false, CRITICAL),
        ],
      }),
    );
    expect(spine.bms.map((e) => e.bm.entityId)).toEqual(["mmm-crit", "aaa-warn", "zzz-safe"]);
  });
});

describe("buildSpine — endpoints", () => {
  test("an ad account reached by two BMs is one node with both sources", () => {
    const spine = buildSpine(
      graphOf({
        bms: [bm("b1"), bm("b2", false)],
        adAccounts: [entity("act_1")],
        bmAdAccount: [
          { bmId: "b1", adAccountId: "act_1" },
          { bmId: "b2", adAccountId: "act_1" },
        ],
      }),
    );
    expect(spine.endpoints).toHaveLength(1);
    expect(spine.endpoints[0].from.map((f) => f.bmId).sort()).toEqual(["bm:b1", "bm:b2"]);
    expect(spine.endpoints[0].from.find((f) => f.bmId === "bm:b2")?.dead).toBe(true);
  });

  test("a pixel keeps root and share apart", () => {
    const spine = buildSpine(
      graphOf({
        bms: [bm("root"), bm("shared")],
        pixels: [{ ...entity("px"), rootBmId: "root" }],
        pixelBm: [{ pixelId: "px", bmId: "shared" }],
      }),
    );
    const relations = Object.fromEntries(spine.endpoints[0].from.map((f) => [f.bmId, f.relation]));
    expect(relations).toEqual({ "bm:root": "root", "bm:shared": "share" });
  });
});

describe("buildSpine — page groups", () => {
  test("pages are grouped under their owner, not scattered as leaf nodes", () => {
    const spine = buildSpine(
      graphOf({
        profiles: [profile("owner")],
        pages: [
          { ...entity("p1"), ownerProfileId: "owner" },
          { ...entity("p2"), ownerProfileId: "owner" },
        ],
      }),
    );
    expect(spine.pageGroups).toHaveLength(1);
    expect(spine.pageGroups[0].owner.entityId).toBe("owner");
    expect(spine.pageGroups[0].pages).toHaveLength(2);
  });

  test("groups are ordered by broken pages first, then by size", () => {
    const spine = buildSpine(
      graphOf({
        profiles: [profile("big"), profile("broken"), profile("small")],
        pages: [
          { ...entity("b1"), ownerProfileId: "big" },
          { ...entity("b2"), ownerProfileId: "big" },
          { ...entity("b3"), ownerProfileId: "big" },
          { ...entity("x1", CRITICAL), ownerProfileId: "broken" },
          { ...entity("s1"), ownerProfileId: "small" },
        ],
      }),
    );
    expect(spine.pageGroups.map((g) => g.owner.entityId)).toEqual(["broken", "big", "small"]);
    expect(spine.pageGroups[0].atRisk).toBe(1);
  });

  test("a group whose owner cannot grant access is flagged dead", () => {
    const spine = buildSpine(
      graphOf({
        profiles: [profile("blocked", false, CRITICAL)],
        pages: [{ ...entity("p1"), ownerProfileId: "blocked" }],
      }),
    );
    expect(spine.pageGroups[0].dead).toBe(true);
  });

  test("pages never appear on the spine, only in their group", () => {
    const spine = buildSpine(
      graphOf({
        profiles: [profile("owner")],
        bms: [bm("b1")],
        pages: [{ ...entity("p1"), ownerProfileId: "owner" }],
        pageBm: [{ pageId: "p1", bmId: "b1" }],
        pageProfile: [{ pageId: "p1", profileId: "owner" }],
      }),
    );
    expect(spine.endpoints).toEqual([]);
    expect(spine.bms[0].inside).toEqual([]);
    expect(spine.pageGroups[0].pages.map((p) => p.entityId)).toEqual(["p1"]);
  });
});

describe("buildSpine — unattached", () => {
  test("a profile wired to nothing is set aside rather than floated in the graph", () => {
    const spine = buildSpine(graphOf({ profiles: [profile("nobody")] }));
    expect(spine.unattached.map((p) => p.entityId)).toEqual(["nobody"]);
  });

  test("owning a page or admining a BM is enough to stay out of the unattached list", () => {
    const spine = buildSpine(
      graphOf({
        profiles: [profile("admin"), profile("owner"), profile("nobody")],
        bms: [bm("b1")],
        pages: [{ ...entity("pg"), ownerProfileId: "owner" }],
        profileBm: [{ profileId: "admin", bmId: "b1" }],
      }),
    );
    expect(spine.unattached.map((p) => p.entityId)).toEqual(["nobody"]);
  });

  test("every profile is accounted for somewhere — nothing is silently dropped", () => {
    // `both` admins a BM AND owns a page. It legitimately appears twice, because the spine and the
    // page strip answer different questions about it; what must never happen is a profile appearing
    // nowhere, or a connected one being filed as unattached.
    const graph = graphOf({
      profiles: [
        profile("inside"),
        profile("shared"),
        profile("owner"),
        profile("both"),
        profile("nobody"),
      ],
      bms: [bm("b1"), bm("b2")],
      pages: [
        { ...entity("pg"), ownerProfileId: "owner" },
        { ...entity("pg2"), ownerProfileId: "both" },
      ],
      profileBm: [
        { profileId: "inside", bmId: "b1" },
        { profileId: "shared", bmId: "b1" },
        { profileId: "shared", bmId: "b2" },
        { profileId: "both", bmId: "b2" },
      ],
    });
    const spine = buildSpine(graph);
    const onSpine = [
      ...spine.bms.flatMap((e) => e.inside.map((a) => a.profile.id)),
      ...spine.sharedProfiles.map((p) => p.id),
    ];
    const owners = spine.pageGroups.map((g) => g.owner.id);
    const profiles = graph.nodes.filter((n) => n.kind === "profile").map((n) => n.id);

    expect(new Set([...onSpine, ...owners, ...spine.unattached.map((p) => p.id)])).toEqual(
      new Set(profiles),
    );
    expect(onSpine).toContain("profile:both");
    expect(owners).toContain("profile:both");
    // Unattached is exactly the complement of everything the map does draw.
    expect(spine.unattached.map((p) => p.id)).toEqual(["profile:nobody"]);
  });
});
