import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { logInfraEvent } from "./events";
import { buildRiskMap } from "./risk";

// Destructive. `bun test` redirects DATABASE_URL to TEST_DATABASE_URL via test-setup.ts, so this can
// never reach real synced data. `cascade` handles the link tables regardless of listing order.
async function reset() {
  await db.execute(sql`truncate table
    infra_page_profile, infra_page_bm, infra_pixel_bm, infra_bm_ad_account, infra_profile_bm,
    infra_pages, infra_pixels, infra_ad_accounts, infra_business_managers, infra_profiles,
    infra_status_events cascade`);
}

async function makeBm(name: string, status = "active") {
  const id = randomUUID();
  await db
    .insert(schema.infraBusinessManagers)
    .values({ id, bmId: `bm-${id.slice(0, 8)}`, name, status });
  return id;
}

async function makeProfile(name: string, statuses: string[] = ["active"]) {
  const id = randomUUID();
  await db.insert(schema.infraProfiles).values({ id, name, statuses });
  return id;
}

beforeEach(reset);
afterAll(reset);

describe("referential integrity", () => {
  test("deleting a profile cascades its BM memberships away but keeps the BM", async () => {
    const profileId = await makeProfile("p1");
    const bmId = await makeBm("bm1");
    await db.insert(schema.infraProfileBm).values({ profileId, bmId });

    await db.delete(schema.infraProfiles).where(eq(schema.infraProfiles.id, profileId));

    expect(await db.select().from(schema.infraProfileBm)).toHaveLength(0);
    expect(await db.select().from(schema.infraBusinessManagers)).toHaveLength(1);
  });

  test("deleting a BM that roots a pixel is refused", async () => {
    const bmId = await makeBm("root-bm");
    await db.insert(schema.infraPixels).values({ id: "px-1", name: "Main pixel", rootBmId: bmId });

    let threw = false;
    try {
      await db
        .delete(schema.infraBusinessManagers)
        .where(eq(schema.infraBusinessManagers.id, bmId));
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(await db.select().from(schema.infraPixels)).toHaveLength(1);
  });

  test("deleting a profile that owns a page is refused", async () => {
    const ownerProfileId = await makeProfile("owner");
    await db.insert(schema.infraPages).values({
      id: randomUUID(),
      name: "Brand page",
      pageUrl: "https://facebook.com/brand",
      ownerProfileId,
    });

    let threw = false;
    try {
      await db.delete(schema.infraProfiles).where(eq(schema.infraProfiles.id, ownerProfileId));
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });

  test("two BM rows cannot share one Meta bm_id", async () => {
    await db
      .insert(schema.infraBusinessManagers)
      .values({ id: randomUUID(), bmId: "999", name: "First" });

    let threw = false;
    try {
      await db
        .insert(schema.infraBusinessManagers)
        .values({ id: randomUUID(), bmId: "999", name: "Duplicate" });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });
});

describe("logInfraEvent", () => {
  test("a status change records both values, the reason and the actor", async () => {
    const bmId = await makeBm("bm-x");

    await logInfraEvent({
      kind: "bm",
      entityId: bmId,
      event: "status_change",
      fromStatus: "active",
      toStatus: "banned",
      reason: "policy violation",
      actorEmail: "op@dot.test",
    });

    const rows = await db
      .select()
      .from(schema.infraStatusEvents)
      .where(
        and(eq(schema.infraStatusEvents.kind, "bm"), eq(schema.infraStatusEvents.entityId, bmId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].fromStatus).toBe("active");
    expect(rows[0].toStatus).toBe("banned");
    expect(rows[0].reason).toBe("policy violation");
    expect(rows[0].actorEmail).toBe("op@dot.test");
  });

  test("history survives deletion of its entity", async () => {
    const profileId = await makeProfile("doomed");
    await logInfraEvent({
      kind: "profile",
      entityId: profileId,
      event: "status_change",
      fromStatus: "active",
      toStatus: "banned",
      actorEmail: "op@dot.test",
    });

    await db.delete(schema.infraProfiles).where(eq(schema.infraProfiles.id, profileId));

    const rows = await db
      .select()
      .from(schema.infraStatusEvents)
      .where(eq(schema.infraStatusEvents.entityId, profileId));
    expect(rows).toHaveLength(1);
  });
});

describe("buildRiskMap", () => {
  test("BM redundancy counts only usable profiles", async () => {
    const redundantBm = await makeBm("redundant");
    const singleBm = await makeBm("single");
    const orphanBm = await makeBm("orphan");
    const p1 = await makeProfile("p1");
    const p2 = await makeProfile("p2");
    const bannedProfile = await makeProfile("gone", ["suspended"]);

    await db.insert(schema.infraProfileBm).values([
      { profileId: p1, bmId: redundantBm },
      { profileId: p2, bmId: redundantBm },
      { profileId: p1, bmId: singleBm },
      { profileId: bannedProfile, bmId: orphanBm },
    ]);

    const map = await buildRiskMap();
    const level = new Map(map.bms.map((r) => [r.name, r.risk.level]));
    expect(level.get("redundant")).toBe("safe");
    expect(level.get("single")).toBe("warning");
    // A banned profile is not an access path, so this BM has none despite holding a link.
    expect(level.get("orphan")).toBe("critical");
  });

  test("a profile marked active AND blocked is not an access path", async () => {
    // The case multi-status exists for: Meta leaves the profile active but strips a capability.
    const bm = await makeBm("half-blocked");
    const blocked = await makeProfile("active-but-read-only", ["active", "read_only"]);
    await db.insert(schema.infraProfileBm).values({ profileId: blocked, bmId: bm });

    const map = await buildRiskMap();
    const row = map.bms.find((r) => r.name === "half-blocked");
    expect(row?.risk.level).toBe("critical");
    expect(row?.detail).toBe("0 usable profiles");
  });

  test("a selfie-pending profile is not an access path", async () => {
    const bm = await makeBm("selfie-pending");
    const p = await makeProfile("awaiting-selfie", ["active", "video_selfie"]);
    await db.insert(schema.infraProfileBm).values({ profileId: p, bmId: bm });

    const map = await buildRiskMap();
    expect(map.bms.find((r) => r.name === "selfie-pending")?.risk.level).toBe("critical");
  });

  test("an ad account reachable only through a suspended BM is critical", async () => {
    const deadBm = await makeBm("dead", "suspended");
    await db.insert(schema.infraAdAccounts).values({ id: "act_1", label: "Acct one" });
    await db.insert(schema.infraBmAdAccount).values({ bmId: deadBm, adAccountId: "act_1" });

    const map = await buildRiskMap();
    expect(map.adAccounts).toHaveLength(1);
    expect(map.adAccounts[0].risk.level).toBe("critical");
  });

  test("retired ad accounts are excluded from risk but still counted as registered", async () => {
    await db
      .insert(schema.infraAdAccounts)
      .values({ id: "act_retired", label: "Old", usageState: "retired" });

    const map = await buildRiskMap();
    expect(map.adAccounts).toHaveLength(0);
    expect(map.counts.adAccounts).toBe(1);
  });

  test("counts and atRisk reflect the whole registry", async () => {
    const bmId = await makeBm("only");
    await makeProfile("lonely");
    await db.insert(schema.infraPixels).values({ id: "px", name: "Px", rootBmId: bmId });

    const map = await buildRiskMap();
    expect(map.counts).toEqual({ profiles: 1, bms: 1, adAccounts: 0, pixels: 1, pages: 0 });
    // The BM has no usable profile (critical) and the pixel has no shares (warning).
    expect(map.atRisk).toBe(2);
  });

  test("rows are ordered critical first so the risk map needs no client-side sorting", async () => {
    const safeBm = await makeBm("zzz-safe");
    const criticalBm = await makeBm("aaa-critical");
    const p1 = await makeProfile("p1");
    const p2 = await makeProfile("p2");
    await db.insert(schema.infraProfileBm).values([
      { profileId: p1, bmId: safeBm },
      { profileId: p2, bmId: safeBm },
    ]);

    const map = await buildRiskMap();
    expect(map.bms.map((r) => r.id)).toEqual([criticalBm, safeBm]);
  });

  test("the matrix, the headline and the rows are one read", async () => {
    const svc = await makeProfile("svc.admin.01");
    const bmOne = await makeBm("bm-one");
    const bmTwo = await makeBm("bm-two");
    await db.insert(schema.infraProfileBm).values([
      { profileId: svc, bmId: bmOne },
      { profileId: svc, bmId: bmTwo },
    ]);
    await db
      .insert(schema.infraAdAccounts)
      .values({ id: "act_solo", label: "Solo", usageState: "in_use" });
    await db.insert(schema.infraBmAdAccount).values({ bmId: bmOne, adAccountId: "act_solo" });

    const map = await buildRiskMap();

    // One usable admin holds both BMs, so banning it strands the account behind them.
    expect(map.concentration).toMatchObject({
      name: "svc.admin.01",
      blocked: false,
      bms: 2,
      assets: 1,
    });
    // The matrix is not a second count: its asset columns are exactly the headline number.
    const assets = map.tally.filter((r) => r.kind !== "profile");
    expect(assets.reduce((n, r) => n + r.critical + r.warning, 0)).toBe(map.atRisk);
    expect(map.tally.find((r) => r.kind === "bm")).toMatchObject({ warning: 2, registered: 2 });
    expect(map.bms.find((r) => r.id === bmOne)?.strands).toEqual({
      adAccounts: 1,
      pixels: 0,
      pages: 0,
    });
    // Profiles are their own matrix line, so the screen can list them without a second read.
    expect(map.profiles.map((p) => p.name)).toEqual(["svc.admin.01"]);
  });
});

describe("buildRiskMap graph", () => {
  test("wires every link table into one connected access graph", async () => {
    const profileId = await makeProfile("admin-1");
    const bmId = await makeBm("bm-1");
    await db.insert(schema.infraProfileBm).values({ profileId, bmId });
    await db.insert(schema.infraAdAccounts).values({ id: "act_1", label: "Main" });
    await db.insert(schema.infraBmAdAccount).values({ bmId, adAccountId: "act_1" });
    await db.insert(schema.infraPixels).values({ id: "px-1", name: "Pixel", rootBmId: bmId });
    const pageId = randomUUID();
    await db.insert(schema.infraPages).values({
      id: pageId,
      name: "Page",
      pageUrl: "https://facebook.com/p",
      ownerProfileId: profileId,
    });
    await db.insert(schema.infraPageBm).values({ pageId, bmId });

    const { graph } = await buildRiskMap();
    const edge = (source: string, target: string) =>
      graph.edges.find((e) => e.source === source && e.target === target);

    expect(graph.nodes.map((n) => n.id).sort()).toEqual(
      [
        `profile:${profileId}`,
        `bm:${bmId}`,
        "adAccount:act_1",
        "pixel:px-1",
        `page:${pageId}`,
      ].sort(),
    );
    expect(edge(`profile:${profileId}`, `bm:${bmId}`)?.relation).toBe("admin");
    expect(edge(`bm:${bmId}`, "adAccount:act_1")?.relation).toBe("access");
    expect(edge(`bm:${bmId}`, "pixel:px-1")?.relation).toBe("root");
    expect(edge(`profile:${profileId}`, `page:${pageId}`)?.relation).toBe("owns");
    expect(edge(`bm:${bmId}`, `page:${pageId}`)?.relation).toBe("access");
  });

  test("a suspended BM's outbound edges are dead, so an unreachable account is visible", async () => {
    const bmId = await makeBm("dead-bm", "suspended");
    await db.insert(schema.infraAdAccounts).values({ id: "act_2", label: "Stranded" });
    await db.insert(schema.infraBmAdAccount).values({ bmId, adAccountId: "act_2" });

    const { graph } = await buildRiskMap();
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].dead).toBe(true);
  });

  test("a retired ad account leaves neither a node nor a dangling edge", async () => {
    const bmId = await makeBm("bm-2");
    await db
      .insert(schema.infraAdAccounts)
      .values({ id: "act_3", label: "Old", usageState: "retired" });
    await db.insert(schema.infraBmAdAccount).values({ bmId, adAccountId: "act_3" });

    const { graph } = await buildRiskMap();
    expect(graph.nodes.map((n) => n.id)).toEqual([`bm:${bmId}`]);
    expect(graph.edges).toEqual([]);
  });

  test("an unusable profile is critical only when something depends on it", async () => {
    const stranding = await makeProfile("blocked-admin", ["suspended"]);
    const orphan = await makeProfile("blocked-orphan", ["active", "read_only"]);
    const bmId = await makeBm("bm-3");
    await db.insert(schema.infraProfileBm).values({ profileId: stranding, bmId });

    const { graph } = await buildRiskMap();
    const level = (id: string) => graph.nodes.find((n) => n.id === `profile:${id}`)?.risk.level;
    expect(level(stranding)).toBe("critical");
    expect(level(orphan)).toBe("warning");
  });

  test("the graph and the risk tables report the same verdict for the same BM", async () => {
    const bmId = await makeBm("bm-4");
    const { bms, graph } = await buildRiskMap();
    const node = graph.nodes.find((n) => n.id === `bm:${bmId}`);
    expect(node?.risk).toEqual(bms[0].risk);
    expect(node?.detail).toBe(bms[0].detail);
  });
});
