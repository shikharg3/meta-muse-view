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

export interface InsightsClient {
  getAccounts(businessId: string): Promise<GraphNode[]>;
  getChildren(
    parentId: string,
    edge: string,
    fields: string[],
    extra?: Record<string, unknown>,
  ): Promise<GraphNode[]>;
  getInsights(objectId: string, params: Record<string, unknown>): Promise<InsightRow[]>;
  debugToken(): Promise<{ is_valid: boolean; scopes: string[] }>;
}
