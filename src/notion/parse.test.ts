import { test, expect } from "bun:test";
import {
  parseAccountIds,
  clientKey,
  clientSlug,
  clubClients,
  parseCampaignRow,
  parseClientName,
  brandTitles,
} from "./parse";
import { parseNotionDbId } from "./client";
import type { NotionPage } from "./client";

test("parseAccountIds handles commas, newlines, junk, and dedupes", () => {
  expect(parseAccountIds("1309778201299889")).toEqual(["act_1309778201299889"]);
  expect(parseAccountIds("4317430991841763\n1645831893201425")).toEqual([
    "act_4317430991841763",
    "act_1645831893201425",
  ]);
  expect(parseAccountIds("125847, 1258479753143618, 902315445715505,1442597417373143")).toEqual([
    "act_1258479753143618",
    "act_902315445715505",
    "act_1442597417373143",
  ]);
  // junk tokens (URLs, blank lines) are dropped; dupes collapse
  expect(
    parseAccountIds("776152568765079\n\nbhttps://www.fortunegalaxy.io/   \n776152568765079"),
  ).toEqual(["act_776152568765079"]);
  expect(parseAccountIds("")).toEqual([]);
});

test("brandTitles extracts distinct row titles from stored raw pages", () => {
  expect(
    brandTitles([
      { pageId: "p1", title: "Lucky Rebel" },
      { pageId: "p2", title: "Slots.lv" },
      { pageId: "p3", title: "Lucky Rebel" }, // dupe collapses
      { pageId: "p4", title: "  " }, // blank dropped
    ]),
  ).toEqual(["Lucky Rebel", "Slots.lv"]);
  expect(brandTitles(null)).toEqual([]);
  expect(brandTitles(undefined)).toEqual([]);
  expect(brandTitles("not-an-array")).toEqual([]);
});

test("clientKey strips parenthetical suffixes and normalizes whitespace", () => {
  expect(clientKey("wildcasino.ag (June/July 2026)")).toBe("wildcasino.ag");
  expect(clientKey("wildcasino.ag (May/June 2026))")).toBe("wildcasino.ag");
  expect(clientKey("playW3 / be the boss")).toBe("playw3 / be the boss");
  expect(clientKey("fortunegalaxy.io   Palmluck 26 May 2026")).toBe(
    "fortunegalaxy.io palmluck 26 may 2026",
  );
});

test("clientSlug is url-safe and stable", () => {
  expect(clientSlug("wildcasino.ag")).toBe("wildcasino-ag");
  expect(clientSlug("playw3 / be the boss")).toBe("playw3-be-the-boss");
  expect(clientSlug("")).toBe("unnamed");
});

test("clubClients groups differently-titled campaigns under their linked client entity", () => {
  const clientNames = new Map([["client_omni", "omni agency"]]);
  const clubbed = clubClients(
    [
      {
        pageId: "p1",
        title: "zaddycoin.io",
        clientRelationIds: ["client_omni"],
        activeIds: ["act_1372577337735758"],
        otherIds: ["act_1210811414237867"],
        status: "Full Budget Finished",
        budget: 5000,
        startDate: "2026-05-01",
        endDate: "2026-06-30",
      },
      {
        pageId: "p2",
        title: "Farside (2)",
        clientRelationIds: ["client_omni"],
        activeIds: ["act_1372577337735758"],
        otherIds: [],
        status: "Live",
        budget: 7000,
        startDate: "2026-06-01",
        endDate: "2026-07-31",
      },
      {
        pageId: "p3",
        title: "Sweatbet",
        clientRelationIds: [],
        activeIds: ["act_1540281067638398"],
        otherIds: [],
        status: "Live",
        budget: null,
        startDate: null,
        endDate: null,
      },
    ],
    clientNames,
  );
  expect(clubbed).toHaveLength(2); // omni agency (both campaigns clubbed) + Sweatbet (unlinked)
  const omni = clubbed.find((c) => c.id === "omni-agency")!;
  expect(omni.name).toBe("omni agency");
  expect(omni.accountIds.sort()).toEqual(["act_1210811414237867", "act_1372577337735758"].sort());
  // Active Account ID column is tracked separately; the "Other ad accounts" id is excluded.
  expect(omni.activeAccountIds).toEqual(["act_1372577337735758"]);
  expect(omni.status).toBe("Live"); // Live beats Full Budget Finished
  expect(omni.pages).toHaveLength(2);
  expect(omni.budget).toBe(7000); // current engagement = latest end date (p2)
  expect(omni.endDate).toBe("2026-07-31");
  expect(omni.startDate).toBe("2026-06-01");
  // An unlinked campaign stands alone, grouped by its own title.
  const sweat = clubbed.find((c) => c.id === "sweatbet")!;
  expect(sweat.name).toBe("Sweatbet");
  expect(sweat.accountIds).toEqual(["act_1540281067638398"]);
  expect(sweat.activeAccountIds).toEqual(["act_1540281067638398"]);
});

test("parseCampaignRow extracts columns incl. client relation and skips titleless rows", () => {
  const page = {
    id: "p1",
    properties: {
      Campaign: { type: "title", title: [{ plain_text: "Farside (2)" }] },
      "Client Account": { type: "relation", relation: [{ id: "client_omni" }] },
      "Active Account ID": { type: "rich_text", rich_text: [{ plain_text: "1701082927919653" }] },
      "Other ad accounts": {
        type: "rich_text",
        rich_text: [{ plain_text: "1258479753143618, 902315445715505" }],
      },
      "Account Status": { type: "status", status: { name: "Live" } },
    },
  } as unknown as NotionPage;
  const row = parseCampaignRow(page)!;
  expect(row.title).toBe("Farside (2)");
  expect(row.clientRelationIds).toEqual(["client_omni"]);
  expect(row.activeIds).toEqual(["act_1701082927919653"]);
  expect(row.otherIds).toEqual(["act_1258479753143618", "act_902315445715505"]);
  expect(row.status).toBe("Live");
  expect(parseCampaignRow({ id: "x", properties: {} } as NotionPage)).toBeNull();
});

test("parseClientName reads the Clients board title", () => {
  const page = {
    id: "c1",
    properties: { "Client Name": { type: "title", title: [{ plain_text: "omni agency" }] } },
  } as unknown as NotionPage;
  expect(parseClientName(page)).toBe("omni agency");
});

test("parseNotionDbId accepts urls and raw ids", () => {
  expect(
    parseNotionDbId(
      "https://app.notion.com/p/dotaudiences/a9db4fac5877839fbcba01f33f9674ef?v=888b4fac587782b0b42a080a93abd29f",
    ),
  ).toBe("a9db4fac-5877-839f-bcba-01f33f9674ef");
  expect(parseNotionDbId("a9db4fac-5877-839f-bcba-01f33f9674ef")).toBe(
    "a9db4fac-5877-839f-bcba-01f33f9674ef",
  );
  expect(parseNotionDbId("not an id")).toBeNull();
});
