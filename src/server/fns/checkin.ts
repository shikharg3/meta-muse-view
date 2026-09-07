import { and, desc, eq, gte, ne } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireAdmin, audit } from "./auth";
import { env } from "@/lib/env";
import { berlinNow } from "@/lib/berlin-time";
import { getServiceHealth } from "@/sync/state";
import type { CheckinStatus, PromptState } from "@/lib/checkin";

/** The chat-uniqueness index on `media_buyers.telegram_chat_id`. See `src/db/schema.ts`. */
const CHAT_INDEX = "media_buyers_chat_idx";

/** The `service_health` key the check-in worker writes under. */
const CHECKIN_SERVICE = "checkin";

/**
 * Caps on the two unbounded reads.
 *
 * `telegram_chats` grows without limit and never shrinks: `recordChat` runs before the bound-chat
 * gate, so every stranger who ever messages the bot leaves a permanent row, and there is no pruning
 * path. Shipping the whole table to the browser as `<option>` elements would degrade forever. Newest
 * first, so the buyer who just sent `/start` is always in range; a bound chat that has aged out is
 * still selectable because the panel re-adds it explicitly.
 */
const CHAT_LIMIT = 50;
const CHAT_STALE_DAYS = 90;
const PROMPT_LIMIT = 50;

/** Notion person ids are UUIDs. Anything else can never match an `Owners` entry. */
const PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
   * Today's `checkin_runs` row, resolved on the Berlin clock the job itself keys on — never the
   * browser's. `planned: false` means no row exists, which is the only way to tell "the 13:30 job
   * never ran" from "it ran and nothing was in scope"; `promptsCreated: 0` with `planned: true` is
   * the second of those. `hour` + `minute` let the panel say whether 13:30 has even passed yet — the
   * minute is not decoration, the first mark is half past.
   */
  today: {
    date: string;
    hour: number;
    minute: number;
    planned: boolean;
    plannedAt: string | null;
    promptsCreated: number;
    remindedAt: string | null;
    /** The buyer's final-notice DM (08:00). `escalatedAt` is the channel post an hour after it. */
    finalNoticedAt: string | null;
    escalatedAt: string | null;
  };
  /**
   * The `checkin` row of `service_health`. Nothing else in `src` reads it, so without this the three
   * failure modes the worker distinguishes — every send failed, a whole plan unroutable, a genuinely
   * quiet day — are invisible here. `flushPendingComments` writes the same singleton later in the
   * loop, so a comment failure outranks a send failure in the badge; that is deliberate (a failed
   * send retries until midnight, a failed comment can lose a buyer's typed answer). The note says
   * which it was, so the panel renders the note rather than guessing.
   */
  health: { ok: boolean; checkedAt: string | null; note: string | null } | null;
  /**
   * Whether the bot can receive `/start` at all. Without a token no chat is ever discovered, and the
   * panel's "ask them to send /start" advice would be wrong rather than merely unfulfilled.
   */
  botConfigured: boolean;
}

/** Everything the Settings panel shows. Admin-only. */
export async function fetchCheckinAdmin(): Promise<CheckinAdminView> {
  try {
    await requireAdmin();
    const now = berlinNow(new Date());
    const chatCutoff = new Date(Date.now() - CHAT_STALE_DAYS * 24 * 60 * 60 * 1000);
    const [buyers, chats, prompts, runs, health] = await Promise.all([
      db.select().from(schema.mediaBuyers).orderBy(schema.mediaBuyers.displayName),
      db
        .select()
        .from(schema.telegramChats)
        .where(gte(schema.telegramChats.lastSeenAt, chatCutoff))
        .orderBy(desc(schema.telegramChats.lastSeenAt))
        .limit(CHAT_LIMIT),
      db
        .select()
        .from(schema.checkinPrompts)
        // `id` breaks the tie: one campaign owned by two buyers yields two rows with the same date
        // and title, and without it their order — and so the rendered list — changes between reloads.
        .orderBy(
          desc(schema.checkinPrompts.promptDate),
          schema.checkinPrompts.campaignTitle,
          schema.checkinPrompts.id,
        )
        .limit(PROMPT_LIMIT),
      db.select().from(schema.checkinRuns).where(eq(schema.checkinRuns.runDate, now.date)).limit(1),
      getServiceHealth(CHECKIN_SERVICE),
    ]);
    const run = runs[0];
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
      today: {
        date: now.date,
        hour: now.hour,
        minute: now.minute,
        planned: run !== undefined,
        plannedAt: run?.plannedAt?.toISOString() ?? null,
        promptsCreated: run?.promptsCreated ?? 0,
        remindedAt: run?.remindedAt?.toISOString() ?? null,
        finalNoticedAt: run?.finalNoticedAt?.toISOString() ?? null,
        escalatedAt: run?.escalatedAt?.toISOString() ?? null,
      },
      health,
      botConfigured: Boolean(env().TELEGRAM_BOT_TOKEN),
    };
  } catch (e) {
    throw new Error(flattenError(e), { cause: e });
  }
}

/**
 * Collapse an error and everything it wraps into one sentence, root cause first.
 *
 * `DrizzleQueryError.message` is the failed SQL and nothing else — the reason (`relation
 * "media_buyers" does not exist`, `connect ECONNREFUSED`) lives only on `.cause`. A caller that
 * reports `e.message` therefore shows an admin the query but never why it failed, so 42P01 (apply
 * the DDL) reads identically to ECONNREFUSED (restart the tunnel) despite the opposite remedies.
 *
 * This runs on the server on purpose: errors cross the server-fn boundary through seroval and
 * `.cause` is not guaranteed to survive it, so the reason has to be in the message before it leaves.
 */
function flattenError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; typeof cur === "object" && cur !== null && depth < 8; depth++) {
    const err = cur as Record<string, unknown>;
    const code = typeof err.code === "string" ? ` [${err.code}]` : "";
    const text = (typeof err.message === "string" ? err.message : "").slice(0, 200).trim() + code;
    if (text && !parts.includes(text)) parts.unshift(text);
    cur = err.cause;
  }
  return parts.join(" — while running: ") || String(e);
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
  try {
    const user = await requireAdmin();
    // Lowercased because the id is matched against Notion's `Owners` payload verbatim. Notion emits
    // lowercase UUIDs, so an admin who pastes an uppercase one would otherwise store a row that
    // looks bound, active and healthy in this panel and is silently never prompted.
    const personId = data.personId.trim().toLowerCase();
    const displayName = data.displayName.trim();
    if (!personId) return { ok: false, error: "No Notion person id" };
    if (!PERSON_ID.test(personId)) {
      return {
        ok: false,
        error: `"${personId}" is not a Notion person id — expected a UUID like 254d872b-594c-8154-9479-000271904e5b. Copy it from the board's Owners property, not the person's name.`,
      };
    }
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
      // would be reported as "already bound to themselves". A failure here costs only the name —
      // the actionable half of the message is already known — so it must not mask the real answer.
      const holder = await db
        .select({ displayName: schema.mediaBuyers.displayName })
        .from(schema.mediaBuyers)
        .where(
          and(
            eq(schema.mediaBuyers.telegramChatId, chatId),
            ne(schema.mediaBuyers.notionPersonId, personId),
          ),
        )
        .limit(1)
        .catch(() => []);
      return {
        ok: false,
        error: holder[0]
          ? `Chat ${chatId} is already bound to ${holder[0].displayName}. Unbind them first (set their Telegram chat to "— unbound —"), then bind ${displayName}.`
          : `Chat ${chatId} is already bound to another media buyer. Reload the panel and try again.`,
      };
    }
    await audit("checkin.buyer", `bound ${displayName} (${personId}) to chat ${chatId ?? "none"}`);
    return { ok: true };
  } catch (e) {
    throw new Error(flattenError(e), { cause: e });
  }
}

/** Stop prompting a buyer without deleting their history. */
export async function setMediaBuyerActive(data: {
  personId: string;
  active: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  try {
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
  } catch (e) {
    throw new Error(flattenError(e), { cause: e });
  }
}
