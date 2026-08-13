import { test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import {
  detectSpendDropAlerts,
  detectAccountAlerts,
  detectUnassignedSpendAlerts,
  scanUnassignedSpend,
  classifyAccount,
  sendAlertChannelMessage,
  ALERT_LOW_FUNDS_USD,
  type AccountAlertRow,
} from "./alerts";

// Stub fetch so a detected alert never sends a real Telegram message during tests (Postgres uses a
// socket, not fetch, so this only intercepts the Telegram POST).
//
// The envelope must STATE ok. `TelegramClient` requires `body.ok === true`, so the `{}` this used to
// return modelled a FAILED send, not a successful one — inert only on a machine with no
// TELEGRAM_BOT_TOKEN, where the unconfigured guard fires before any POST is attempted.
let realFetch: typeof fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"ok":true,"result":{"message_id":1}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const ymd = (off: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + off);
  return d.toISOString().slice(0, 10);
};

const acct = (id: string, name: string) =>
  db.insert(schema.accounts).values({ id, name, currency: "USD" });
const spend = (id: string, off: number, amt: number) =>
  db
    .insert(schema.insightsDaily)
    .values({ level: "account", entityId: id, date: ymd(off), accountId: id, spend: amt });

beforeEach(async () => {
  await db.execute(
    sql`truncate table insights_daily, alerts, accounts, clients, campaigns, campaign_client_overrides cascade`,
  );
});

/**
 * Runs `fn` with Telegram configured EXACTLY as given and every Telegram POST captured.
 *
 * `env()` memoises one object on first call and importing `@/db/client` above already forced that
 * call, so configuring Telegram means writing onto that same object rather than onto `process.env`.
 * Both keys are always written, never merged: the unconfigured cases must fail identically on a
 * developer machine whose `.env` does have a bot token.
 */
async function withTelegram(
  vars: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_ALERT_CHAT_ID?: string },
  reply: () => Response,
  fn: (calls: { url: string; body: Record<string, unknown> }[]) => Promise<void>,
): Promise<void> {
  const e = env();
  const prev = {
    TELEGRAM_BOT_TOKEN: e.TELEGRAM_BOT_TOKEN,
    TELEGRAM_ALERT_CHAT_ID: e.TELEGRAM_ALERT_CHAT_ID,
  };
  const outerFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  Object.assign(e, { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_ALERT_CHAT_ID: undefined }, vars);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return reply();
  }) as unknown as typeof fetch;
  try {
    await fn(calls);
  } finally {
    Object.assign(e, prev);
    globalThis.fetch = outerFetch;
  }
}

const okReply = () =>
  new Response('{"ok":true,"result":{"message_id":7}}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("an unconfigured Telegram is reported verbatim and nothing is attempted", async () => {
  // The 09:00 escalation is the ONLY thing that surfaces an unanswered check-in, so a send that
  // silently does nothing means nobody ever learns. This exact string is what the Settings panel
  // shows an admin, so it is the contract, not a log line.
  const unconfigured = "Telegram not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID.";
  // Each half alone is still unconfigured: a token with nowhere to send it is as useless as neither.
  for (const vars of [{}, { TELEGRAM_BOT_TOKEN: "tok" }, { TELEGRAM_ALERT_CHAT_ID: "-1001" }]) {
    await withTelegram(vars, okReply, async (calls) => {
      expect(
        await sendAlertChannelMessage("⚠️ Check-in 2026-08-12 — 2 campaigns unanswered"),
      ).toStrictEqual({ ok: false, error: unconfigured });
      // The guard must REPLACE the request, not merely precede a real one.
      expect(calls).toHaveLength(0);
    });
  }
});

test("a delivered message reports ok and carries the configured chat id and the text", async () => {
  await withTelegram(
    { TELEGRAM_BOT_TOKEN: "bot-tok", TELEGRAM_ALERT_CHAT_ID: "-1001" },
    okReply,
    async (calls) => {
      // toStrictEqual, not toEqual: a stray `error: undefined` on the success arm would slip past
      // toEqual, and this shape is what Settings renders.
      expect(
        await sendAlertChannelMessage("⚠️ Check-in 2026-08-12 — 2 campaigns unanswered"),
      ).toStrictEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.telegram.org/botbot-tok/sendMessage");
      expect(calls[0].body.chat_id).toBe("-1001");
      expect(calls[0].body.text).toBe("⚠️ Check-in 2026-08-12 — 2 campaigns unanswered");
    },
  );
});

test("a failed send comes back as data and never throws — every caller is a loop", async () => {
  const configured = { TELEGRAM_BOT_TOKEN: "bot-tok", TELEGRAM_ALERT_CHAT_ID: "-1001" };
  const cases: [string, () => Response, string][] = [
    [
      "a rejection carries Telegram's own reason",
      () => new Response('{"ok":false,"description":"chat not found"}', { status: 400 }),
      "Telegram 400: chat not found",
    ],
    [
      // Exactly what this file's own fetch stub used to return. A 200 that does not STATE ok is a
      // failure, which is why that stub had to change.
      "a 200 that does not state ok is still a failure",
      () => new Response("{}", { status: 200 }),
      "Telegram 200: request failed",
    ],
    [
      "a dropped socket surfaces as the transport error",
      () => {
        throw new Error("socket hang up");
      },
      "socket hang up",
    ],
  ];
  for (const [, reply, error] of cases) {
    await withTelegram(configured, reply, async () => {
      expect(await sendAlertChannelMessage("x")).toStrictEqual({ ok: false, error });
    });
  }
});

test("flags a real collapse on the latest complete day, ignoring today's incompleteness", async () => {
  await acct("act_active", "Active");
  await acct("act_banned", "Banned");
  // Active: $500/day through yesterday; today (incomplete) is $0 and must be IGNORED.
  for (let o = -8; o <= -1; o++) await spend("act_active", o, 500);
  await spend("act_active", 0, 0);
  // Banned: $500/day until 2 days ago, then $0 on the latest complete day (yesterday).
  for (let o = -8; o <= -2; o++) await spend("act_banned", o, 500);
  await spend("act_banned", -1, 0);

  await detectSpendDropAlerts();
  const flagged = (await db.select().from(schema.alerts)).map((r) => r.accountId).sort();
  expect(flagged).toEqual(["act_banned"]); // active is NOT flagged despite today being $0
}, 20000);

test("does not re-alert an account already flagged within the last 7 days", async () => {
  await acct("act_banned", "Banned");
  for (let o = -8; o <= -2; o++) await spend("act_banned", o, 500);
  await spend("act_banned", -1, 0);
  expect(await detectSpendDropAlerts()).toBe(1);
  expect(await detectSpendDropAlerts()).toBe(0); // suppressed on the immediate re-run
}, 20000);

const YDAY = "2026-08-05";
const row = (over: Partial<AccountAlertRow> = {}): AccountAlertRow => ({
  id: "act_1",
  name: "DOT-GO-1",
  client: "wildcasino.ag",
  status: "1",
  spendCap: 500000, // $5,000 cap
  amountSpent: 100000, // $1,000 spent → $4,000 remaining
  spend7d: 2000,
  spendYesterday: 400,
  ...over,
});
const kinds = (r: AccountAlertRow) => classifyAccount(r, YDAY).map((a) => a.kind);

test("a healthy spending account warrants no alert", () => {
  expect(kinds(row())).toEqual([]);
});

test("a disabled account alerts once and suppresses the other two", () => {
  // Meta's disabled codes. A disabled account is also not spending and may be out of funds; firing
  // three alerts for one cause is how people learn to ignore alerts.
  for (const status of ["2", "100", "101"]) {
    const alerts = classifyAccount(row({ status, spendYesterday: 0, amountSpent: 499999 }), YDAY);
    expect(alerts.map((a) => a.kind)).toEqual(["account_disabled"]);
    expect(alerts[0].message).toBe("wildcasino.ag - DOT-GO-1 - act_1");
    expect(alerts[0].dedupe).toBe("account_disabled:act_1"); // no date: one per disable episode
    expect(alerts[0].severity).toBe("critical");
  }
});

test("pending/unsettled accounts are not actionable and alert nothing", () => {
  expect(kinds(row({ status: "7", spendYesterday: 0 }))).toEqual([]);
});

test("low funds fires at the threshold, keyed by cap so a top-up re-arms it", () => {
  const nearly = row({ amountSpent: 500000 - ALERT_LOW_FUNDS_USD * 100 }); // exactly $100 left
  const [alert] = classifyAccount(nearly, YDAY);
  expect(alert.kind).toBe("low_funds");
  expect(alert.message).toBe("wildcasino.ag - DOT-GO-1 - act_1 - $100.00 remaining");
  expect(alert.dedupe).toBe("low_funds:act_1:500000");
  // A dollar more headroom is not yet an alert.
  expect(kinds(row({ amountSpent: 500000 - (ALERT_LOW_FUNDS_USD + 1) * 100 }))).toEqual([]);
  // Topping up moves the cap, so the key changes and the next drain alerts again.
  const toppedUp = row({ spendCap: 900000, amountSpent: 900000 - 5000 });
  expect(classifyAccount(toppedUp, YDAY)[0].dedupe).toBe("low_funds:act_1:900000");
});

test("an exhausted account reports low funds but NOT no-spend — the cause is already explained", () => {
  expect(kinds(row({ amountSpent: 500000, spendYesterday: 0 }))).toEqual(["low_funds"]);
});

test("a funded, active account that stopped spending is the unexplained stoppage", () => {
  const [alert] = classifyAccount(row({ spendYesterday: 0 }), YDAY);
  expect(alert.kind).toBe("no_spend");
  expect(alert.message).toBe("wildcasino.ag - DOT-GO-1 - act_1 - No spend alert");
  expect(alert.dedupe).toBe(`no_spend:act_1:${YDAY}`);
});

test("uncapped accounts can still raise no-spend but never low-funds", () => {
  for (const spendCap of [null, 0]) {
    expect(kinds(row({ spendCap, spendYesterday: 0 }))).toEqual(["no_spend"]);
  }
});

test("dormant accounts are silent — every alert requires recent use", () => {
  // The scoping that keeps these usable: unscoped, "no spend yesterday" fires for dozens of
  // long-idle rented accounts every single day.
  const dormant = row({ spend7d: 0, spendYesterday: 0, amountSpent: 500000 });
  expect(kinds(dormant)).toEqual([]);
});

test("account alerts are scoped to accounts mapped to a current client", async () => {
  await acct("act_orphan", "Unmapped");
  await db
    .update(schema.accounts)
    .set({ status: "2" })
    .where(sql`id = 'act_orphan'`);
  await spend("act_orphan", -1, 500);
  const counts = await detectAccountAlerts();
  expect(counts.account_disabled).toBe(0); // no client owns it, so nobody is paged
  expect(await db.select().from(schema.alerts)).toHaveLength(0);
}, 20000);

/** A shared account contested by two clients, with one campaign neither can claim by name. */
const contested = async () => {
  await acct("act_shared", "Shared BM");
  await db.insert(schema.clients).values([
    { id: "alpha", name: "Alpha", notionAccountIds: ["act_shared"] },
    { id: "beta", name: "Beta", notionAccountIds: ["act_shared"] },
  ]);
  await db.insert(schema.campaigns).values([
    { id: "c_alpha", accountId: "act_shared", name: "Alpha Prospecting", status: "ACTIVE" },
    { id: "c_ghost", accountId: "act_shared", name: "TOF - Broad", status: "ACTIVE" },
  ]);
  const camp = (id: string, off: number, amt: number) =>
    db.insert(schema.insightsDaily).values({
      level: "campaign",
      entityId: id,
      date: ymd(off),
      accountId: "act_shared",
      spend: amt,
    });
  await camp("c_alpha", -2, 300);
  await camp("c_ghost", -2, 250);
};

test("alerts on contested spend no rule can assign, and names both candidates", async () => {
  await contested();
  const found = await scanUnassignedSpend();
  expect(found.map((f) => f.campaign)).toEqual(["TOF - Broad"]); // Alpha Prospecting attributes by name
  expect(found[0].claimants).toEqual([
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ]);
  expect(found[0].spend).toBeCloseTo(250, 2);

  expect(await detectUnassignedSpendAlerts({ silent: true })).toBe(1);
  const rows = await db.select().from(schema.alerts);
  expect(rows).toHaveLength(1);
  expect(rows[0].type).toBe("unassigned_spend");
  expect(rows[0].message).toContain("TOF - Broad");
  expect(rows[0].message).toContain("Alpha and Beta"); // the operator must know who to choose between
}, 30000);

test("the same backlog alerts once, not once per cycle", async () => {
  await contested();
  expect(await detectUnassignedSpendAlerts({ silent: true })).toBe(1);
  expect(await detectUnassignedSpendAlerts({ silent: true })).toBe(0);
  expect(await db.select().from(schema.alerts)).toHaveLength(1);
}, 30000);

test("assigning the campaign clears its alert without a resolve step", async () => {
  await contested();
  await detectUnassignedSpendAlerts({ silent: true });
  await db
    .insert(schema.campaignClientOverrides)
    .values({ campaignId: "c_ghost", clientId: "beta" });

  expect(await detectUnassignedSpendAlerts({ silent: true })).toBe(0);
  expect(await db.select().from(schema.alerts)).toHaveLength(0);
  expect(await scanUnassignedSpend()).toEqual([]);
}, 30000);

test("an uncontested account is a mapping gap, not an attribution one, and stays silent", async () => {
  await acct("act_solo", "Solo");
  await db
    .insert(schema.clients)
    .values({ id: "solo", name: "Solo", notionAccountIds: ["act_solo"] });
  await db
    .insert(schema.campaigns)
    .values({ id: "c_x", accountId: "act_solo", name: "Nothing Matches This", status: "ACTIVE" });
  await db.insert(schema.insightsDaily).values({
    level: "campaign",
    entityId: "c_x",
    date: ymd(-2),
    accountId: "act_solo",
    spend: 900,
  });

  expect(await scanUnassignedSpend()).toEqual([]);
  expect(await detectUnassignedSpendAlerts({ silent: true })).toBe(0);
}, 30000);

test("dust below the threshold never alerts", async () => {
  await contested();
  await db.execute(sql`update insights_daily set spend = 0.4 where entity_id = 'c_ghost'`);
  expect(await scanUnassignedSpend()).toEqual([]);
}, 30000);
