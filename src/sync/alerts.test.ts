import { test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { detectSpendDropAlerts } from "./alerts";

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
