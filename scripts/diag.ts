// Throwaway diagnostic: which Graph call 500s for act_1701082927919653?
import { getCredentials } from "@/lib/credentials";

const TARGET = "act_1701082927919653";
const c = await getCredentials();
if (!c) {
  console.log("NO CREDS");
  process.exit(0);
}
const ver = c.apiVersion;

async function g(path: string, params: Record<string, string> = {}) {
  const u = new URL(`https://graph.facebook.com/${ver}/${path}`);
  u.searchParams.set("access_token", c!.token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const t0 = Date.now();
  const r = await fetch(u);
  const b = (await r.json()) as { data?: unknown[]; error?: { message?: string; code?: number } };
  const ms = Date.now() - t0;
  return { status: r.status, ms, count: b.data?.length ?? null, error: b.error?.message ?? null };
}

const probes: [string, string, Record<string, string>][] = [
  ["campaigns", `${TARGET}/campaigns`, { fields: "id,name,objective,daily_budget", limit: "200" }],
  ["adsets", `${TARGET}/adsets`, { fields: "id,name,campaign_id", limit: "200" }],
  ["ads", `${TARGET}/ads`, { fields: "id,name,creative", limit: "200" }],
  [
    "adcreatives",
    `${TARGET}/adcreatives`,
    { fields: "id,name,thumbnail_url,image_url,object_type,object_story_spec", limit: "200", thumbnail_width: "1080", thumbnail_height: "1080" },
  ],
  [
    "insights_account_90d_daily",
    `${TARGET}/insights`,
    { level: "account", time_increment: "1", date_preset: "last_90d", fields: "spend,impressions,actions", limit: "500" },
  ],
  [
    "insights_ad_90d_daily",
    `${TARGET}/insights`,
    { level: "ad", time_increment: "1", date_preset: "last_90d", fields: "spend,impressions,actions,ad_id", limit: "500" },
  ],
];

for (const [label, path, params] of probes) {
  const r = await g(path, params);
  console.log(label.padEnd(28), "status:", r.status, "ms:", r.ms, "count:", r.count, r.error ? `ERR: ${r.error}` : "");
}
process.exit(0);
