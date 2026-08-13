import { test, expect } from "bun:test";
import {
  callbackData,
  parseCallback,
  renderList,
  forceReplyText,
  commentBody,
  escalationText,
  NOTION_TEXT_LIMIT,
  type ListItem,
  dayLabel,
} from "./checkin-render";

/**
 * Run `fn` as if the process were in `tz`, then restore.
 *
 * Restores a CONCRETE zone name: `process.env.TZ` is unset under `bun test`, and assigning
 * `undefined` to a `process.env` key stores the literal string `"undefined"`, which leaves ICU
 * pinned to the hostile zone for the rest of the process.
 */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

test("dayLabel formats a date as 'Thu 13 Aug'", () => {
  expect(dayLabel("2026-08-13")).toBe("Thu 13 Aug");
  expect(dayLabel("2026-08-03")).toBe("Mon 03 Aug");
  expect(dayLabel("2026-01-01")).toBe("Thu 01 Jan");
});

test("dayLabel ignores the process timezone", () => {
  // The Pacific/Midway (UTC-11) case is the one that bites: it is what fails if the UTC getters are
  // ever swapped for local ones. UTC+14 does not shift a 00:00Z date at all.
  expect(withTZ("Pacific/Kiritimati", () => dayLabel("2026-08-13"))).toBe("Thu 13 Aug");
  expect(withTZ("Pacific/Midway", () => dayLabel("2026-08-13"))).toBe("Thu 13 Aug");
});

test("dayLabel refuses a malformed date instead of rendering garbage", () => {
  // Without the guard these return the literal string "undefined NaN undefined", which this
  // function's own docstring would put at the top of the buyer's daily message.
  for (const bad of ["garbage", "", "2026-13-45", "2026-8-3"]) {
    expect(() => dayLabel(bad)).toThrow("not a YYYY-MM-DD date");
  }
});

const items: ListItem[] = [
  {
    promptId: 7,
    title: "Slots.lv",
    status: "Live",
    question: "Any changes today?",
    state: "pending",
  },
  {
    promptId: 8,
    title: "Lucky Rebel",
    status: "Ad Account Blocked",
    question: "Funding/top-up status?",
    state: "pending",
  },
];

test("callback data round-trips and stays within Telegram's 64-byte limit", () => {
  expect(callbackData("no_changes", 7)).toBe("nc:7");
  expect(callbackData("update", 7)).toBe("up:7");
  expect(parseCallback("nc:7")).toEqual({ action: "no_changes", promptId: 7 });
  expect(parseCallback("up:12345")).toEqual({ action: "update", promptId: 12345 });
  expect(Buffer.byteLength(callbackData("no_changes", 2_000_000_000))).toBeLessThan(64);
});

test("malformed callback data is rejected rather than guessed", () => {
  expect(parseCallback("")).toBeNull();
  expect(parseCallback("xx:7")).toBeNull();
  expect(parseCallback("nc:")).toBeNull();
  expect(parseCallback("nc:abc")).toBeNull();
  expect(parseCallback("nc:7:8")).toBeNull();
});

test("the daily list numbers campaigns and pairs each with two buttons", () => {
  const { text, keyboard } = renderList("Thu 13 Aug", items);
  expect(text).toContain("🕔 Daily check-in — Thu 13 Aug");
  expect(text).toContain("1. Slots.lv — Live");
  expect(text).toContain("2. Lucky Rebel — Ad Account Blocked");
  expect(keyboard).toEqual([
    [
      { text: "✅ No changes · 1", callback_data: "nc:7" },
      { text: "✍️ Update · 1", callback_data: "up:7" },
    ],
    [
      { text: "✅ No changes · 2", callback_data: "nc:8" },
      { text: "✍️ Update · 2", callback_data: "up:8" },
    ],
  ]);
});

test("closed campaigns keep their number, show a marker and lose their buttons", () => {
  const { text, keyboard } = renderList("Thu 13 Aug", [
    { ...items[0], state: "no_changes" },
    { ...items[1], state: "answered" },
  ]);
  expect(text).toContain("1. ✅ Slots.lv");
  expect(text).toContain("2. ✍️ Lucky Rebel");
  expect(keyboard).toEqual([]);
});

test("an awaiting_reply campaign still offers no changes but not a second update prompt", () => {
  const { keyboard } = renderList("Thu 13 Aug", [{ ...items[0], state: "awaiting_reply" }]);
  expect(keyboard).toEqual([[{ text: "✅ No changes · 1", callback_data: "nc:7" }]]);
});

test("the force-reply prompt names the campaign and asks for a reply", () => {
  expect(
    forceReplyText({ title: "Slots.lv", status: "Live", question: "Any changes today?" }),
  ).toBe("✍️ Update for Slots.lv (Live)\nAny changes today?\n↩️ Reply to this message.");
});

test("the comment body carries date, buyer, status, question and answer", () => {
  expect(
    commentBody({
      date: "2026-08-13",
      buyerName: "Shikhar Gupta",
      status: "Ad Account Blocked",
      question: "Funding/top-up status?",
      answer: "Topped up $2k, delivery resumes tonight.",
    }),
  ).toEqual([
    "🤖 Daily check-in · 2026-08-13 · Shikhar Gupta\n" +
      "Status: Ad Account Blocked\n" +
      "Q: Funding/top-up status?\n" +
      "A: Topped up $2k, delivery resumes tonight.",
  ]);
});

test("a long answer splits into chunks instead of being truncated", () => {
  const answer = "x".repeat(2500);
  const chunks = commentBody({
    date: "2026-08-13",
    buyerName: "Vladyslav Istrati",
    status: "Live",
    question: "Any changes today?",
    answer,
  });
  expect(chunks.length).toBe(2);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(NOTION_TEXT_LIMIT);
  // Nothing is lost: every character of the answer survives the split.
  expect(chunks.join("").endsWith("x".repeat(50))).toBe(true);
  expect(chunks.join("").match(/x/g)?.length).toBe(2500);
});

test("the escalation message groups unanswered campaigns by buyer and names binding gaps", () => {
  const text = escalationText("2026-08-13", [
    { buyerName: "Shikhar Gupta", titles: ["Slots.lv", "Lucky Rebel"], unroutable: false },
    { buyerName: "Vladyslav Istrati", titles: ["CasinOK.com"], unroutable: true },
  ]);
  expect(text).toContain("⚠️ Check-in 2026-08-13 — 3 campaigns unanswered");
  expect(text).toContain("Shikhar Gupta: Slots.lv, Lucky Rebel");
  expect(text).toContain("Vladyslav Istrati (no Telegram binding): CasinOK.com");
});
