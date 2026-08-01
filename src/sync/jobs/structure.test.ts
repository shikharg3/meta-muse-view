import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncStructure, syncAccounts } from "./structure";
import type { GraphNode, InsightsClient } from "@/meta/types";

const fakeClient: Partial<InsightsClient> = {
  async getChildren(parentId, edge): Promise<GraphNode[]> {
    if (edge === "campaigns")
      return [{ id: "c1", name: "Camp 1", objective: "OUTCOME_SALES", status: "ACTIVE" }];
    if (edge === "adsets")
      return [{ id: "s1", name: "Set 1", status: "ACTIVE", campaign_id: "c1" }];
    if (edge === "ads")
      return [
        { id: "a1", name: "Ad 1", status: "ACTIVE", adset_id: "s1", creative: { id: "cr1" } },
      ];
    return [];
  },
};

beforeEach(async () => {
  await db.execute(sql`truncate table accounts, campaigns, ad_sets, ads, ad_creatives cascade`);
  await db
    .insert(schema.accounts)
    .values({ id: "act_1", name: "Acc", currency: "USD", status: "ACTIVE" });
});

test("syncs campaigns/adsets/ads and is idempotent", async () => {
  await syncStructure(fakeClient as InsightsClient, "act_1");
  await syncStructure(fakeClient as InsightsClient, "act_1"); // second run must not duplicate

  expect(await db.select().from(schema.campaigns)).toHaveLength(1);
  expect(await db.select().from(schema.adSets)).toHaveLength(1);
  const ads = await db.select().from(schema.ads);
  expect(ads).toHaveLength(1);
  // The ad still carries its creative id (it comes free on the ad node) but creative tracking is
  // paused, so nothing is written to ad_creatives.
  expect(ads[0].creativeId).toBe("cr1");
  expect(await db.select().from(schema.adCreatives)).toHaveLength(0);
}, 30000);

test("syncAccounts upserts the accounts table and returns ids", async () => {
  const client: Partial<InsightsClient> = {
    getAccounts: async () => [
      {
        id: "act_1",
        name: "Acc",
        currency: "USD",
        account_status: 1,
        amount_spent: "12345",
        spend_cap: "100000",
        timezone_name: "UTC",
        disable_reason: 0,
        business: { id: "b1", name: "BizCo" },
        created_time: "2025-11-28T09:00:11+0000",
      },
    ],
  };
  const ids = await syncAccounts(client as InsightsClient, "biz_1");
  expect(ids).toEqual(["act_1"]);
  const rows = await db.select().from(schema.accounts);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe("act_1");
  expect(rows[0].name).toBe("Acc");
  expect(rows[0].currency).toBe("USD");
  expect(rows[0].status).toBe("1");
  expect(rows[0].amountSpent).toBe(12345);
  expect(rows[0].spendCap).toBe(100000);
  expect(rows[0].timezoneName).toBe("UTC");
  expect(rows[0].disableReason).toBe(0); // 0 ("not disabled") must be preserved, not nulled
  expect(rows[0].businessName).toBe("BizCo");
});

test("promotes campaign/adset/ad config fields into columns", async () => {
  const rich: Partial<InsightsClient> = {
    async getChildren(_parentId, edge): Promise<GraphNode[]> {
      if (edge === "campaigns")
        return [
          {
            id: "c1",
            name: "C",
            status: "ACTIVE",
            objective: "OUTCOME_SALES",
            daily_budget: "5000",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            buying_type: "AUCTION",
            start_time: "2026-05-01T00:00:00+0000",
            promoted_object: { pixel_id: "px1" },
          },
        ];
      if (edge === "adsets")
        return [
          {
            id: "s1",
            name: "S",
            status: "ACTIVE",
            campaign_id: "c1",
            optimization_goal: "OFFSITE_CONVERSIONS",
            billing_event: "IMPRESSIONS",
            daily_budget: "2000",
            targeting: { geo_locations: { countries: ["BR"] }, age_min: 18 },
          },
        ];
      if (edge === "ads")
        return [
          {
            id: "a1",
            name: "A",
            status: "ACTIVE",
            adset_id: "s1",
            creative: { id: "cr1" },
            tracking_specs: [{ "action.type": ["offsite_conversion"] }],
            preview_shareable_link: "https://fb.me/x",
          },
        ];
      return [];
    },
  };
  await syncStructure(rich as InsightsClient, "act_1");
  const [camp] = await db.select().from(schema.campaigns);
  expect(camp.dailyBudget).toBe(5000);
  expect(camp.bidStrategy).toBe("LOWEST_COST_WITHOUT_CAP");
  expect(camp.buyingType).toBe("AUCTION");
  expect(camp.startTime).not.toBeNull();
  expect(camp.promotedObject).toEqual({ pixel_id: "px1" });
  const [set] = await db.select().from(schema.adSets);
  expect(set.optimizationGoal).toBe("OFFSITE_CONVERSIONS");
  expect(set.dailyBudget).toBe(2000);
  expect(set.targeting).toEqual({ geo_locations: { countries: ["BR"] }, age_min: 18 });
  const [ad] = await db.select().from(schema.ads);
  expect(ad.previewShareableLink).toBe("https://fb.me/x");
  expect(ad.trackingSpecs).toEqual([{ "action.type": ["offsite_conversion"] }]);
}, 30000);
