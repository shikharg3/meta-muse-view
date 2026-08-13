import { and, desc, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireAdmin, audit } from "./auth";
import { env } from "@/lib/env";
import type { CheckinStatus, PromptState } from "@/lib/checkin";

/** The chat-uniqueness index on `media_buyers.telegram_chat_id`. See `src/db/schema.ts`. */
const CHAT_INDEX = "media_buyers_chat_idx";

export interface CheckinAdminView {
  buyers: {
    personId: string;
    displayName: string;
    chatId: string | null;
    active: boolean;
    boundBy: string | null;
  }[];
  chats: { chatId: string; username: string | null; firstName: string | null }[];
  recentPrompts: {
    id: number;
    promptDate: string;
    campaignTitle: string;
    status: CheckinStatus;
    buyerPersonId: string;
    state: PromptState;
    note: string | null;
  }[];
  /**
   * Whether the bot can receive `/start` at all. Without a token no chat is ever discovered, and the
   * panel's "ask them to send /start" advice would be wrong rather than merely unfulfilled.
   */
  botConfigured: boolean;
}

/** Everything the Settings panel shows. Admin-only. */
export async function fetchCheckinAdmin(): Promise<CheckinAdminView> {
  await requireAdmin();
  const [buyers, chats, prompts] = await Promise.all([
    db.select().from(schema.mediaBuyers).orderBy(schema.mediaBuyers.displayName),
    db.select().from(schema.telegramChats).orderBy(desc(schema.telegramChats.lastSeenAt)),
    db
      .select()
      .from(schema.checkinPrompts)
      // `id` breaks the tie: one campaign owned by two buyers yields two rows with the same date and
      // title, and without it their order — and so the rendered list — changes between reloads.
      .orderBy(
        desc(schema.checkinPrompts.promptDate),
        schema.checkinPrompts.campaignTitle,
        schema.checkinPrompts.id,
      )
      .limit(50),
  ]);
  return {
    buyers: buyers.map((b) => ({
      personId: b.notionPersonId,
      displayName: b.displayName,
      chatId: b.telegramChatId,
      active: b.active,
      boundBy: b.boundBy,
    })),
    chats: chats.map((c) => ({ chatId: c.chatId, username: c.username, firstName: c.firstName })),
    recentPrompts: prompts.map((p) => ({
      id: p.id,
      promptDate: p.promptDate,
      campaignTitle: p.campaignTitle,
      status: p.status,
      buyerPersonId: p.buyerPersonId,
      state: p.state,
      note: p.note,
    })),
    botConfigured: Boolean(env().TELEGRAM_BOT_TOKEN),
  };
}

/**
 * True when `e` — or anything in its `cause` chain — is a Postgres unique violation (SQLSTATE 23505).
 *
 * The chain walk is the whole point: drizzle 0.45 wraps every driver failure in a `DrizzleQueryError`
 * (`pg-core/session.js`), so the `postgres` driver's `PostgresError`, the only object carrying `code`,
 * is never the caught error itself. Testing `e.code` directly would compile, always be `undefined`,
 * and let the raw driver error through to the UI.
 *
 * `depth` bounds the walk so a self-referential `cause` cannot hang the request.
 */
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; typeof cur === "object" && cur !== null && depth < 8; depth++) {
    const pg = cur as Record<string, unknown>;
    // A bare 23505 is enough — see `upsertMediaBuyer` — but prefer the precise match when Postgres
    // named the index, so an unrelated future constraint is not reported as a chat clash.
    if (
      pg.code === "23505" &&
      (pg.constraint_name === undefined || pg.constraint_name === CHAT_INDEX)
    ) {
      return true;
    }
    cur = pg.cause;
  }
  return false;
}

/**
 * Create or update a media buyer. The Notion person id is the key: display names drift, ids do not.
 * Passing an empty chatId unbinds them, which leaves their prompts recorded but unroutable.
 *
 * `active` is deliberately absent from the written values: re-binding a chat must not silently undo
 * a `setMediaBuyerActive(false)` soft delete. New rows still default to active per the schema.
 */
export async function upsertMediaBuyer(data: {
  personId: string;
  displayName: string;
  chatId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const personId = data.personId.trim();
  const displayName = data.displayName.trim();
  if (!personId) return { ok: false, error: "No Notion person id" };
  if (!displayName) return { ok: false, error: "No display name" };
  const chatId = data.chatId.trim() || null;

  const vals = {
    notionPersonId: personId,
    displayName,
    telegramChatId: chatId,
    boundBy: user.email,
    boundAt: new Date(),
  };
  try {
    await db
      .insert(schema.mediaBuyers)
      .values(vals)
      .onConflictDoUpdate({ target: schema.mediaBuyers.notionPersonId, set: vals });
  } catch (e) {
    // `media_buyers_chat_idx` is the only unique index this statement can violate — the primary key
    // is absorbed by ON CONFLICT — so a 23505 here always means the chat belongs to someone else.
    // Postgres does not raise it for a row conflicting with itself, hence "someone else" is exact.
    if (!chatId || !isUniqueViolation(e)) throw e;
    // Who holds it now. Excluding `personId` matters: without it a stale row for the same buyer
    // would be reported as "already bound to themselves".
    const [holder] = await db
      .select({ displayName: schema.mediaBuyers.displayName })
      .from(schema.mediaBuyers)
      .where(
        and(
          eq(schema.mediaBuyers.telegramChatId, chatId),
          ne(schema.mediaBuyers.notionPersonId, personId),
        ),
      )
      .limit(1);
    return {
      ok: false,
      error: holder
        ? `Chat ${chatId} is already bound to ${holder.displayName}. Unbind them first (set their Telegram chat to "— unbound —"), then bind ${displayName}.`
        : `Chat ${chatId} is already bound to another media buyer. Reload the panel and try again.`,
    };
  }
  await audit("checkin.buyer", `bound ${displayName} (${personId}) to chat ${chatId ?? "none"}`);
  return { ok: true };
}

/** Stop prompting a buyer without deleting their history. */
export async function setMediaBuyerActive(data: {
  personId: string;
  active: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  // `returning` distinguishes "toggled" from "matched nothing": without it a stale panel reports
  // success and the audit log grows an entry for a buyer that does not exist.
  const changed = await db
    .update(schema.mediaBuyers)
    .set({ active: data.active })
    .where(eq(schema.mediaBuyers.notionPersonId, data.personId))
    .returning({ personId: schema.mediaBuyers.notionPersonId });
  if (changed.length === 0) {
    return { ok: false, error: `No media buyer ${data.personId} — reload the panel.` };
  }
  await audit("checkin.buyer", `${data.active ? "activated" : "deactivated"} ${data.personId}`);
  return { ok: true };
}
