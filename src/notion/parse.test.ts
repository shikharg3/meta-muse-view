import { test, expect } from "bun:test";
import { parseAccountIds, clientKey, clientSlug, clubClients, parseClientRow } from "./parse";
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

test("clubClients unions accounts across rows and keeps the strongest status", () => {
  const clubbed = clubClients([
    {
      pageId: "p1",
      title: "wildcasino.ag (May/June 2026))",
      activeIds: ["act_1372577337735758"],
      otherIds: ["act_1210811414237867"],
      status: "Full Budget Finished",
    },
    {
      pageId: "p2",
      title: "wildcasino.ag (June/July 2026)",
      activeIds: ["act_1372577337735758"],
      otherIds: [],
      status: "Live",
    },
    {
      pageId: "p3",
      title: "ACR Poker",
      activeIds: ["act_1173350144474106"],
      otherIds: [],
      status: "Live",
    },
  ]);
  expect(clubbed).toHaveLength(2);
  const wild = clubbed.find((c) => c.id === "wildcasino-ag")!;
  expect(wild.accountIds.sort()).toEqual(["act_1210811414237867", "act_1372577337735758"].sort());
  expect(wild.status).toBe("Live"); // Live beats Full Budget Finished
  expect(wild.pages).toHaveLength(2);
});

test("parseClientRow extracts columns and skips titleless rows", () => {
  const page = {
    id: "p1",
    properties: {
      Client: { type: "title", title: [{ plain_text: "bspin.io (June 2026)" }] },
      "Active Account ID": { type: "rich_text", rich_text: [{ plain_text: "1701082927919653" }] },
      "Other ad accounts": {
        type: "rich_text",
        rich_text: [{ plain_text: "1258479753143618, 902315445715505" }],
      },
      "Account Status": { type: "status", status: { name: "Live" } },
    },
  } as unknown as NotionPage;
  const row = parseClientRow(page)!;
  expect(row.title).toBe("bspin.io (June 2026)");
  expect(row.activeIds).toEqual(["act_1701082927919653"]);
  expect(row.otherIds).toEqual(["act_1258479753143618", "act_902315445715505"]);
  expect(row.status).toBe("Live");
  expect(parseClientRow({ id: "x", properties: {} } as NotionPage)).toBeNull();
});

test("parseNotionDbId accepts urls and raw ids", () => {
  expect(
    parseNotionDbId(
      "https://app.notion.com/p/dotaudiences/154b4fac5877806cafcdf93332583727?v=a341954850e244008b242d3064133989",
    ),
  ).toBe("154b4fac-5877-806c-afcd-f93332583727");
  expect(parseNotionDbId("154b4fac-5877-806c-afcd-f93332583727")).toBe(
    "154b4fac-5877-806c-afcd-f93332583727",
  );
  expect(parseNotionDbId("not an id")).toBeNull();
});
