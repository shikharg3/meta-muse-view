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

test("name attribution splits a shared account and leaves ambiguous campaigns in place", async () => {
  const sweat = await clientCampaignScope("sweatbet", ["act_shared"]);
  // ACR Bonus belongs to the other client; the vague name stays (no silent spend loss).
  expect(sweat.excludedCampaignIds).toEqual(["c_acr"]);
  expect(sweat.splitAccountIds).toEqual(["act_shared"]);

  const acr = await clientCampaignScope("acrpoker-eu", ["act_shared"]);
  expect(acr.excludedCampaignIds).toEqual(["c_sweat"]);
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
  expect(sweat.excludedCampaignIds).toEqual(["c_acr"]);
});

test("an uncontested account with no overrides needs no filtering", async () => {
  const third = await clientCampaignScope("thirdparty", ["act_other"]);
  expect(third.clean).toBe(true);
  expect(await ownedCampaignIds("thirdparty", ["act_other"])).toBeNull();
});
