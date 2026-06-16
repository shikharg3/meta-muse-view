import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncEdges, syncActivities } from "./objects";
import type { GraphNode, InsightsClient } from "@/meta/types";

function edgeClient(byEdge: Record<string, GraphNode[]>): InsightsClient {
  return {
    getAccounts: async () => [],
    getChildren: async (_p: string, edge: string) => byEdge[edge] ?? [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getInsights: async () => [],
  };
}

beforeEach(async () => {
  await db.execute(sql`truncate table meta_objects, meta_activities cascade`);
});

test("syncEdges captures reference objects by type into meta_objects", async () => {
  const client = edgeClient({
    customaudiences: [
      { id: "ca1", name: "Purchasers", subtype: "CUSTOM", approximate_count_lower_bound: 1000 },
    ],
    adspixels: [{ id: "px1", name: "Main Pixel", last_fired_time: "2026-06-15T00:00:00+0000" }],
  });
  const written = await syncEdges(client, "act_1");
  expect(written).toBe(2);
  const rows = await db.select().from(schema.metaObjects);
  const ca = rows.find((r) => r.objectType === "custom_audience");
  expect(ca?.name).toBe("Purchasers");
  expect((ca?.raw as Record<string, unknown>).subtype).toBe("CUSTOM");
  expect(rows.find((r) => r.objectType === "pixel")?.id).toBe("px1");
});

test("syncEdges skips an edge that errors without failing the rest", async () => {
  const client: InsightsClient = {
    getAccounts: async () => [],
    getInsights: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getChildren: async (_p, edge) => {
      if (edge === "customaudiences") throw new Error("(#10) permission");
      if (edge === "adlabels") return [{ id: "l1", name: "Q3" }];
      return [];
    },
  };
  const written = await syncEdges(client, "act_1");
  expect(written).toBe(1);
  expect((await db.select().from(schema.metaObjects))[0].objectType).toBe("ad_label");
});

test("syncActivities dedupes change-history events on re-pull", async () => {
  const client = edgeClient({
    activities: [
      {
        id: "x",
        event_type: "update_campaign_budget",
        event_time: "2026-06-10T10:00:00+0000",
        object_id: "c1",
        actor_name: "Jane",
      },
    ],
  });
  await syncActivities(client, "act_1", { days: 90 });
  await syncActivities(client, "act_1", { days: 90 });
  const rows = await db.select().from(schema.metaActivities);
  expect(rows).toHaveLength(1);
  expect(rows[0].eventType).toBe("update_campaign_budget");
  expect(rows[0].actorName).toBe("Jane");
});
