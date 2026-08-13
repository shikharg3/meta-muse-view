// Minimal Telegram Bot API client (no SDK; four methods, fetch is enough).
// Mirrors NotionClient: injectable fetchImpl for tests, and it NEVER throws — every failure comes
// back as data, because a check-in send failure must not take down the sync worker's loop.
const BASE = "https://api.telegram.org";

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramChat {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramChat;
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from: TelegramChat;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface SendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  /** Seconds Telegram asked us to wait, when it answered 429. */
  retryAfter?: number;
}

export interface UpdatesResult {
  ok: boolean;
  updates: TelegramUpdate[];
  error?: string;
  retryAfter?: number;
}

/** What `getChat` tells us about a target: enough to confirm an operator pasted the right id. */
export interface ChatInfo {
  ok: boolean;
  id?: number;
  /** Channels and groups carry a title; a private chat carries a name instead. */
  title?: string;
  type?: string;
  error?: string;
}

interface ApiEnvelope {
  ok?: boolean;
  description?: string;
  result?: unknown;
  parameters?: { retry_after?: number };
}

type CallResult = { ok: true; result: unknown } | { ok: false; error: string; retryAfter?: number };

/** `sendMessage` answers with the new Message; nothing else in the loop needs its other fields. */
function messageIdOf(result: unknown): number | undefined {
  if (result && typeof result === "object" && "message_id" in result) {
    const id = result.message_id;
    if (typeof id === "number") return id;
  }
  return undefined;
}

export class TelegramClient {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, payload: Record<string, unknown>): Promise<CallResult> {
    try {
      const res = await this.fetchImpl(`${BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Every field is optional, so a non-conforming body degrades to "request failed" rather than
      // to a lie about a shape we never checked. `?? {}` covers both an unparseable body (a proxy's
      // HTML 502) and a literal `null` payload, either of which would otherwise fault on `.ok`.
      const body = ((await res.json().catch(() => null)) ?? {}) as ApiEnvelope;
      // Success must be stated, not merely un-denied: a truncated long-poll body leaves HTTP 200
      // with nothing parseable, and treating that as a send that worked would record a prompt as
      // delivered with no message id and nothing to retry.
      if (!res.ok || body.ok !== true) {
        return {
          ok: false,
          error: `Telegram ${res.status}: ${body.description ?? "request failed"}`,
          retryAfter: body.parameters?.retry_after,
        };
      }
      return { ok: true, result: body.result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    keyboard?: InlineButton[][];
    forceReply?: boolean;
  }): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
      disable_web_page_preview: true,
    };
    // reply_markup holds one markup object: buttons and a forced reply cannot coexist.
    if (input.keyboard?.length) payload.reply_markup = { inline_keyboard: input.keyboard };
    else if (input.forceReply) payload.reply_markup = { force_reply: true, selective: true };

    const r = await this.call("sendMessage", payload);
    if (!r.ok) return { ok: false, error: r.error, retryAfter: r.retryAfter };
    return { ok: true, messageId: messageIdOf(r.result) };
  }

  /** Re-render an existing message. An empty keyboard removes the buttons. */
  async editMessageText(input: {
    chatId: string;
    messageId: number;
    text: string;
    keyboard: InlineButton[][];
  }): Promise<SendResult> {
    const r = await this.call("editMessageText", {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: input.keyboard },
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error, retryAfter: r.retryAfter };
  }

  /** Must be called on every callback or the buyer's client spins for ~30s. */
  async answerCallbackQuery(input: { id: string; text?: string }): Promise<SendResult> {
    const r = await this.call("answerCallbackQuery", {
      callback_query_id: input.id,
      ...(input.text ? { text: input.text } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error, retryAfter: r.retryAfter };
  }

  /** Long-poll. `offset` must be lastSeenUpdateId + 1, persisted across restarts. */
  async getUpdates(input: { offset: number | null; timeoutSec: number }): Promise<UpdatesResult> {
    const r = await this.call("getUpdates", {
      ...(input.offset != null ? { offset: input.offset } : {}),
      timeout: input.timeoutSec,
      allowed_updates: ["message", "callback_query"],
    });
    if (!r.ok) return { ok: false, updates: [], error: r.error, retryAfter: r.retryAfter };
    // Telegram guarantees an array here; individual update fields stay optional in TelegramUpdate,
    // so callers still have to check what they read.
    const updates = Array.isArray(r.result) ? (r.result as TelegramUpdate[]) : [];
    return { ok: true, updates };
  }

  /**
   * Resolve a chat id to its title and type, so Settings can confirm a pasted id is the intended
   * channel before alerts start going there.
   *
   * Deliberately NOT built on `getUpdates`. That endpoint is single-consumer and CONSUMING: the
   * check-in poller owns the update stream, and a second caller would confirm updates out from
   * under it and provoke 409s. `getChat` is an ordinary read and competes with nothing. It also
   * answers the question an operator actually has ("is this the right channel?") rather than
   * requiring one to guess which of several chats is meant.
   */
  async getChat(chatId: string): Promise<ChatInfo> {
    const r = await this.call("getChat", { chat_id: chatId });
    if (!r.ok) return { ok: false, error: r.error };
    const c = (r.result ?? {}) as { id?: unknown; title?: unknown; type?: unknown };
    return {
      ok: true,
      id: typeof c.id === "number" ? c.id : undefined,
      title: typeof c.title === "string" ? c.title : undefined,
      type: typeof c.type === "string" ? c.type : undefined,
    };
  }
}
