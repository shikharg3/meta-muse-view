// Dispatch tests for one Telegram update. Pure unit: every side effect is an injected fake, so
// there is no database and no network here.
//
// The rule under most of these tests is that AN ANSWER IS NEVER GUESSED. A misattributed answer
// writes one client's update onto another client's Notion card, and nothing downstream can detect
// it. So attribution is: (1) the `reply_to_message` id, (2) exactly one prompt awaiting a reply,
// (3) otherwise ASK. There is deliberately no "most recent" fallback.
import { test, expect } from "bun:test";
import { renderList } from "@/lib/checkin-render";
import { handleUpdate, type UpdateDeps, type PromptRow } from "./updates";

/**
 * `chatId` and `listMessageId` are nullable columns, so they are read with `in` rather than `??` —
 * `null ?? "111"` would make an explicit null impossible to express.
 */
const prompt = (o: Partial<PromptRow> = {}): PromptRow => ({
  id: o.id ?? 7,
  promptDate: o.promptDate ?? "2026-08-13",
  chatId: "chatId" in o ? (o.chatId ?? null) : "111",
  campaignTitle: o.campaignTitle ?? "Slots.lv",
  status: o.status ?? "Live",
  question: o.question ?? "Any changes today?",
  listMessageId: "listMessageId" in o ? (o.listMessageId ?? null) : "500",
  state: o.state ?? "pending",
});

interface SentMessage {
  chatId: string;
  text: string;
  forceReply: boolean;
}

interface RecordedChat {
  chatId: string;
  username?: string;
  firstName?: string;
}

/**
 * Records every deps call so a test can assert what the dispatcher decided to do.
 *
 * `log` is the ordered shape of the decision. `sent` and `chats` keep the FULL arguments, because
 * `log` truncates message text and a truncated log cannot prove what a message does or does not
 * contain — the unbound-chat leak boundary and the "which campaign" question are both text rules.
 *
 * The three campaign-data reads log a `lookup:` line, so a test can assert that a code path read no
 * campaign data at all. You cannot leak what you never fetched.
 */
function fakeDeps(overrides: Partial<UpdateDeps> = {}) {
  const log: string[] = [];
  const sent: SentMessage[] = [];
  const chats: RecordedChat[] = [];
  const deps: UpdateDeps = {
    sendMessage: async (chatId, text, forceReply) => {
      sent.push({ chatId, text, forceReply: forceReply === true });
      log.push(`send:${chatId}:${forceReply ? "force" : "plain"}:${text.slice(0, 24)}`);
      return { ok: true, messageId: 900 };
    },
    answerCallback: async (id, text) => {
      log.push(`ack:${id}:${text ?? ""}`);
    },
    recordChat: async (chatId, username, firstName) => {
      chats.push({ chatId, username, firstName });
      log.push(`chat:${chatId}`);
    },
    isBoundChat: async () => true,
    loadPrompt: async (id) => {
      log.push(`lookup:prompt:${id}`);
      return id === 7 ? prompt() : null;
    },
    loadPromptByReply: async (chatId, replyId) => {
      log.push(`lookup:reply:${chatId}:${replyId}`);
      return null;
    },
    openPromptsForChat: async (chatId) => {
      log.push(`lookup:open:${chatId}`);
      return [];
    },
    markNoChanges: async (id) => {
      log.push(`nochanges:${id}`);
    },
    markAwaitingReply: async (id, messageId) => {
      log.push(`awaiting:${id}:${messageId}`);
    },
    noteFailure: async (id, note) => {
      log.push(`note:${id}:${note}`);
    },
    saveAnswer: async (id, text) => {
      log.push(`answer:${id}:${text}`);
    },
    rerenderList: async (chatId, listMessageId) => {
      log.push(`rerender:${chatId}:${listMessageId}`);
    },
    ...overrides,
  };
  return { log, sent, chats, deps };
}

test("tapping No changes closes the prompt, writes nothing and re-renders", async () => {
  const { log, deps } = fakeDeps();

  await handleUpdate(
    { update_id: 1, callback_query: { id: "cb", data: "nc:7", from: { id: 111 } } },
    deps,
  );

  expect(log).toContain("nochanges:7");
  expect(log).toContain("rerender:111:500");
  // "No changes" is the operator's chosen filter: the button is the only way to say "nothing
  // happened", and it must never reach Notion.
  expect(log.some((l) => l.startsWith("answer:"))).toBe(false);
  // Exactly one ack, with the text the buyer sees. A second ack would be rejected by Telegram as a
  // stale query and log noise for a tap that in fact worked.
  expect(log.filter((l) => l.startsWith("ack:"))).toEqual(["ack:cb:Logged — no changes"]);
  // The write precedes the ack, so "Logged" can never be claimed for a write that failed...
  expect(log.indexOf("nochanges:7")).toBeLessThan(log.indexOf("ack:cb:Logged — no changes"));
  // ...and the ack precedes the two-call list re-render, so the button stops spinning first.
  expect(log.indexOf("ack:cb:Logged — no changes")).toBeLessThan(log.indexOf("rerender:111:500"));
});

test("tapping Update sends a force-reply prompt and records the message id", async () => {
  const { log, sent, deps } = fakeDeps();

  await handleUpdate(
    { update_id: 2, callback_query: { id: "cb", data: "up:7", from: { id: 111 } } },
    deps,
  );

  expect(sent).toEqual([
    {
      chatId: "111",
      text: "✍️ Update for Slots.lv (Live)\nAny changes today?\n↩️ Reply to this message.",
      forceReply: true,
    },
  ]);
  // The force-reply message id is what binds a later typed answer to THIS campaign.
  expect(log).toContain("awaiting:7:900");
  expect(log.filter((l) => l.startsWith("ack:"))).toEqual(["ack:cb:"]);
  // An armed prompt is not a failure: `note` holds the LAST error, so writing one here would leave a
  // stale cause on a row that worked.
  expect(log.some((l) => l.startsWith("note:"))).toBe(false);
});

test("a reply to the force-reply message is saved against that campaign", async () => {
  // Attribution ORDER: a different campaign is the single one awaiting a reply in this chat, so if
  // the plain-message rule were consulted first this update would land on Lucky Rebel's card.
  const { log, deps } = fakeDeps({
    loadPromptByReply: async (chatId, replyId) =>
      chatId === "111" && replyId === 900 ? prompt({ state: "awaiting_reply" }) : null,
    openPromptsForChat: async () => [
      prompt({
        id: 8,
        campaignTitle: "Lucky Rebel",
        state: "awaiting_reply",
        listMessageId: "800",
      }),
    ],
  });

  await handleUpdate(
    {
      update_id: 3,
      message: {
        message_id: 950,
        chat: { id: 111 },
        text: "Topped up $2k",
        reply_to_message: { message_id: 900 },
      },
    },
    deps,
  );

  expect(log).toContain("answer:7:Topped up $2k");
  expect(log).toContain("rerender:111:500");
  expect(log.some((l) => l.startsWith("answer:8"))).toBe(false);
  // A hit on the reply id is conclusive; the ambiguous fallback is not even consulted.
  expect(log.some((l) => l.startsWith("lookup:open"))).toBe(false);
});

test("a late reply to an ESCALATED prompt is still saved", async () => {
  // The 09:00 escalation is a nag, not a close. A buyer who answers yesterday's prompt at 09:05 --
  // precisely the behaviour the escalation is designed to provoke -- must still have it land.
  // This is why the reply path must NOT simply reuse the callback path's OPEN set.
  const { log, deps } = fakeDeps({
    loadPromptByReply: async () => prompt({ state: "escalated" }),
  });

  await handleUpdate(
    {
      update_id: 20,
      message: {
        message_id: 980,
        chat: { id: 111 },
        text: "sorry - paused it yesterday",
        reply_to_message: { message_id: 900 },
      },
    },
    deps,
  );

  expect(log).toContain("answer:7:sorry - paused it yesterday");
});

test("a reply correcting an already-CLOSED prompt is still saved", async () => {
  // The other half of the same rule, and the reason the fix for a re-answered prompt belongs in
  // Task 11's `saveAnswer` (which clears `notionCommentId` when the text changes) and NOT in a gate
  // here: `PromptRow` does not carry `notionCommentId`, so the dispatcher cannot see the fact that
  // decides whether a correction is safe. Refusing these would discard "actually, we paused it"
  // outright — the reply id is conclusive evidence that the buyer means THIS campaign.
  for (const state of ["answered", "no_changes"] as const) {
    const { log, deps } = fakeDeps({ loadPromptByReply: async () => prompt({ state }) });

    await handleUpdate(
      {
        update_id: 21,
        message: {
          message_id: 981,
          chat: { id: 111 },
          text: "correction: we paused it",
          reply_to_message: { message_id: 900 },
        },
      },
      deps,
    );

    expect(log).toContain("answer:7:correction: we paused it");
  }
});

test("a slash command from a bound chat is never written as an answer", async () => {
  // Telegram shows a START button whenever a chat is cleared, and a bound buyer with one prompt
  // awaiting a reply would otherwise get the literal text "/start" commented onto a client's card.
  const { log, deps } = fakeDeps({
    openPromptsForChat: async () => [prompt({ state: "awaiting_reply" })],
  });

  for (const text of ["/start", "/start@mc_bot", "/start deep-link", "/help"]) {
    await handleUpdate(
      { update_id: 17, message: { message_id: 971, chat: { id: 111 }, text } },
      deps,
    );
  }

  // Recorded four times and attributed zero times: no lookup, no write, no reply.
  expect(log).toEqual(["chat:111", "chat:111", "chat:111", "chat:111"]);
});

test("a plain message is attributed when exactly one prompt is awaiting a reply", async () => {
  const { log, deps } = fakeDeps({
    openPromptsForChat: async () => [prompt({ state: "awaiting_reply" })],
  });

  await handleUpdate(
    { update_id: 4, message: { message_id: 951, chat: { id: 111 }, text: "no news" } },
    deps,
  );

  expect(log).toContain("answer:7:no news");
  expect(log).toContain("rerender:111:500");
});

test("an ambiguous plain message asks which campaign instead of guessing", async () => {
  // Writing to the wrong page would put one client's update on another client's card.
  const { log, sent, deps } = fakeDeps({
    openPromptsForChat: async () => [
      prompt({ id: 7, state: "awaiting_reply" }),
      prompt({ id: 8, campaignTitle: "Lucky Rebel", state: "awaiting_reply" }),
    ],
  });

  await handleUpdate(
    { update_id: 5, message: { message_id: 952, chat: { id: 111 }, text: "all good" } },
    deps,
  );

  expect(log.some((l) => l.startsWith("answer:"))).toBe(false);
  expect(log.some((l) => l.startsWith("rerender:"))).toBe(false);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain("Which campaign");
  // Both candidates are named, otherwise the buyer cannot tell which two are open.
  expect(sent[0].text).toContain("Slots.lv");
  expect(sent[0].text).toContain("Lucky Rebel");
  // Not a force reply: the next typed message would be just as ambiguous.
  expect(sent[0].forceReply).toBe(false);

  // The instruction must be one the buyer can actually carry out. Every candidate in this branch is
  // `awaiting_reply` by construction, and renderList emits ✍️ Update only for `pending` — so the
  // list on the buyer's screen has NO Update button to tap. Cross-checked against the real renderer
  // rather than asserted from memory, so re-adding that button forces this copy to be re-read.
  const { keyboard } = renderList("Thu 13 Aug", [
    {
      promptId: 7,
      title: "Slots.lv",
      status: "Live",
      question: "Any changes today?",
      state: "awaiting_reply",
    },
    {
      promptId: 8,
      title: "Lucky Rebel",
      status: "Live",
      question: "Any changes today?",
      state: "awaiting_reply",
    },
  ]);
  expect(keyboard.flat().some((b) => b.text.includes("Update"))).toBe(false);
  expect(sent[0].text).not.toContain("Tap");
  // The escape that does work: reply to the campaign's own ✍️ message, which rule (1) resolves.
  expect(sent[0].text).toContain("Reply directly to the ✍️ Update message");
});

test("a plain message with nothing open is answered politely and stored nowhere", async () => {
  const { log, sent, deps } = fakeDeps({ openPromptsForChat: async () => [] });

  await handleUpdate(
    { update_id: 6, message: { message_id: 953, chat: { id: 111 }, text: "hello?" } },
    deps,
  );

  expect(log.some((l) => l.startsWith("answer:"))).toBe(false);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain("Nothing open");
  expect(sent[0].forceReply).toBe(false);
});

test("a plain message is not attributed to a prompt that was never opened with Update", async () => {
  // A `pending` prompt has no force-reply message in the chat, so a bare message cannot be an
  // answer to it — the buyer is talking about something else, or has not tapped yet.
  const { log, sent, deps } = fakeDeps({
    openPromptsForChat: async () => [prompt({ state: "pending" })],
  });

  await handleUpdate(
    { update_id: 12, message: { message_id: 960, chat: { id: 111 }, text: "bumped budget" } },
    deps,
  );

  expect(log.some((l) => l.startsWith("answer:"))).toBe(false);
  expect(sent[0].text).toContain("Nothing open");
});

test("/start from an unknown chat records it and returns the chat id, and leaks no campaign data", async () => {
  const { log, sent, chats, deps } = fakeDeps({ isBoundChat: async () => false });

  await handleUpdate(
    {
      update_id: 7,
      message: { message_id: 1, chat: { id: 777, username: "someone" }, text: "/start" },
    },
    deps,
  );
  // Telegram appends the bot name in groups and a deep-link payload after a space.
  await handleUpdate(
    {
      update_id: 71,
      message: { message_id: 2, chat: { id: 777, username: "someone" }, text: "/start@mc_bot" },
    },
    deps,
  );
  // A deep-link payload follows the command after a space.
  await handleUpdate(
    {
      update_id: 72,
      message: { message_id: 3, chat: { id: 777, username: "someone" }, text: "/start bind-me" },
    },
    deps,
  );
  // ...but `/startle` is a different command, not a greeting with a suffix.
  await handleUpdate(
    {
      update_id: 73,
      message: { message_id: 4, chat: { id: 777, username: "someone" }, text: "/startle" },
    },
    deps,
  );

  expect(log).toContain("chat:777");
  // The username is what lets an admin recognise the chat in Settings.
  expect(chats[0]).toEqual({ chatId: "777", username: "someone", firstName: undefined });
  expect(sent).toHaveLength(3);
  for (const m of sent) {
    expect(m.text).toContain("777");
    // An unbound chat is not a media buyer. It gets its own id and nothing else.
    expect(m.text).not.toContain("Slots.lv");
  }
  // The boundary that makes the leak impossible: no campaign data is read on this path at all.
  expect(log.some((l) => l.startsWith("lookup:"))).toBe(false);
  expect(log.some((l) => l.startsWith("answer:"))).toBe(false);
});

test("a message from an unbound chat that is not /start is ignored entirely", async () => {
  const { log, deps } = fakeDeps({ isBoundChat: async () => false });

  await handleUpdate(
    { update_id: 8, message: { message_id: 2, chat: { id: 777 }, text: "who are you" } },
    deps,
  );

  expect(log).toEqual(["chat:777"]);
});

test("a callback for an unknown or closed prompt is acknowledged without a state change", async () => {
  const unknown = fakeDeps({ loadPrompt: async () => null });

  await handleUpdate(
    { update_id: 9, callback_query: { id: "cb", data: "nc:404", from: { id: 111 } } },
    unknown.deps,
  );

  expect(unknown.log).toContain("ack:cb:That check-in is closed");
  expect(unknown.log.some((l) => l.startsWith("nochanges:"))).toBe(false);

  // Already closed: a second tap (or a tap after the answer landed) must not re-open or re-write it.
  for (const state of ["answered", "no_changes", "escalated"] as const) {
    const done = fakeDeps({ loadPrompt: async () => prompt({ state }) });

    await handleUpdate(
      { update_id: 91, callback_query: { id: "cb", data: "nc:7", from: { id: 111 } } },
      done.deps,
    );

    // The whole log: acknowledged, and not one write, send or re-render.
    expect(done.log).toEqual(["ack:cb:That check-in is closed"]);
  }
});

test("a callback with malformed data is acknowledged and dropped", async () => {
  const { log, deps } = fakeDeps();

  await handleUpdate(
    { update_id: 10, callback_query: { id: "cb", data: "garbage", from: { id: 111 } } },
    deps,
  );

  expect(log).toEqual(["ack:cb:Unrecognised action"]);

  // A callback query carrying no data at all (Telegram makes `data` optional) must not throw.
  const bare = fakeDeps();
  await handleUpdate(
    { update_id: 101, callback_query: { id: "cb2", from: { id: 111 } } },
    bare.deps,
  );
  expect(bare.log).toEqual(["ack:cb2:Unrecognised action"]);
});

test("a force-reply that failed to send records the reason and is never marked awaiting", async () => {
  // Marking awaiting_reply with no reply box in the chat would make the buyer's NEXT unrelated
  // message get attributed to this campaign by the single-awaiting rule. The prompt stays open and
  // escalates at 09:00, so `note` is the only place the cause survives — a revoked token and a
  // genuinely quiet day are otherwise indistinguishable.
  const failed = fakeDeps({
    sendMessage: async () => ({ ok: false, error: "403 bot was blocked by the user" }),
  });

  await handleUpdate(
    { update_id: 11, callback_query: { id: "cb", data: "up:7", from: { id: 111 } } },
    failed.deps,
  );

  expect(failed.log.some((l) => l.startsWith("awaiting:"))).toBe(false);
  expect(failed.log).toContain("ack:cb:Could not open the reply box");
  expect(failed.log).toContain("note:7:force reply failed: 403 bot was blocked by the user");

  // A failure with no reason still records that it failed, rather than writing "undefined".
  const bare = fakeDeps({ sendMessage: async () => ({ ok: false }) });
  await handleUpdate(
    { update_id: 112, callback_query: { id: "cb", data: "up:7", from: { id: 111 } } },
    bare.deps,
  );
  expect(bare.log).toContain("note:7:force reply failed: unknown error");

  // Sent, but Telegram's envelope carried no message_id: there is nothing to bind a reply to, so the
  // ack must not imply success either.
  const idless = fakeDeps({ sendMessage: async () => ({ ok: true }) });

  await handleUpdate(
    { update_id: 111, callback_query: { id: "cb", data: "up:7", from: { id: 111 } } },
    idless.deps,
  );

  expect(idless.log.some((l) => l.startsWith("awaiting:"))).toBe(false);
  expect(idless.log).toContain("note:7:force reply sent but Telegram returned no message_id");
  expect(idless.log).toContain("ack:cb:Could not open the reply box");
});

test("a callback on a prompt with no stored chat or list message uses the sender and skips the re-render", async () => {
  const { log, sent, deps } = fakeDeps({
    loadPrompt: async () => prompt({ chatId: null, listMessageId: null }),
  });

  await handleUpdate(
    { update_id: 14, callback_query: { id: "cb", data: "up:7", from: { id: 111 } } },
    deps,
  );

  expect(sent[0].chatId).toBe("111");
  expect(sent[0].forceReply).toBe(true);
  expect(log.some((l) => l.startsWith("rerender:"))).toBe(false);
});

test("a message with no usable text is recorded and otherwise ignored", async () => {
  // A sticker or a photo has no `text`, and an empty Notion comment is worse than none.
  const { log, deps } = fakeDeps({
    openPromptsForChat: async () => [prompt({ state: "awaiting_reply" })],
  });

  await handleUpdate({ update_id: 13, message: { message_id: 961, chat: { id: 111 } } }, deps);
  await handleUpdate(
    { update_id: 131, message: { message_id: 962, chat: { id: 111 }, text: "   \n " } },
    deps,
  );

  expect(log).toEqual(["chat:111", "chat:111"]);
});

test("an update that is neither a message nor a callback is ignored", async () => {
  // The poll loop forwards whatever Telegram sends, including edited_message and my_chat_member.
  const { log, deps } = fakeDeps();

  await handleUpdate({ update_id: 15 }, deps);

  expect(log).toEqual([]);
});
