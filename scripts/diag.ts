// Verify the numeric BM id resolves its account edges.
import { getCredentials } from "@/lib/credentials";
const c = await getCredentials();
if (!c) { console.log("NO CREDS"); process.exit(0); }
console.log("businessId:", c.businessId, "numeric:", /^\d+$/.test(c.businessId));
async function g(path: string) {
  const u = new URL(`https://graph.facebook.com/${c!.apiVersion}/${path}`);
  u.searchParams.set("access_token", c!.token);
  u.searchParams.set("fields", "account_id");
  u.searchParams.set("limit", "500");
  const r = await fetch(u);
  const b = (await r.json()) as { data?: unknown[]; error?: { message?: string } };
  return { status: r.status, count: b.data?.length ?? null, error: b.error?.message ?? null };
}
console.log("owned_ad_accounts:", JSON.stringify(await g(`${c.businessId}/owned_ad_accounts`)));
console.log("client_ad_accounts:", JSON.stringify(await g(`${c.businessId}/client_ad_accounts`)));
console.log("me/adaccounts:", JSON.stringify(await g("me/adaccounts")));
process.exit(0);
