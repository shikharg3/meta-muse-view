import { test, expect } from "bun:test";
import { TelegramClient } from "./client";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stand-in that records calls and replays queued responses. */
function recorder(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses[calls.length - 1] ?? { body: { ok: true, result: {} } };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("sendMessage posts the text and returns the new message id", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: { message_id: 42 } } }]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.sendMessage({ chatId: "111", text: "hello" });

  expect(res).toEqual({ ok: true, messageId: 42 });
  expect(calls[0].url).toBe("https://api.telegram.org/botTOK/sendMessage");
  // A body-carrying GET is rejected outright by real fetch, and Telegram ignores a payload it was
  // not told to read as JSON.
  expect(calls[0].method).toBe("POST");
  expect(calls[0].headers["content-type"]).toBe("application/json");
  expect(calls[0].body).toEqual({
    chat_id: "111",
    text: "hello",
    disable_web_page_preview: true,
  });
});

test("sendMessage ignores a non-numeric message_id", async () => {
  const { impl } = recorder([{ body: { ok: true, result: { message_id: "42" } } }]);
  const tg = new TelegramClient("TOK", impl);

  // Task 9 persists this as list_message_id and Task 10 matches it against a numeric
  // reply_to_message.message_id, so a string here must not be passed through.
  expect(await tg.sendMessage({ chatId: "111", text: "hi" })).toEqual({ ok: true });
});

test("sendMessage attaches an inline keyboard when given one", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: { message_id: 1 } } }]);
  const tg = new TelegramClient("TOK", impl);

  await tg.sendMessage({
    chatId: "111",
    text: "list",
    keyboard: [[{ text: "✅", callback_data: "nc:1" }]],
  });

  expect(calls[0].body).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "✅", callback_data: "nc:1" }]] },
  });
});

test("sendMessage can request a forced reply", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: { message_id: 5 } } }]);
  const tg = new TelegramClient("TOK", impl);

  await tg.sendMessage({ chatId: "111", text: "update?", forceReply: true });

  expect(calls[0].body).toMatchObject({ reply_markup: { force_reply: true, selective: true } });
});

// reply_markup holds ONE markup object, so the two options are mutually exclusive.
test("a keyboard wins over forceReply when both are passed", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: { message_id: 6 } } }]);
  const tg = new TelegramClient("TOK", impl);

  await tg.sendMessage({
    chatId: "111",
    text: "both",
    keyboard: [[{ text: "✅", callback_data: "nc:1" }]],
    forceReply: true,
  });

  expect(calls[0].body).toEqual({
    chat_id: "111",
    text: "both",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "✅", callback_data: "nc:1" }]] },
  });
});

// A prompt renders zero buttons for a status whose only answer is typed: still force the reply.
test("an empty keyboard falls back to forceReply", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: { message_id: 7 } } }]);
  const tg = new TelegramClient("TOK", impl);

  await tg.sendMessage({ chatId: "111", text: "typed only", keyboard: [], forceReply: true });

  expect(calls[0].body).toMatchObject({ reply_markup: { force_reply: true, selective: true } });
});

test("sendMessage reports ok with no messageId when the result carries none", async () => {
  const { impl } = recorder([{ body: { ok: true, result: {} } }]);
  const tg = new TelegramClient("TOK", impl);

  expect(await tg.sendMessage({ chatId: "111", text: "hi" })).toEqual({ ok: true });
});

test("an API error is returned, never thrown", async () => {
  const { impl } = recorder([{ status: 400, body: { ok: false, description: "chat not found" } }]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.sendMessage({ chatId: "999", text: "hi" });

  expect(res.ok).toBe(false);
  expect(res.error).toContain("chat not found");
});

// Telegram can answer HTTP 200 with a failing envelope; that is still a failure.
test("an ok:false envelope on a 200 is an error", async () => {
  const { impl } = recorder([
    { status: 200, body: { ok: false, description: "message is empty" } },
  ]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.sendMessage({ chatId: "111", text: "" });

  expect(res.ok).toBe(false);
  expect(res.error).toContain("message is empty");
});

test("a rate limit surfaces retryAfter so the caller can back off", async () => {
  const { impl } = recorder([
    {
      status: 429,
      body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } },
    },
  ]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.sendMessage({ chatId: "111", text: "hi" });

  expect(res.ok).toBe(false);
  expect(res.retryAfter).toBe(7);
});

test("a network failure is returned, never thrown", async () => {
  const impl = (async () => {
    throw new Error("socket hang up");
  }) as unknown as typeof fetch;
  const tg = new TelegramClient("TOK", impl);

  expect(await tg.sendMessage({ chatId: "1", text: "x" })).toEqual({
    ok: false,
    error: "socket hang up",
  });
});

// A rejection is not guaranteed to be an Error; stringifying it must not itself become the failure.
test("a non-Error rejection is stringified, never thrown", async () => {
  const impl = (async () => {
    throw "ECONNRESET";
  }) as unknown as typeof fetch;
  const tg = new TelegramClient("TOK", impl);

  expect(await tg.sendMessage({ chatId: "1", text: "x" })).toEqual({
    ok: false,
    error: "ECONNRESET",
  });
});

// A proxy 502 serves HTML: json() rejects, and that must not escape either.
test("an unparseable body is returned as an error, never thrown", async () => {
  const impl = (async () =>
    new Response("<html>bad gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.sendMessage({ chatId: "1", text: "x" });

  expect(res.ok).toBe(false);
  expect(res.error).toBe("Telegram 502: request failed");
});

// A JSON `null` body parses fine but has no `.ok` to read; reading it blind would fault.
test("a null JSON body is returned as an error, never thrown", async () => {
  const { impl } = recorder([{ status: 500, body: null }]);
  const tg = new TelegramClient("TOK", impl);

  expect(await tg.sendMessage({ chatId: "1", text: "x" })).toEqual({
    ok: false,
    error: "Telegram 500: request failed",
  });
});

// The realistic one: a truncated or aborted body on the 30s long-poll leaves res.status at 200
// while json() rejects. Success must be stated by the envelope, not assumed from the status, or
// Task 9 records a prompt as sent with no list_message_id and nothing ever retries it.
test("an unparseable body on a 200 is a failure, not a silent success", async () => {
  const impl = (async () =>
    new Response('{"ok":true,"resu', {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const tg = new TelegramClient("TOK", impl);

  expect(await tg.sendMessage({ chatId: "1", text: "x" })).toEqual({
    ok: false,
    error: "Telegram 200: request failed",
  });
});

// And the converse: the HTTP status is authoritative, so a gateway serving a stale ok:true body
// under a 5xx is still a failure.
test("a failing status wins over a body claiming ok", async () => {
  const { impl } = recorder([{ status: 503, body: { ok: true, result: { message_id: 9 } } }]);
  const tg = new TelegramClient("TOK", impl);

  expect(await tg.sendMessage({ chatId: "1", text: "x" })).toEqual({
    ok: false,
    error: "Telegram 503: request failed",
  });
});

test("getUpdates passes the offset and long-poll timeout and returns updates", async () => {
  const { calls, impl } = recorder([
    {
      body: {
        ok: true,
        result: [{ update_id: 10, message: { message_id: 1, chat: { id: 111 }, text: "hi" } }],
      },
    },
  ]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.getUpdates({ offset: 9, timeoutSec: 30 });

  expect(calls[0].url).toBe("https://api.telegram.org/botTOK/getUpdates");
  expect(calls[0].body).toEqual({
    offset: 9,
    timeout: 30,
    allowed_updates: ["message", "callback_query"],
  });
  expect(res.ok).toBe(true);
  expect(res.updates).toHaveLength(1);
  expect(res.updates[0].update_id).toBe(10);
});

// First poll ever: no stored offset, so the parameter must be absent (sending null resets nothing
// and sending 0 is not the same as omitting it).
test("getUpdates omits the offset when there is none yet", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: [] } }]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.getUpdates({ offset: null, timeoutSec: 25 });

  expect(calls[0].body).toEqual({ timeout: 25, allowed_updates: ["message", "callback_query"] });
  expect(res.updates).toEqual([]);
});

// The caller iterates `updates` directly, so a malformed success envelope must not hand it a
// non-array to loop over: an object throws "not iterable" one frame up and a string quietly
// iterates into characters — both defeat the never-throw guarantee at the caller.
test("getUpdates yields an empty list when the result is not a list", async () => {
  const { impl } = recorder([
    { body: { ok: true, result: { not: "a list" } } },
    { body: { ok: true, result: "nope" } },
    { body: { ok: true, result: null } },
  ]);
  const tg = new TelegramClient("TOK", impl);

  for (let i = 0; i < 3; i++) {
    expect(await tg.getUpdates({ offset: 1, timeoutSec: 30 })).toEqual({ ok: true, updates: [] });
  }
});

// The polling loop destructures `updates` on every tick, so it must be an array even on failure.
test("a failed getUpdates yields an empty update list and the backoff hint", async () => {
  const { impl } = recorder([
    { status: 429, body: { ok: false, description: "flood", parameters: { retry_after: 3 } } },
  ]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.getUpdates({ offset: 1, timeoutSec: 30 });

  expect(res).toEqual({ ok: false, updates: [], error: "Telegram 429: flood", retryAfter: 3 });
});

test("editMessageText and answerCallbackQuery hit the right endpoints", async () => {
  const { calls, impl } = recorder([
    { body: { ok: true, result: {} } },
    { body: { ok: true, result: true } },
  ]);
  const tg = new TelegramClient("TOK", impl);

  await tg.editMessageText({ chatId: "111", messageId: 42, text: "updated", keyboard: [] });
  await tg.answerCallbackQuery({ id: "cb1", text: "Logged" });

  expect(calls[0].url).toContain("/editMessageText");
  expect(calls[0].body).toMatchObject({ chat_id: "111", message_id: 42, text: "updated" });
  expect(calls[1].url).toContain("/answerCallbackQuery");
  expect(calls[1].body).toMatchObject({ callback_query_id: "cb1", text: "Logged" });
});

// This is how a closed campaign loses its buttons: an edit carrying an empty keyboard.
test("editMessageText sends an empty inline keyboard to strip the buttons", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: {} } }]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.editMessageText({
    chatId: "111",
    messageId: 42,
    text: "done",
    keyboard: [],
  });

  expect(res).toEqual({ ok: true });
  expect(calls[0].body).toEqual({
    chat_id: "111",
    message_id: 42,
    text: "done",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] },
  });
});

test("a failed editMessageText comes back as data", async () => {
  const { impl } = recorder([
    { status: 400, body: { ok: false, description: "message is not modified" } },
  ]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.editMessageText({ chatId: "1", messageId: 2, text: "x", keyboard: [] });

  expect(res).toEqual({ ok: false, error: "Telegram 400: message is not modified" });
});

// A bare acknowledgement shows no toast, so `text` is omitted rather than sent empty.
test("answerCallbackQuery omits text when none is given", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: true } }]);
  const tg = new TelegramClient("TOK", impl);

  expect(await tg.answerCallbackQuery({ id: "cb2" })).toEqual({ ok: true });
  expect(calls[0].body).toEqual({ callback_query_id: "cb2" });
});

test("a failed answerCallbackQuery comes back as data with its backoff hint", async () => {
  const { impl } = recorder([
    { status: 429, body: { ok: false, description: "flood", parameters: { retry_after: 2 } } },
  ]);
  const tg = new TelegramClient("TOK", impl);

  expect(await tg.answerCallbackQuery({ id: "cb3" })).toEqual({
    ok: false,
    error: "Telegram 429: flood",
    retryAfter: 2,
  });
});
