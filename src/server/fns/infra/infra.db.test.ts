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
});
