import { expect, test } from "bun:test";
import { OTHER_BRAND } from "@/lib/scheduled-report";
import { attributeToBrands, clientBrands, narrowScope, type ClientScope } from "./report-scope";

// OneAgency's shape: Slots.lv and Lucky Rebel rows, one account listed by both, plus a re-listed
// Slots.lv engagement and an account added by hand that no row lists.
const client = {
  notionAccountIds: ["act_slv", "act_lr", "act_shared", "act_removed"],
  manualAddIds: ["act_manual"],
  manualRemoveIds: ["act_removed"],
  raw: [
    { pageId: "p1", title: "Slots.lv", status: "Live", accountIds: ["act_slv", "act_shared"] },
    { pageId: "p2", title: "Lucky Rebel", status: "Live", accountIds: ["act_lr", "act_shared"] },
    { pageId: "p3", title: "slots.lv ", status: "Paused", accountIds: ["act_removed"] },
  ],
};

test("brands merge rows by title, drop removed accounts, and collect unlisted ones as Other", () => {
  const brands = clientBrands(client);
  expect(brands.map((b) => [b.key, b.accountIds])).toEqual([
    ["lucky rebel", ["act_lr", "act_shared"]],
    ["slots.lv", ["act_slv", "act_shared"]],
    [OTHER_BRAND, ["act_manual"]],
  ]);
  expect(brands.find((b) => b.key === "slots.lv")?.status).toBe("Live");
});

test("a shared account's campaigns go by name; an unmatched name belongs to no brand", () => {
  const brands = clientBrands(client);
  const attributed = attributeToBrands(brands, [
    { id: "c1", name: "SLV Prospecting", accountId: "act_slv" },
    { id: "c2", name: "Lucky Rebel - Michigan", accountId: "act_shared" },
    { id: "c3", name: "Slots.lv retargeting", accountId: "act_shared" },
    { id: "c4", name: "Broad test", accountId: "act_shared" },
    { id: "c5", name: "Anything", accountId: "act_manual" },
  ]);
  expect(Object.fromEntries(attributed.map((c) => [c.id, c.brand]))).toEqual({
    c1: "slots.lv", // only Slots.lv lists act_slv, so the name does not matter
    c2: "lucky rebel",
    c3: "slots.lv",
    c4: null,
    c5: OTHER_BRAND,
  });
});

const scope = (restricted: boolean): ClientScope => {
  const brands = clientBrands(client);
  return {
    clientId: "oneagency",
    clientName: "OneAgency",
    accountIds: ["act_slv", "act_lr", "act_shared", "act_manual"],
    brands,
    campaigns: attributeToBrands(brands, [
      { id: "c1", name: "SLV Prospecting", accountId: "act_slv" },
      { id: "c2", name: "Lucky Rebel - Michigan", accountId: "act_shared" },
      { id: "c4", name: "Broad test", accountId: "act_shared" },
    ]),
    restricted,
  };
};

test("no picks on an unshared client means every campaign, not a frozen list", () => {
  expect(narrowScope(scope(false), [], []).campaignIds).toBeNull();
  // On a shared account the client's own campaigns are a whitelist even with nothing picked.
  expect(narrowScope(scope(true), [], []).campaignIds).toEqual(["c1", "c2", "c4"]);
});

test("a brand pick narrows accounts and campaigns and names the subject", () => {
  const n = narrowScope(scope(false), ["lucky rebel"], []);
  expect(n.accountIds).toEqual(["act_lr", "act_shared"]);
  expect(n.campaignIds).toEqual(["c2"]); // c4 is on the shared account but is nobody's by name
  expect(n.subject).toBe("OneAgency › Lucky Rebel");
});

test("campaign picks intersect the brand scope; an empty result stays empty, never 'all'", () => {
  expect(narrowScope(scope(false), [], ["c4"]).campaignIds).toEqual(["c4"]);
  expect(narrowScope(scope(false), ["lucky rebel"], ["c1"]).campaignIds).toEqual([]);
});
