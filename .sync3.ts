import { MetaClient } from "@/meta/client";
import { Limiter } from "@/meta/limiter";
import { getCredentials } from "@/lib/credentials";
import { syncStructure } from "@/sync/jobs/structure";
import { syncInsights } from "@/sync/jobs/insights";
import { getFieldBlocklist, saveFieldBlocklist, markSync } from "@/sync/state";

const IDS = ["act_3529307627217860", "act_875998781599019", "act_878794245268641"];
const LEVELS = ["account", "campaign", "adset", "ad"] as const;

const creds = await getCredentials();
if (!creds) throw new Error("no credentials");
const client = new MetaClient(
  { appId: creds.appId, appSecret: creds.appSecret, token: creds.token, version: creds.apiVersion },
  { limiter: new Limiter(1, 250), fieldStore: { load: getFieldBlocklist, save: saveFieldBlocklist } },
);

for (const id of IDS) {
  try {
    await syncStructure(client, id);
    await markSync(id, "structure", null);
    for (const level of LEVELS) await syncInsights(client, id, { level, days: 28 });
    await markSync(id, "insights", null);
    console.log(`done ${id}`);
  } catch (e) {
    console.error(`FAILED ${id}:`, e instanceof Error ? e.message : e);
  }
}
console.log("targeted sync complete");
