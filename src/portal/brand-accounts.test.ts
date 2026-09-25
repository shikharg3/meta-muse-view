import { describe, expect, it } from "bun:test";
import {
  autoGroupKey,
  baseTitle,
  brandAccountIds,
  clientProjects,
  coveredProjects,
  projectGroups,
  projectOfAccount,
  projectSelection,
} from "@/portal/brand-accounts";

/**
 * A brand's account list decides which client sees which spend, so the property worth pinning is
 * that neither rule can ever WIDEN it. Everything here is pure — no database.
 */

const client = {
  notionAccountIds: ["act_1", "act_2", "act_3"],
  manualAddIds: ["act_4"],
  manualRemoveIds: ["act_3"], // explicitly dropped by an operator
  raw: [
    { pageId: "p_live", title: "acme (September)", status: "Live", accountIds: ["act_1", "act_3"] },
    {
      pageId: "p_old",
      title: "acme (July)",
      status: "Full Budget Finished",
      accountIds: ["act_2"],
    },
    { pageId: "p_empty", title: "acme (draft)", status: "Not started", accountIds: [] },
  ],
};

describe("clientProjects", () => {
  it("keeps every board row, including one with no accounts yet", () => {
    expect(clientProjects(client.raw).map((p) => p.pageId)).toEqual(["p_live", "p_old", "p_empty"]);
  });

  it("drops a row with no pageId, because a selection has nothing to refer to", () => {
    expect(clientProjects([{ title: "no id", accountIds: ["act_1"] }])).toEqual([]);
  });

  it("survives a board row that is not an object at all", () => {
    // `raw` mirrors a board people edit by hand; one bad row must not take the client down.
    expect(clientProjects([null, "x", { pageId: "p", title: "t", status: null }])).toHaveLength(1);
  });
});

describe("projectSelection", () => {
  it("keeps null distinct from empty, because they mean opposite things", () => {
    // null = follow the client (every project). [] = cover no projects, therefore no accounts.
    expect(projectSelection(null)).toBeNull();
    expect(projectSelection(undefined)).toBeNull();
    expect(projectSelection([])).toEqual([]);
  });
});

describe("brandAccountIds", () => {
  it("follows the client when no projects are selected", () => {
    // (notion ∪ manualAdd) − manualRemove. act_3 is removed even though p_live still lists it.
    expect(brandAccountIds(null, client).sort()).toEqual(["act_1", "act_2", "act_4"]);
  });

  it("covers only the selected projects' accounts", () => {
    expect(brandAccountIds(["p_old"], client)).toEqual(["act_2"]);
  });

  it("still excludes an account the operator removed from the client", () => {
    // p_live lists act_3, but the client's manualRemoveIds drop it. The board must not win.
    expect(brandAccountIds(["p_live"], client)).toEqual(["act_1"]);
  });

  it("returns nothing for an empty selection, rather than falling back to every account", () => {
    expect(brandAccountIds([], client)).toEqual([]);
  });

  it("ignores a page id that is no longer on the board", () => {
    expect(brandAccountIds(["p_live", "p_deleted"], client)).toEqual(["act_1"]);
  });

  it("lets the brand_accounts override narrow the result", () => {
    expect(brandAccountIds(null, client, ["act_2"])).toEqual(["act_2"]);
  });

  it("never lets the override ADD an account the projects did not yield", () => {
    // act_9 belongs to somebody else entirely; act_3 was removed from this client. An additive
    // override is the one mistake here that leaks across clients, so intersection is the contract.
    expect(brandAccountIds(["p_old"], client, ["act_2", "act_3", "act_9"])).toEqual(["act_2"]);
  });

  it("yields nothing when the client has no effective accounts at all", () => {
    const stripped = { ...client, notionAccountIds: [], manualAddIds: [] };
    expect(brandAccountIds(null, stripped)).toEqual([]);
  });
});

describe("projectOfAccount", () => {
  // One owner, one ad account reused month to month: board order is newest first.
  const board = [
    { pageId: "p_sept", title: "acme (September)", status: "Live", accountIds: ["act_1"] },
    { pageId: "p_aug", title: "acme (August)", status: "Finished", accountIds: ["act_1", "act_2"] },
  ];

  it("files a shared account under the newest project listing it", () => {
    const owner = projectOfAccount(clientProjects(board), ["act_1", "act_2"]);
    expect(Object.fromEntries(owner)).toEqual({ act_1: "p_sept", act_2: "p_aug" });
  });

  it("keeps board order whatever order the selection was saved in", () => {
    // A selection is a set, not a ranking: saving it as [older, newer] must not hand the shared
    // account — and with it the campaigns' commission and ad page — to the older engagement.
    const covered = coveredProjects(["p_aug", "p_sept"], board);
    expect(projectOfAccount(covered, ["act_1"]).get("act_1")).toBe("p_sept");
  });

  it("attributes nothing for an account the brand does not resolve to", () => {
    // act_2 was removed from the client (or narrowed away), so no project may claim it.
    expect(projectOfAccount(clientProjects(board), ["act_1"]).has("act_2")).toBe(false);
  });
});

describe("brand groups", () => {
  const rows = (titles: string[]) =>
    clientProjects(titles.map((title, i) => ({ pageId: `p${i}`, title, accountIds: [] })));
  const grouping = (titles: string[]) =>
    projectGroups(rows(titles)).map((g) => [g.name, g.projects.map((p) => p.title)]);

  it("groups an owner's engagements of one brand, however the rows are titled", () => {
    // Real board titles (2026-09-25): a month in brackets, a word after, a stray bracket, a link.
    expect(
      grouping([
        "betonline.ag (September/October)",
        "betonline.ag (June 2026)",
        "Watt2Trade Renewal May 2026",
        "watt2trade.com",
        "wildcasino.ag (May/June 2026))",
        "https://playquack.com/ (2)",
        "https://playquack.com/",
      ]),
    ).toEqual([
      ["betonline.ag", ["betonline.ag (September/October)", "betonline.ag (June 2026)"]],
      ["watt2trade.com", ["Watt2Trade Renewal May 2026", "watt2trade.com"]],
      ["wildcasino.ag", ["wildcasino.ag (May/June 2026))"]],
      ["playquack.com", ["https://playquack.com/ (2)", "https://playquack.com/"]],
    ]);
  });

  it("keeps different brands of one owner apart", () => {
    expect(
      grouping([
        "Slots.lv",
        "CafeCasino",
        "Lucky Rebel",
        "genesysaffiliates.com",
        "genesysone.com",
      ]),
    ).toHaveLength(5);
  });

  it("lets an admin move a row, and names a group after the admin's name when set", () => {
    const board = rows(["acrpoker.eu Money Maker", "ACR Poker"]);
    const [only] = projectGroups(
      board,
      new Map([["p1", "acrpoker"]]),
      new Map([["acrpoker", "ACR"]]),
    );
    expect(only.projects.map((p) => p.pageId)).toEqual(["p0", "p1"]);
    expect([only.name, only.autoName, only.named, [...only.moved]]).toEqual([
      "ACR",
      "ACR Poker",
      true,
      ["p1"],
    ]);
  });

  it("gives a row with no letters or digits its own group rather than pooling them", () => {
    expect(projectGroups(rows(["???", "!!!"])).map((g) => g.key)).toEqual(["row:p0", "row:p1"]);
  });

  it("derives keys and names from the title alone", () => {
    expect([autoGroupKey("PlayW3_BeTheBoss"), autoGroupKey("www.bspin.io (April)")]).toEqual([
      "playw3",
      "bspin",
    ]);
    expect(baseTitle("solflare.com (#3) Card Waitlist")).toBe("solflare.com (#3) Card Waitlist");
  });
});
