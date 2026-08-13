import { test, expect } from "bun:test";
import {
  parseAccountIds,
  clientKey,
  clientSlug,
  clubClients,
  parseCampaignRow,
  parseClientName,
  brandTitles,
  boardRows,
  resolvePropertyKey,
  LIVE_STATUSES,
  STATUS_PRIORITY,
} from "./parse";
import { MACHINE_STATUSES, HUMAN_STATUSES } from "@/lib/delivery-status";
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

test("boardRows keeps page ids and each row's own status", () => {
  expect(
    boardRows([
      { pageId: "p1", title: "Slots.lv", status: "Live" },
      { pageId: "p2", title: "No status" },
      { title: "no id" },
      null,
    ]),
  ).toEqual([
    { pageId: "p1", title: "Slots.lv", status: "Live", ownerIds: [] },
    { pageId: "p2", title: "No status", status: null, ownerIds: [] },
  ]);
  expect(boardRows(null)).toEqual([]);
  expect(boardRows("not-an-array")).toEqual([]);
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
        ownerIds: [],
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
        ownerIds: [],
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
        ownerIds: [],
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
  // Each contributing row keeps its own account mapping (per-campaign reporting).
  expect(omni.pages[0]).toMatchObject({
    title: "zaddycoin.io",
    status: "Full Budget Finished",
    accountIds: ["act_1372577337735758", "act_1210811414237867"],
  });
  expect(omni.budget).toBe(7000); // current engagement = latest end date (p2)
  expect(omni.endDate).toBe("2026-07-31");
  expect(omni.startDate).toBe("2026-06-01");
  // An unlinked campaign stands alone, grouped by its own title.
  const sweat = clubbed.find((c) => c.id === "sweatbet")!;
  expect(sweat.name).toBe("Sweatbet");
  expect(sweat.accountIds).toEqual(["act_1540281067638398"]);
  expect(sweat.activeAccountIds).toEqual(["act_1540281067638398"]);
});

test("clubClients takes the active account from the winning-status row, not finished rows", () => {
  // Same client, two rows: a current Live row and an old Full Budget Finished row with a stale active.
  const clubbed = clubClients(
    [
      {
        pageId: "p1",
        title: "bspin.io (June/July)",
        clientRelationIds: [],
        activeIds: ["act_current"],
        otherIds: ["act_other"],
        status: "Live",
        budget: null,
        startDate: null,
        endDate: "2026-07-31",
        ownerIds: [],
      },
      {
        pageId: "p2",
        title: "bspin.io (April)",
        clientRelationIds: [],
        activeIds: ["act_stale"],
        otherIds: [],
        status: "Full Budget Finished",
        budget: null,
        startDate: null,
        endDate: "2026-04-30",
        ownerIds: [],
      },
    ],
    new Map(),
  );
  expect(clubbed).toHaveLength(1);
  const c = clubbed[0];
  expect(c.status).toBe("Live");
  expect(c.activeAccountIds).toEqual(["act_current"]); // the finished row's stale active is excluded
  expect(c.accountIds.sort()).toEqual(["act_current", "act_other", "act_stale"].sort()); // all tracked
});

test("resolvePropertyKey survives the cosmetic drift real boards have", () => {
  // Exact match wins even when a marked variant is also present.
  const keys = [
    "Campaign",
    "Daily Budget ($)",
    "Ads Platform ", // trailing space, as on the live board
    " Meta URL", // leading space
    "Remaining to send  ($)", // double space
  ];
  expect(resolvePropertyKey(keys, "Daily Budget ($)")).toBe("Daily Budget ($)");
  expect(resolvePropertyKey(keys, "Ads Platform")).toBe("Ads Platform ");
  expect(resolvePropertyKey(keys, "Meta URL")).toBe(" Meta URL");
  expect(resolvePropertyKey(keys, "Remaining to send ($)")).toBe("Remaining to send  ($)");
  expect(resolvePropertyKey(keys, "Budget ($)")).toBeNull();
  // Once the auto-update marker is stamped on, the same lookup still finds the column.
  expect(resolvePropertyKey(["🤖 Daily Budget ($)"], "Daily Budget ($)")).toBe(
    "🤖 Daily Budget ($)",
  );
  expect(resolvePropertyKey(["Daily Budget ($)", "🤖 Daily Budget ($)"], "Daily Budget ($)")).toBe(
    "Daily Budget ($)",
  );
});

test("a Budget Finished - Top Up row outranks other statuses and keeps its active account", () => {
  // The status means "still running, awaiting a top-up". Missing from the priority table it scored 0
  // and lost to "Not started", which handed the client the wrong row's active account.
  const clubbed = clubClients(
    [
      {
        pageId: "p1",
        title: "wildcasino.ag (August)",
        clientRelationIds: [],
        activeIds: ["act_topup"],
        otherIds: [],
        status: "Budget Finished - Top Up",
        budget: null,
        startDate: null,
        endDate: "2026-08-31",
        ownerIds: [],
      },
      {
        pageId: "p2",
        title: "wildcasino.ag (September)",
        clientRelationIds: [],
        activeIds: ["act_future"],
        otherIds: [],
        status: "Not started",
        budget: null,
        startDate: null,
        endDate: "2026-09-30",
        ownerIds: [],
      },
    ],
    new Map(),
  );
  expect(clubbed).toHaveLength(1);
  expect(clubbed[0].status).toBe("Budget Finished - Top Up");
  expect(clubbed[0].activeAccountIds).toEqual(["act_topup"]);
  expect(LIVE_STATUSES).toContain("Budget Finished - Top Up");
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

test("STATUS_PRIORITY ranks every board option, machine states above commercial ones", () => {
  // The map answers "which of a client's rows is the CURRENT engagement". Every machine value
  // describes a current engagement that happens to be broken, so all of them outrank the
  // commercial states.
  const order = Object.entries(STATUS_PRIORITY)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  expect(order).toEqual([
    "Live",
    "All ads rejected",
    "Ad Account Blocked",
    "Ad Account Disabled",
    "Paused",
    "Budget Finished - Top Up",
    "On Boarding",
    "Full Budget Finished",
    "Not started",
  ]);
});

test("every machine and human status is scored", () => {
  for (const s of [...MACHINE_STATUSES, ...HUMAN_STATUSES]) {
    expect(STATUS_PRIORITY[s]).toBeGreaterThan(0);
  }
});

test("LIVE_STATUSES means 'engagement is current', so it holds every machine value", () => {
  for (const s of MACHINE_STATUSES) expect(LIVE_STATUSES).toContain(s);
});

test("LIVE_STATUSES keeps the two human values it already had", () => {
  // Dropping these would silently stop budget maintenance for onboarding and top-up rows.
  expect(LIVE_STATUSES).toContain("On Boarding");
  expect(LIVE_STATUSES).toContain("Budget Finished - Top Up");
});

test("finished and not-started engagements stay outside LIVE_STATUSES", () => {
  expect(LIVE_STATUSES).not.toContain("Full Budget Finished");
  expect(LIVE_STATUSES).not.toContain("Not started");
});

test("parseCampaignRow still finds Account Status once the marker is stamped on it", () => {
  // The write side resolves this column fuzzily and renames it to carry 🤖. An exact-name read would
  // then miss, yielding status: null for EVERY row — which makes all of them non-live, stops all five
  // numeric columns, nulls clients.status and leaves STATUS_PRIORITY scoring every row 0.
  const marked = {
    id: "p1",
    properties: {
      Campaign: { type: "title", title: [{ plain_text: "Slots.lv" }] },
      "🤖 Account Status": { type: "status", status: { name: "Live" } },
    },
  } as unknown as NotionPage;
  expect(parseCampaignRow(marked)!.status).toBe("Live");

  const plainName = {
    id: "p2",
    properties: {
      Campaign: { type: "title", title: [{ plain_text: "Slots.lv" }] },
      "Account Status": { type: "status", status: { name: "Paused" } },
    },
  } as unknown as NotionPage;
  expect(parseCampaignRow(plainName)!.status).toBe("Paused");

  const absent = {
    id: "p3",
    properties: { Campaign: { type: "title", title: [{ plain_text: "Slots.lv" }] } },
  } as unknown as NotionPage;
  expect(parseCampaignRow(absent)!.status).toBeNull();
});

const VLAD = "2cbd872b-594c-8119-9649-0002845d8d9c";
const SHIKHAR = "254d872b-594c-8154-9479-000271904e5b";

test("parseCampaignRow reads Owners person ids", () => {
  const row = parseCampaignRow({
    id: "page-1",
    properties: {
      Campaign: { type: "title", title: [{ plain_text: "Slots.lv" }] },
      Owners: {
        type: "people",
        people: [
          { id: SHIKHAR, name: "Shikhar Gupta" },
          { id: VLAD, name: "Vladyslav Istrati" },
        ],
      },
    },
  } as never);

  expect(row?.ownerIds).toEqual([SHIKHAR, VLAD]);
});

test("a row with no Owners cell parses to an empty owner list", () => {
  const row = parseCampaignRow({
    id: "page-2",
    properties: { Campaign: { type: "title", title: [{ plain_text: "Farside" }] } },
  } as never);

  expect(row?.ownerIds).toEqual([]);
});

test("owner ids survive clubbing and the clients.raw round-trip", () => {
  // clubClients output is written verbatim to clients.raw, and boardRows reads it back. If either
  // side drops ownerIds the check-in silently prompts nobody.
  const clubbed = clubClients(
    [
      {
        pageId: "page-1",
        title: "Slots.lv",
        clientRelationIds: [],
        activeIds: ["act_1"],
        otherIds: [],
        status: "Live",
        budget: null,
        startDate: null,
        endDate: null,
        ownerIds: [SHIKHAR],
      },
    ],
    new Map(),
  );

  expect(clubbed[0].pages[0].ownerIds).toEqual([SHIKHAR]);
  expect(boardRows(clubbed[0].pages)).toEqual([
    { pageId: "page-1", title: "Slots.lv", status: "Live", ownerIds: [SHIKHAR] },
  ]);
});

test("boardRows tolerates rows stored before owners existed", () => {
  // Existing clients.raw rows have no ownerIds. They must read back as [] rather than undefined.
  expect(boardRows([{ pageId: "p", title: "t", status: "Live" }])).toEqual([
    { pageId: "p", title: "t", status: "Live", ownerIds: [] },
  ]);
});

test("parseCampaignRow ignores owner entries with no usable person id", () => {
  // Notion can return a people entry the integration cannot see (no id at all). Such an entry must
  // vanish rather than land in ownerIds as undefined/"" — planPrompts would then match a buyer whose
  // own telegram mapping is blank.
  const row = parseCampaignRow({
    id: "page-3",
    properties: {
      Campaign: { type: "title", title: [{ plain_text: "Slots.lv" }] },
      Owners: {
        type: "people",
        people: [{ name: "Nick" }, { id: "" }, { id: SHIKHAR, name: "Shikhar Gupta" }],
      },
    },
  } as never);

  expect(row?.ownerIds).toEqual([SHIKHAR]);
});

test("boardRows keeps only string owner ids out of jsonb", () => {
  // `clients.raw` is jsonb: anything can come back. Non-strings must be dropped and a non-array
  // ownerIds must degrade to [], never leak into the recipient list.
  expect(
    boardRows([{ pageId: "p", title: "t", status: "Live", ownerIds: [SHIKHAR, 7, null] }])[0],
  ).toEqual({ pageId: "p", title: "t", status: "Live", ownerIds: [SHIKHAR] });
  expect(boardRows([{ pageId: "p", title: "t", status: "Live", ownerIds: SHIKHAR }])[0]).toEqual({
    pageId: "p",
    title: "t",
    status: "Live",
    ownerIds: [],
  });
});

test("boardRows drops empty-string owner ids, exactly as peopleIds does on the way in", () => {
  // The two sides must apply the SAME id test. jsonb is the less trusted input of the pair, so it
  // must not be the more permissive one: an "" id is a recipient nobody can ever be matched to.
  expect(
    boardRows([{ pageId: "p", title: "t", status: "Live", ownerIds: ["", SHIKHAR] }])[0],
  ).toEqual({ pageId: "p", title: "t", status: "Live", ownerIds: [SHIKHAR] });
});
