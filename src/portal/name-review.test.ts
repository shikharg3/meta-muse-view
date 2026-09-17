import { describe, expect, it } from "bun:test";
import { clientTokens, reviewName } from "@/portal/name-review";

/**
 * Cases taken from the live board, so a regression here is a name that really would reach a client.
 */
const clients = clientTokens([
  { id: "sweatbet", name: "SweatBet" },
  { id: "playw3-com", name: "Playw3.com" },
  { id: "acrpoker-eu", name: "acrpoker.eu" },
  { id: "oneagency", name: "OneAgency" },
  { id: "bol", name: "BOL" }, // too short to compare — collides with ordinary words
]);

describe("clientTokens", () => {
  it("drops tokens under six characters, which would flag half the board", () => {
    expect(clients.map((c) => c.id)).not.toContain("bol");
  });
});

describe("reviewName", () => {
  it("flags a campaign naming a different client, and says who", () => {
    // `SweatBet - PWA` is a real name. It sits on an account acrpoker.eu also claims, so this is
    // the case the flag exists for — IF acrpoker.eu owned it.
    const r = reviewName("SweatBet - PWA", "acrpoker-eu", clients);
    expect(r.flags).toContain("mentions-other-client");
    expect(r.mentionsClient).toBe("SweatBet");
  });

  it("does not flag a campaign naming its OWN client", () => {
    // And this is what actually happens in production: the ownership ladder attributes that row to
    // SweatBet by brand name, so nothing fires. Account-based attribution would have said
    // acrpoker.eu and raised the false alarm above — which is why the owner must come from
    // `loadCampaignOwnership()`.
    const r = reviewName("SweatBet - PWA", "sweatbet", clients);
    expect(r.flags).not.toContain("mentions-other-client");
    expect(r.mentionsClient).toBeNull();
  });

  it("catches the row that ships a competitor's tracking URL", () => {
    // Real row. Its owner resolves to Playw3 by brand name, so `mentions-other-client` does NOT
    // fire in production — `contains-url` is what catches it, and a tracking domain in a
    // client-facing name is worth catching regardless of who owns the campaign.
    const r = reviewName("Betheboss CA - https://create.playw3.com/ - Copy", "oneagency", clients);
    expect(r.flags).toEqual(
      expect.arrayContaining(["mentions-other-client", "contains-url", "copy-suffix"]),
    );
  });

  it("flags Meta's own placeholder text", () => {
    expect(
      reviewName("New Traffic Campaign with recommended settings", null, clients).flags,
    ).toContain("placeholder");
    expect(reviewName("New Sales Campaign", null, clients).flags).toContain("placeholder");
  });

  it("flags an opaque id but not a real name of similar length", () => {
    expect(reviewName("fbmdpwa4oUnBF0505cab2266_4", null, clients).flags).toContain("opaque-id");
    expect(reviewName("Player Acquisition UK and Ireland", null, clients).flags).not.toContain(
      "opaque-id",
    );
  });

  it("flags a copy suffix only at the end", () => {
    expect(reviewName("BOL - Website - Casino - Copy 3", null, clients).flags).toContain(
      "copy-suffix",
    );
    expect(reviewName("Copycat Creative Test", null, clients).flags).not.toContain("copy-suffix");
  });

  it("leaves a clean name completely unflagged", () => {
    expect(reviewName("Welcome Offer Casino", "sweatbet", clients).flags).toEqual([]);
  });

  it("does not flag agency strategy vocabulary, which is not a client-facing problem", () => {
    // 54 of 627 names carry these. Flagging them would train people to ignore the flag.
    expect(reviewName("SLV Prospecting TOF - Broad", null, clients).flags).toEqual([]);
    expect(reviewName("High Rollers Lookalike", null, clients).flags).toEqual([]);
  });
});
