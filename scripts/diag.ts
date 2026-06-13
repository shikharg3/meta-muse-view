// Throwaway diagnostic: why is act_1701082927919653 (bspin) missing from sync?
import { getCredentials } from "@/lib/credentials";
import { MetaClient } from "@/meta/client";
import { db, schema } from "@/db/client";
import { eq, sql } from "drizzle-orm";

const TARGET = "act_1701082927919653";
const BARE = "1701082927919653";

const c = await getCredentials();
if (!c) {
  console.log("NO CREDS");
  process.exit(0);
}
console.log("businessId:", JSON.stringify(c.businessId), "numeric:", /^\d+$/.test(c.businessId));
console.log(
  "accountIds.len:",
  c.accountIds.length,
  "hasActForm:",
  c.accountIds.includes(TARGET),
  "hasBare:",
  c.accountIds.includes(BARE),
);

const ver = c.apiVersion;
async function g(path: string, params: Record<string, string> = {}) {
  const u = new URL(`https://graph.facebook.com/${ver}/${path}`);
  u.searchParams.set("access_token", c!.token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  return { s: r.status, b: (await r.json()) as { data?: { id: string }[]; error?: unknown } };
}

const me = await g("me/adaccounts", { fields: "account_id", limit: "500" });
const meIds = (me.b.data || []).map((a) => a.id);
console.log("/me/adaccounts:", me.s, "count:", meIds.length, "hasTarget:", meIds.includes(TARGET));

const ow = await g(`${c.businessId}/owned_ad_accounts`, { fields: "account_id", limit: "500" });
const owIds = (ow.b.data || []).map((a) => a.id);
console.log("owned_ad_accounts:", ow.s, "count:", owIds.length, "hasTarget:", owIds.includes(TARGET), ow.b.error ? JSON.stringify(ow.b.error) : "");

const cl = await g(`${c.businessId}/client_ad_accounts`, { fields: "account_id", limit: "500" });
const clIds = (cl.b.data || []).map((a) => a.id);
console.log("client_ad_accounts:", cl.s, "count:", clIds.length, "hasTarget:", clIds.includes(TARGET), cl.b.error ? JSON.stringify(cl.b.error) : "");

const mc = new MetaClient({ appId: c.appId, appSecret: c.appSecret, token: c.token, version: ver });
const en = (await mc.getAccounts(c.businessId)).map((a) => String(a.id));
console.log("getAccounts():", "count:", en.length, "hasTarget:", en.includes(TARGET));

const ins = await g(`${TARGET}/insights`, { fields: "spend,impressions", date_preset: "last_7d" });
console.log("direct insights:", ins.s, JSON.stringify(ins.b).slice(0, 280));

const acct = await db.select().from(schema.accounts).where(eq(schema.accounts.id, TARGET));
console.log("in accounts table:", acct.length > 0, acct[0]?.name ?? "");
const idb = await db.execute(
  sql`select count(*)::int n, coalesce(sum(spend),0)::float spend from insights_daily where entity_id=${TARGET} and level='account' and date >= current_date - 7`,
);
console.log("insights_daily 7d:", JSON.stringify(idb));
process.exit(0);
