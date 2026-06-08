import type { InsightsClient } from "@/meta/types";

export interface Jobs {
  structure: (client: InsightsClient, accountId: string) => Promise<void>;
  insights: (client: InsightsClient, accountId: string) => Promise<void>;
  breakdowns: (client: InsightsClient, accountId: string) => Promise<void>;
  tokenHealth: (client: InsightsClient) => Promise<void>;
}

export interface RunOpts {
  client: InsightsClient;
  accountIds: string[];
  jobs: Jobs;
  onError?: (accountId: string, err: unknown) => void;
}

/** One full sync cycle: token health once, then each account sequentially (rate-limit safe). */
export async function runOnce({ client, accountIds, jobs, onError }: RunOpts): Promise<void> {
  await jobs.tokenHealth(client);
  for (const id of accountIds) {
    try {
      await jobs.structure(client, id);
      await jobs.insights(client, id);
      await jobs.breakdowns(client, id);
    } catch (err) {
      onError?.(id, err);
      console.error(`[sync] account ${id} failed:`, err);
    }
  }
}
