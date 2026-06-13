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
    // Each job is isolated: a structure failure (e.g. a 500 on one heavy edge)
    // must NOT skip insights/breakdowns for the same account.
    await runJob(() => jobs.structure(client, id), id, onError);
    await runJob(() => jobs.insights(client, id), id, onError);
    await runJob(() => jobs.breakdowns(client, id), id, onError);
  }
}

async function runJob(
  fn: () => Promise<void>,
  id: string,
  onError?: (accountId: string, err: unknown) => void,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    onError?.(id, err);
    console.error(`[sync] account ${id} job failed:`, err);
  }
}
