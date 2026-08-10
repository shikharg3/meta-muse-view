import { test, expect, beforeEach } from "bun:test";
import { sql as dsql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { clientCampaignScope, ownedCampaignIds } from "./campaign-attribution";

// One account claimed by TWO clients (the real "account reused for a later client" case), plus a
// third client on its own account, used to test moving a campaign across accounts.
beforeEach(async () => {
  await db.execute(dsql`truncate table campaign_client_overrides`);
  await db.execute(dsql`truncate table campaigns cascade`);
  await db.execute(dsql`truncate table clients cascade`);
  await db.execute(dsql`truncate table accounts cascade`);
  await db.insert(schema.accounts).values([
    { id: "act_shared", name: "Shared", currency: "USD" },
    { id: "act_other", name: "Other", currency: "USD" },
  ]);
  await db.insert(schema.clients).values([
    {
      id: "sweatbet",
      name: "Sweatbet",
      status: "Paused",
      notionAccountIds: ["act_shared"],
      raw: [
        { pageId: "p1", title: "Sweatbet Launch", status: "Paused", accountIds: ["act_shared"] },
      ],
    },
    {
      id: "acrpoker-eu",
      name: "acrpoker.eu",
      status: "Live",
      notionAccountIds: ["act_shared"],
      raw: [{ pageId: "p2", title: "ACR Poker", status: "Live", accountIds: ["act_shared"] }],
    },
    { id: "thirdparty", name: "Reels.io", status: "Live", notionAccountIds: ["act_other"] },
  ]);
  await db.insert(schema.campaigns).values([
    { id: "c_sweat", accountId: "act_shared", name: "SweatBet", status: "ACTIVE" },
    { id: "c_acr", accountId: "act_shared", name: "ACR Bonus", status: "ACTIVE" },
    { id: "c_vague", accountId: "act_shared", name: "Retargeting - Copy", status: "ACTIVE" },
    { id: "c_far", accountId: "act_other", name: "Reels #3 Regs", status: "ACTIVE" },
  ]);
});

test("name attribution splits a shared account and drops what it cannot assign", async () => {
  // The behaviour this replaces: an unmatched campaign used to stay with EVERY claimant, so asking
  // for one client's totals returned the other's spend too (Allstarslots picking up Slots.lv's
  // $4,285 "SLV Prospecting" campaign). Counting it for nobody is the only defensible default.
  const sweat = await clientCampaignScope("sweatbet", ["act_shared"]);
  expect(sweat.excludedCampaignIds.sort()).toEqual(["c_acr", "c_vague"]);
  expect(sweat.unattributedCampaignIds).toEqual(["c_vague"]);
  expect(sweat.splitAccountIds).toEqual(["act_shared"]);

  const acr = await clientCampaignScope("acrpoker-eu", ["act_shared"]);
  expect(acr.excludedCampaignIds.sort()).toEqual(["c_sweat", "c_vague"]);
  expect(acr.unattributedCampaignIds).toEqual(["c_vague"]);

  // Neither client counts it, so the same campaign is never billed to two clients.
  const owned = await Promise.all([
    ownedCampaignIds("sweatbet", ["act_shared"]),
    ownedCampaignIds("acrpoker-eu", ["act_shared"]),
  ]);
  expect(owned[0]).not.toContain("c_vague");
  expect(owned[1]).not.toContain("c_vague");
});

test("the sole ACTIVE-account claimant wins what names cannot split", async () => {
  // The board distinguishes a client's designated "Active Account ID" from accounts it merely lists
  // under "Other ad accounts". When names fail, that designation decides ownership.
  await db
    .update(schema.clients)
    .set({ notionActiveAccountIds: ["act_shared"] })
    .where(dsql`id = 'acrpoker-eu'`);

  const acr = await clientCampaignScope("acrpoker-eu", ["act_shared"]);
  expect(acr.excludedCampaignIds).toEqual(["c_sweat"]); // c_vague now belongs to acrpoker.eu
  expect(acr.unattributedCampaignIds).toEqual([]);

  const sweat = await clientCampaignScope("sweatbet", ["act_shared"]);
  expect(sweat.excludedCampaignIds.sort()).toEqual(["c_acr", "c_vague"]);
  expect(sweat.unattributedCampaignIds).toEqual([]); // assigned, not unattributable

  // Both designating it ACTIVE is no tiebreaker at all — back to counting for nobody.
  await db
    .update(schema.clients)
    .set({ notionActiveAccountIds: ["act_shared"] })
    .where(dsql`id = 'sweatbet'`);
  const tie = await clientCampaignScope("sweatbet", ["act_shared"]);
  expect(tie.unattributedCampaignIds).toEqual(["c_vague"]);
});

test("a manual override beats name attribution", async () => {
  // Operator says the SweatBet-named campaign actually belongs to acrpoker.eu.
  await db
    .insert(schema.campaignClientOverrides)
    .values({ campaignId: "c_sweat", clientId: "acrpoker-eu" });

  const acr = await clientCampaignScope("acrpoker-eu", ["act_shared"]);
  expect(acr.excludedCampaignIds).not.toContain("c_sweat"); // now kept
  const sweat = await clientCampaignScope("sweatbet", ["act_shared"]);
  expect(sweat.excludedCampaignIds).toContain("c_sweat"); // and dropped from its name-match client
});

test("an override pulls a campaign in from an account the client does not own", async () => {
  await db
    .insert(schema.campaignClientOverrides)
    .values({ campaignId: "c_far", clientId: "sweatbet" });

  const sweat = await clientCampaignScope("sweatbet", ["act_shared"]);
  expect(sweat.extraAccountIds).toEqual(["act_other"]);
  // The foreign account is campaign-level only, so its OTHER campaigns must not leak in.
  expect(sweat.splitAccountIds).toContain("act_other");

  const owned = await ownedCampaignIds("sweatbet", ["act_shared"]);
  if (!owned) throw new Error("expected a whitelist");
  expect(owned).toContain("c_far"); // moved in
  expect(owned).toContain("c_sweat"); // still its own
  expect(owned).not.toContain("c_acr"); // still the other client's
});

test("clearing the override restores automatic attribution", async () => {
  await db
    .insert(schema.campaignClientOverrides)
    .values({ campaignId: "c_sweat", clientId: "acrpoker-eu" });
  await db.execute(dsql`delete from campaign_client_overrides where campaign_id = 'c_sweat'`);
  const sweat = await clientCampaignScope("sweatbet", ["act_shared"]);
  expect(sweat.excludedCampaignIds.sort()).toEqual(["c_acr", "c_vague"]);
});

test("an override rescues an unattributable campaign for exactly one client", async () => {
  await db
    .insert(schema.campaignClientOverrides)
    .values({ campaignId: "c_vague", clientId: "sweatbet" });

  const sweat = await clientCampaignScope("sweatbet", ["act_shared"]);
  expect(sweat.excludedCampaignIds).toEqual(["c_acr"]);
  expect(sweat.unattributedCampaignIds).toEqual([]);

  const acr = await clientCampaignScope("acrpoker-eu", ["act_shared"]);
  expect(acr.excludedCampaignIds.sort()).toEqual(["c_sweat", "c_vague"]);
  expect(acr.unattributedCampaignIds).toEqual([]); // owned by sweatbet now, not unassignable
});

test("an uncontested account with no overrides needs no filtering", async () => {
  const third = await clientCampaignScope("thirdparty", ["act_other"]);
  expect(third.clean).toBe(true);
  expect(await ownedCampaignIds("thirdparty", ["act_other"])).toBeNull();
});
