export interface InsightRow {
  date_start: string;
  date_stop: string;
  account_id?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
  purchase_roas?: { action_type: string; value: string }[];
  [k: string]: unknown;
}

export interface GraphNode {
  id: string;
  [k: string]: unknown;
}

/** A notable Meta API occurrence the sync layer persists for admin visibility. */
export interface MetaApiEvent {
  kind: "rate_limit" | "error";
  code: number; // Meta error code (0 when proactive/unknown)
  message: string;
  accountId: string; // "" when not account-scoped
  retryAfterMin: number; // estimated_time_to_regain_access, 0 if unknown
  pressure: number; // peak BUC utilization 0-100 at the time (0 when derived from an error)
  at: number; // epoch ms
}

export interface InsightsClient {
  getAccounts(businessId: string): Promise<GraphNode[]>;
  getChildren(
    parentId: string,
    edge: string,
    fields: string[],
    extra?: Record<string, unknown>,
  ): Promise<GraphNode[]>;
  getInsights(objectId: string, params: Record<string, unknown>): Promise<InsightRow[]>;
  runAsyncInsights(
    objectId: string,
    params: Record<string, unknown>,
    opts?: { memoKey?: string; pollMs?: number; maxPolls?: number },
  ): Promise<InsightRow[]>;
  batchGet(relativeUrls: string[]): Promise<(Record<string, unknown> | null)[]>;
  debugToken(): Promise<{ is_valid: boolean; scopes: string[] }>;
}
