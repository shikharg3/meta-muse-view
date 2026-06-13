// Verify the fix: run structure + insights for the previously-failing account.
import { getCredentials } from "@/lib/credentials";
import { MetaClient } from "@/meta/client";
import { syncStructure } from "@/sync/jobs/structure";
import { syncInsights } from "@/sync/jobs/insights";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";

const TARGET = "act_1701082927919653";
const c = await getCredentials();
if (!c) {
  console.log("NO CREDS");
  process.exit(0);
}
const client = new MetaClient({ appId: c.appId, appSecret: c.appSecret, token: c.token, version: c.apiVersion });

try {
  await syncStructure(client, TARGET);
  console.log("structure: OK");
} catch (e) {
  console.log("structure FAILED:", e instanceof Error ? e.message : String(e));
}
for (const level of ["account", "ad"] as const) {
  try {
    const n = await syncInsights(client, TARGET, { level, days: 7 });
    console.log(`insights[${level}]: wrote ${n} rows`);
  } catch (e) {
    console.log(`insights[${level}] FAILED:`, e instanceof Error ? e.message : String(e));
  }
}
const idb = await db.execute(
  sql`select level, count(*)::int n, coalesce(sum(spend),0)::float spend from insights_daily where entity_id=${TARGET} and date >= current_date - 7 group by 1`,
);
console.log("insights_daily 7d:", JSON.stringify(idb));
process.exit(0);
