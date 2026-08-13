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
  // Asserted whole, not by `toContain`: a containment check cannot see an ADDED line, so the
  // marker branch that suppresses the question line under closed campaigns would be undefended.
  // This pins the header, the blank line, the numbering, the em-dash separator and the 3-space
  // question indent together.
  expect(text).toBe(
    "🕔 Daily check-in — Thu 13 Aug\n" +
      "\n" +
      "1. Slots.lv — Live\n" +
      "   Any changes today?\n" +
      "2. Lucky Rebel — Ad Account Blocked\n" +
      "   Funding/top-up status?",
  );
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
    { ...items[0], promptId: 9, title: "Palmluck", state: "escalated" },
  ]);
  // Whole-text again: a closed campaign must LOSE its question line, which `toContain` cannot see.
  expect(text).toBe(
    "🕔 Daily check-in — Thu 13 Aug\n" +
      "\n" +
      "1. ✅ Slots.lv — Live\n" +
      "2. ✍️ Lucky Rebel — Ad Account Blocked\n" +
      "3. ⏭️ Palmluck — Live",
  );
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
  // The bound is the LITERAL 2000, not NOTION_TEXT_LIMIT: slicing and asserting with the same
  // constant is tautological, so raising the limit to 2048 or 2500 — the plausible "round it up"
  // regression that makes Notion 400 the request — would otherwise still pass.
  expect(NOTION_TEXT_LIMIT).toBe(2000);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  // Nothing is lost: every character of the answer survives the split.
  expect(chunks.join("").endsWith("x".repeat(50))).toBe(true);
  expect(chunks.join("").match(/x/g)?.length).toBe(2500);
});

/** The comment for a fixed prompt, varying only the answer, so a test can size it to a boundary. */
const bodyFor = (answer: string) =>
  commentBody({
    date: "2026-08-13",
    buyerName: "Vladyslav Istrati",
    status: "Live",
    question: "Any changes today?",
    answer,
  });

test("a body of exactly the limit is one chunk, with no empty chunk after it", () => {
  // The off-by-one boundary: `i < full.length` must stop here rather than emitting a trailing "".
  const head = bodyFor("")[0].length;
  const chunks = bodyFor("y".repeat(2000 - head));
  expect(chunks).toHaveLength(1);
  expect(chunks[0].length).toBe(2000);
  expect(chunks.some((c) => c.length === 0)).toBe(false);
});

test("an answer at Telegram's own 4096 cap is chunked losslessly", () => {
  // 4096 is the longest answer that can ever arrive, so this is the real worst case.
  const answer = "z".repeat(4096);
  const chunks = bodyFor(answer);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  expect(chunks.join("")).toBe(bodyFor("")[0] + answer);
  expect(chunks.join("").match(/z/g)?.length).toBe(4096);
});

test("a chunk boundary never splits an emoji into lone surrogates", () => {
  // Buyers answer from Telegram and do type emoji. A cut on a UTF-16 code unit can end a chunk on
  // a high surrogate and open the next with its orphan; Notion then stores an ill-formed rich_text
  // item and the card renders U+FFFD.
  const chunks = bodyFor("😀".repeat(2000));
  for (const c of chunks) {
    const first = c.charCodeAt(0);
    const last = c.charCodeAt(c.length - 1);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // no leading orphan low surrogate
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no trailing orphan high surrogate
    expect(c.length).toBeLessThanOrEqual(2000);
  }
  expect(chunks.join("")).toBe(bodyFor("")[0] + "😀".repeat(2000));
  expect(chunks.join("").match(/😀/gu)?.length).toBe(2000);
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

test("a single unanswered campaign reads '1 campaign', not '1 campaigns'", () => {
  // This goes to the shared alert channel every morning; the plural branch is the only one the
  // three-campaign case above exercises.
  const text = escalationText("2026-08-13", [
    { buyerName: "Shikhar Gupta", titles: ["Slots.lv"], unroutable: false },
  ]);
  expect(text).toContain("⚠️ Check-in 2026-08-13 — 1 campaign unanswered");
  expect(text).not.toContain("1 campaigns");
});
