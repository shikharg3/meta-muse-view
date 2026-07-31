import { test, expect } from "bun:test";
import { attributeCampaign, brandVocab, nameTokens, normalizeName } from "./attribution";

// Vocabularies exactly as they appear in prod (client name + Notion row titles).
const sweatbet = brandVocab("sweatbet", "Sweatbet", ["Sweatbet Launch"]);
const acrpoker = brandVocab("acrpoker-eu", "acrpoker.eu", [
  "ACR Poker",
  "acrpoker.eu Money Maker",
  "acrpoker.eu Welcome Bonus",
]);
const genesys = brandVocab("genesysone-com", "genesysone.com", [
  "genesysaffiliates.com",
  "genesysone.com",
  "genesysone.com Relaunch",
]);
const jackbit = brandVocab("jackbit-io", "jackbit.io", ["Jackbit.io"]);
const fivebet = brandVocab("5bet-com", "5bet.com", ["5bet.com (Launch)"]);
const nivo = brandVocab("nivogames", "NivoGames", ["NivoGames"]);
const rolling = brandVocab("rollingslots-com", "Rollingslots.com", [
  "Rollingslots.com (Aff Republic)",
]);
const doubledice = brandVocab("doubledice-com", "doubledice.com", [
  "doubledice.com (Sportserve Agency)",
]);
const arabic = brandVocab("arabic888-com", "arabic888.com", ["arabic888.com"]);
const reels = brandVocab("reels-io", "reels.io", ["reels.io"]);

test("normalizeName and nameTokens strip noise, numbers, and generic words", () => {
  expect(normalizeName("Rolling Slots/03.04/1-1-10/road2")).toBe("rollingslots03041110road2");
  expect(nameTokens("5bet/16.07/d3")).toEqual(["5bet"]);
  // stopwords (copy/cbo) and pure numbers are dropped
  expect(nameTokens("DoubleDice/TR/1896/CBO - Copy")).toEqual(["doubledice"]);
});
test("genesysone vs jackbit — the $9.8k account splits by containment", () => {
  const pair = [genesys, jackbit];
  for (const c of [
    "Genesys One JPT Wheel - Dep - NC",
    "Genesys One JPT Wheel - Dep - NC - Statewise",
    "Genesys One JPT Wheel - Reg - NC",
    "Genesys One - JPT Wheel - Dep",
    "Genesys One - JPT Wheel",
  ]) {
    expect(attributeCampaign(c, pair)).toBe("genesysone-com");
  }
  expect(attributeCampaign("Jackbit Aviator", pair)).toBe("jackbit-io");
});

test("Sweatbet vs acrpoker.eu — 'ACR Bonus' resolves via the row-title token", () => {
  const pair = [sweatbet, acrpoker];
  expect(attributeCampaign("SweatBet", pair)).toBe("sweatbet");
  expect(attributeCampaign("SweatBet - PWA", pair)).toBe("sweatbet");
  // No key containment ("acrpoker" is not inside "acrbonus"); the token `acr` from "ACR Poker" wins.
  expect(attributeCampaign("ACR Bonus", pair)).toBe("acrpoker-eu");
});

test("5bet.com vs NivoGames — every campaign belongs to 5bet, none to Nivo", () => {
  const pair = [fivebet, nivo];
  for (const c of ["5bet/16.07/d3", "5bet/16.07/d1", "5bet/21.07/s3", "5bet/16.07/d"]) {
    expect(attributeCampaign(c, pair)).toBe("5bet-com");
  }
});

test("Rollingslots vs doubledice — split, and third-party 'Reels' campaigns stay ambiguous", () => {
  const pair = [rolling, doubledice];
  expect(attributeCampaign("Rolling Slots/03.04/1-1-10/road2", pair)).toBe("rollingslots-com");
  expect(attributeCampaign("Rolling Slots/09.04/road1", pair)).toBe("rollingslots-com");
  expect(attributeCampaign("DoubleDice/19.031896/CBO01", pair)).toBe("doubledice-com");
  expect(attributeCampaign("DoubleDice/TR/1896/CBO - Copy", pair)).toBe("doubledice-com");
  // Reels belongs to neither contender -> ambiguous -> caller keeps account-level behaviour.
  expect(attributeCampaign("Reels/CA/1896/21.01/CBO", pair)).toBeNull();
  expect(attributeCampaign("Reels/CA/1896/26ю.01/CBO/Linki", pair)).toBeNull();
});

test("arabic888 vs reels.io — Reels matches, unknown brand stays ambiguous", () => {
  const pair = [arabic, reels];
  expect(attributeCampaign("Reels #3 Regs", pair)).toBe("reels-io");
  expect(attributeCampaign("Reels Game Prelander SE", pair)).toBe("reels-io");
  expect(attributeCampaign("RoyalCas - NC - PWA", pair)).toBeNull();
  expect(attributeCampaign("RoyalCas - NC - Copy", pair)).toBeNull();
});

test("a generic name matching nothing is ambiguous rather than guessed", () => {
  expect(attributeCampaign("Retargeting - Copy", [sweatbet, acrpoker])).toBeNull();
  // Two brands present: the LONGER key wins, so a specific brand beats one that is merely a
  // substring of it (e.g. "bet25sport" over "bet25") — deterministic, not a coin flip.
  expect(attributeCampaign("SweatBet x Jackbit", [sweatbet, jackbit])).toBe("sweatbet");
  // A genuine tie (equal-length keys, neither more specific) stays ambiguous.
  const alpha = brandVocab("alpha", "Alpha", []);
  const bravo = brandVocab("bravo", "Bravo", []);
  expect(attributeCampaign("Alpha Bravo combined", [alpha, bravo])).toBeNull();
});
