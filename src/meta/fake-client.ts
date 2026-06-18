import type { InsightsClient } from "./types";

/**
 * Default-stubbed InsightsClient for tests. Override only the methods a test exercises; the rest
 * return empty so adding a new InsightsClient method never breaks every mock at once.
 */
export function fakeInsightsClient(overrides: Partial<InsightsClient> = {}): InsightsClient {
  return {
    getAccounts: async () => [],
    getChildren: async () => [],
    getInsights: async () => [],
    runAsyncInsights: async () => [],
    batchGet: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    ...overrides,
  };
}
