import cron from "node-cron";
import { MetaClient } from "@/meta/client";
import { getCredentials } from "@/lib/credentials";
import { syncStructure, syncAccounts } from "./jobs/structure";
import { syncInsights } from "./jobs/insights";
import { syncBreakdowns, BREAKDOWNS } from "./jobs/breakdowns";
import { markSync, recordTokenHealth } from "./state";
import { runOnce, type Jobs } from "./run";

function buildJobs(): Jobs {
  return {
    structure: async (client, id) => {
      try {
        await syncStructure(client, id);
        await markSync(id, "structure", null);
      } catch (e) {
        await markSync(id, "structure", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    insights: async (client, id) => {
      for (const level of ["account", "campaign", "adset", "ad"] as const) {
        await syncInsights(client, id, { level, days: 3 });
      }
      await markSync(id, "insights", null);
    },
    breakdowns: async (client, id) => {
      await syncBreakdowns(client, id, { breakdowns: [...BREAKDOWNS], days: 7 });
    },
    tokenHealth: async (client) => recordTokenHealth(client),
  };
}

async function cycle() {
  const creds = await getCredentials();
  if (!creds) {
    console.warn("[sync] no credentials configured — set them on the Settings page; skipping cycle");
    return;
  }
  const client = new MetaClient({
    appId: creds.appId, appSecret: creds.appSecret, token: creds.token, version: creds.apiVersion,
  });
  const owned = await syncAccounts(client, creds.businessId);
  const ids = creds.accountIds.length ? owned.filter((a) => creds.accountIds.includes(a)) : owned;
  console.log(`[sync] cycle: ${ids.length} accounts`);
  await runOnce({ client, accountIds: ids, jobs: buildJobs() });
  console.log("[sync] cycle done");
}

const runNow = process.argv.includes("--once");
if (runNow) {
  cycle().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  console.log("[sync] scheduler started (hourly)");
  cron.schedule("0 * * * *", () => { void cycle(); });
  void cycle();
}
