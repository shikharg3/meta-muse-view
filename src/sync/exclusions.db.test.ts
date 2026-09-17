import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { forgetExclusions, purgeExcluded, SEED_EXCLUDED_CAMPAIGN_IDS } from "./exclusions";
import { syncStructure } from "./jobs/structure";
import { syncInsightsRange } from "./jobs/insights";
import type { GraphNode, InsightRow, InsightsClient } from "@/meta/types";

/**
 * The sweep, against a real database — the half that cannot be tested with a regex.
 *
 * What this pins: the excluded tree is removed at every level, an account whose whole campaign list
 * was excluded loses its Meta-computed account rows too, and a neighbouring client's campaign on the
 * SAME ad account keeps every row it had. The first version of `purgeExcluded` type-checked and lint
 * ed clean and still failed on contact with Postgres (`= ANY($1, $2)` is not valid SQL), which is
 * exactly the class of mistake a pure test cannot see.
 */

const EXCLUDED = SEED_EXCLUDED_CAMPAIGN_IDS[0];

beforeEach(async () => {
  await db.execute(
    sql`truncate table accounts, campaigns, ad_sets, ads, ad_creatives, insights_daily,
        insights_breakdown_daily, meta_activities, campaign_client_overrides, sync_exclusions cascade`,
  );
  forgetExclusions();
  await db.insert(schema.accounts).values([
    { id: "act_excluded", name: "Only KP", currency: "USD", status: "ACTIVE" },
    { id: "act_shared", name: "Shared", currency: "USD", status: "ACTIVE" },
  ]);
  await db.insert(schema.campaigns).values([
    { id: EXCLUDED, accountId: "act_excluded", name: "KP" },
    { id: "kept1", accountId: "act_excluded", name: "KPI review" }, // near miss: must survive
    { id: "renamed", accountId: "act_shared", name: "Kylo Peptides - Broad" },
    { id: "kept2", accountId: "act_shared", name: "Q4 brand push" },
  ]);
  await db.insert(schema.adSets).values([
    { id: "set_kp", accountId: "act_excluded", campaignId: EXCLUDED, name: "US - KP" },
    { id: "set_kept", accountId: "act_shared", campaignId: "kept2", name: "Broad" },
    // Named for the excluded line but parented elsewhere: the case parentage alone misses.
    { id: "set_orphan", accountId: "act_shared", campaignId: "kept2", name: "KyloPeptides" },
  ]);
  await db.insert(schema.ads).values([
    {
      id: "ad_kp",
      accountId: "act_excluded",
      adSetId: "set_kp",
      name: "ghostads_1",
      creativeId: "cr_kp",
    },
    {
      id: "ad_orphan",
      accountId: "act_shared",
      adSetId: "set_orphan",
      name: "ghostads_2",
      creativeId: "cr_shared",
    },
    {
      id: "ad_kept",
      accountId: "act_shared",
      adSetId: "set_kept",
      name: "brand_1",
      creativeId: "cr_shared",
    },
  ]);
  await db.insert(schema.adCreatives).values([{ id: "cr_kp" }, { id: "cr_shared" }]);
  await db.insert(schema.insightsDaily).values([
    {
      level: "campaign",
      entityId: EXCLUDED,
      date: "2026-09-01",
      accountId: "act_excluded",
      spend: 88.09,
    },
    {
      level: "campaign",
      entityId: "renamed",
      date: "2026-09-01",
      accountId: "act_shared",
      spend: 10,
    },
    {
      level: "campaign",
      entityId: "kept1",
      date: "2026-09-01",
      accountId: "act_excluded",
      spend: 5,
    },
    {
      level: "campaign",
      entityId: "kept2",
      date: "2026-09-01",
      accountId: "act_shared",
      spend: 20,
    },
    {
      level: "adset",
      entityId: "set_kp",
      date: "2026-09-01",
      accountId: "act_excluded",
      spend: 88.09,
    },
    {
      level: "adset",
      entityId: "set_kept",
      date: "2026-09-01",
      accountId: "act_shared",
      spend: 20,
    },
    { level: "ad", entityId: "ad_kp", date: "2026-09-01", accountId: "act_excluded", spend: 88.09 },
    { level: "ad", entityId: "ad_kept", date: "2026-09-01", accountId: "act_shared", spend: 20 },
    {
      level: "account",
      entityId: "act_excluded",
      date: "2026-09-01",
      accountId: "act_excluded",
      spend: 93.09,
    },
    {
      level: "account",
      entityId: "act_shared",
      date: "2026-09-01",
      accountId: "act_shared",
      spend: 30,
    },
  ]);
  await db.insert(schema.insightsBreakdownDaily).values([
    {
      level: "campaign",
      entityId: EXCLUDED,
      date: "2026-09-01",
      accountId: "act_excluded",
      breakdownType: "country",
      breakdownValue: "US",
      spend: 88.09,
    },
    {
      level: "campaign",
      entityId: "kept2",
      date: "2026-09-01",
      accountId: "act_shared",
      breakdownType: "country",
      breakdownValue: "US",
      spend: 20,
    },
  ]);
  await db.insert(schema.metaActivities).values([
    {
      id: "act1",
      accountId: "act_excluded",
      objectId: EXCLUDED,
      eventType: "update_campaign_budget",
      raw: { object_name: "KP" },
    },
    {
      id: "act2",
      accountId: "act_shared",
      objectId: "kept2",
      eventType: "update_campaign_budget",
      raw: { object_name: "Q4 brand push" },
    },
    // No object id this sync can resolve, but the name gives it away.
    {
      id: "act3",
      accountId: "act_shared",
      objectId: "999",
      eventType: "update_ad_set_name",
      raw: { object_name: "KyloPeptides" },
    },
  ]);
  await db.insert(schema.campaignClientOverrides).values([
    { campaignId: EXCLUDED, clientId: "someone" },
    { campaignId: "kept2", clientId: "someone" },
  ]);
});

const remaining = async () => ({
  campaigns: (await db.select().from(schema.campaigns)).map((r) => r.id).sort(),
  adSets: (await db.select().from(schema.adSets)).map((r) => r.id).sort(),
  ads: (await db.select().from(schema.ads)).map((r) => r.id).sort(),
  creatives: (await db.select().from(schema.adCreatives)).map((r) => r.id).sort(),
  insights: (await db.select().from(schema.insightsDaily))
    .map((r) => `${r.level}:${r.entityId}`)
    .sort(),
  breakdowns: (await db.select().from(schema.insightsBreakdownDaily)).map((r) => r.entityId).sort(),
  activities: (await db.select().from(schema.metaActivities)).map((r) => r.id).sort(),
  overrides: (await db.select().from(schema.campaignClientOverrides))
    .map((r) => r.campaignId)
    .sort(),
});

test("the sweep removes the excluded tree and nothing else", async () => {
  const report = await purgeExcluded();

  expect(report.campaigns).toBe(2); // the seeded id and the renamed one
  expect(report.adSets).toBe(2); // parented, plus the one named for the line
  expect(report.ads).toBe(2);
  expect(report.emptiedAccounts).toEqual([]); // act_excluded still has "KPI review" under it

  const left = await remaining();
  expect(left.campaigns).toEqual(["kept1", "kept2"]);
  expect(left.adSets).toEqual(["set_kept"]);
  expect(left.ads).toEqual(["ad_kept"]);
  // cr_shared is still used by a surviving ad, so only the exclusive creative goes.
  expect(left.creatives).toEqual(["cr_shared"]);
  expect(left.insights).toEqual(
    [
      "account:act_excluded",
      "account:act_shared",
      "adset:set_kept",
      "ad:ad_kept",
      "campaign:kept1",
      "campaign:kept2",
    ].sort(),
  );
  expect(left.breakdowns).toEqual(["kept2"]);
  expect(left.activities).toEqual(["act2"]); // both the id match and the name match are gone
  expect(left.overrides).toEqual(["kept2"]);
}, 30000);

test("an account left with nothing but excluded spend loses its account rows too", async () => {
  // Meta computes account totals itself: they carry no campaign id, so the only way this account
  // stops reporting $93 with no campaigns under it is to drop the rows and keep dropping them.
  await db.delete(schema.campaigns).where(sql`id = 'kept1'`);
  await db.delete(schema.insightsDaily).where(sql`level = 'campaign' AND entity_id = 'kept1'`);

  const report = await purgeExcluded();
  expect(report.emptiedAccounts).toEqual(["act_excluded"]);
  const left = await remaining();
  expect(left.insights).not.toContain("account:act_excluded");
  expect(left.insights).toContain("account:act_shared");
}, 30000);

test("it is idempotent, and reports zero when there is nothing left to do", async () => {
  await purgeExcluded();
  const second = await purgeExcluded();
  expect(second).toMatchObject({
    campaigns: 0,
    adSets: 0,
    ads: 0,
    adCreatives: 0,
    insightRows: 0,
    breakdownRows: 0,
    activities: 0,
    overrides: 0,
  });
}, 30000);

test("ingest refuses the excluded line after the sweep has recorded it", async () => {
  await purgeExcluded();

  // Meta keeps serving them: the same campaign, ad set and ad come back on the next structure sync,
  // plus a NEW campaign for the same product line that no recorded id could match.
  const client: Partial<InsightsClient> = {
    async getChildren(_parent, edge): Promise<GraphNode[]> {
      if (edge === "campaigns")
        return [
          { id: EXCLUDED, name: "KP", status: "ACTIVE" },
          { id: "brand_new", name: "KP - Sales v2", status: "ACTIVE" },
          { id: "legit", name: "KPI dashboard push", status: "ACTIVE" },
        ];
      if (edge === "adsets")
        return [
          { id: "set_kp", name: "US - KP", campaign_id: EXCLUDED, status: "ACTIVE" },
          { id: "set_new", name: "Broad", campaign_id: "brand_new", status: "ACTIVE" },
          { id: "set_legit", name: "Broad", campaign_id: "legit", status: "ACTIVE" },
        ];
      if (edge === "ads")
        return [
          {
            id: "ad_kp",
            name: "ghostads_1",
            adset_id: "set_kp",
            campaign_id: EXCLUDED,
            status: "ACTIVE",
          },
          {
            id: "ad_new",
            name: "ghostads_2",
            adset_id: "set_new",
            campaign_id: "brand_new",
            status: "ACTIVE",
          },
          {
            id: "ad_legit",
            name: "brand_2",
            adset_id: "set_legit",
            campaign_id: "legit",
            status: "ACTIVE",
          },
        ];
      return [];
    },
  };
  await syncStructure(client as InsightsClient, "act_excluded");

  const left = await remaining();
  expect(left.campaigns).toContain("legit");
  expect(left.campaigns).not.toContain(EXCLUDED);
  expect(left.campaigns).not.toContain("brand_new");
  expect(left.ads).toEqual(["ad_kept", "ad_legit"]);

  // …and the insights that follow are refused on the same grounds, including the new campaign's,
  // whose id only became known because structure recorded it a moment ago.
  const rows: InsightRow[] = [
    {
      date_start: "2026-09-02",
      date_stop: "2026-09-02",
      campaign_id: EXCLUDED,
      spend: "50",
      impressions: "10",
    },
    {
      date_start: "2026-09-02",
      date_stop: "2026-09-02",
      campaign_id: "brand_new",
      spend: "70",
      impressions: "20",
    },
    {
      date_start: "2026-09-02",
      date_stop: "2026-09-02",
      campaign_id: "legit",
      spend: "30",
      impressions: "30",
    },
  ];
  const insightClient: Partial<InsightsClient> = { getInsights: async () => rows };
  const written = await syncInsightsRange(
    insightClient as InsightsClient,
    "act_excluded",
    "campaign",
    "2026-09-02",
    "2026-09-02",
    false,
    false,
    [["spend", "impressions"]],
  );
  expect(written).toBe(1);
  const after = await remaining();
  expect(after.insights).toContain("campaign:legit");
  expect(after.insights).not.toContain(`campaign:${EXCLUDED}`);
  expect(after.insights).not.toContain("campaign:brand_new");
}, 30000);
