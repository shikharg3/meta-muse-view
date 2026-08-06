import { test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import {
  detectSpendDropAlerts,
  detectAccountAlerts,
  classifyAccount,
  ALERT_LOW_FUNDS_USD,
  type AccountAlertRow,
} from "./alerts";

// Stub fetch so a detected alert never sends a real Telegram message during tests (Postgres uses a
// socket, not fetch, so this only intercepts the Telegram POST).
let realFetch: typeof fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
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
  await db.execute(sql`truncate table insights_daily, alerts, accounts cascade`);
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
