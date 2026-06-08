import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncStructure, syncAccounts } from "./structure";
import type { GraphNode, InsightsClient } from "@/meta/types";

const fakeClient: Partial<InsightsClient> = {
  async getChildren(parentId, edge): Promise<GraphNode[]> {
    if (edge === "campaigns") return [{ id: "c1", name: "Camp 1", objective: "OUTCOME_SALES", status: "ACTIVE" }];
    if (edge === "adsets") return [{ id: "s1", name: "Set 1", status: "ACTIVE", campaign_id: "c1" }];
    if (edge === "ads") return [{ id: "a1", name: "Ad 1", status: "ACTIVE", adset_id: "s1", creative: { id: "cr1" } }];
    if (edge === "adcreatives") return [{ id: "cr1", name: "Creative 1", thumbnail_url: "http://x/y.png" }];
    return [];
  },
};

beforeEach(async () => {
  await db.execute(sql`truncate table accounts, campaigns, ad_sets, ads, ad_creatives cascade`);
  await db.insert(schema.accounts).values({ id: "act_1", name: "Acc", currency: "USD", status: "ACTIVE" });
});

test("syncs campaigns/adsets/ads/creatives and is idempotent", async () => {
  await syncStructure(fakeClient as InsightsClient, "act_1");
  await syncStructure(fakeClient as InsightsClient, "act_1"); // second run must not duplicate

  expect(await db.select().from(schema.campaigns)).toHaveLength(1);
  expect(await db.select().from(schema.adSets)).toHaveLength(1);
  const ads = await db.select().from(schema.ads);
  expect(ads).toHaveLength(1);
  expect(ads[0].creativeId).toBe("cr1");
}, 30000);

test("syncAccounts upserts the accounts table and returns ids", async () => {
  const client: Partial<InsightsClient> = {
    getAccounts: async () => [{ id: "act_1", name: "Acc", currency: "USD", account_status: 1 }],
  };
  const ids = await syncAccounts(client as InsightsClient, "biz_1");
  expect(ids).toEqual(["act_1"]);
  const rows = await db.select().from(schema.accounts);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe("act_1");
  expect(rows[0].name).toBe("Acc");
  expect(rows[0].currency).toBe("USD");
  expect(rows[0].status).toBe("1");
});
