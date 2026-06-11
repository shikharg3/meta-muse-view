import { appsecretProof } from "./proof";
import { buildQuery } from "./url";
import { parseUsage, shouldBackoff } from "./rate-limit";
import type { GraphNode, InsightRow, InsightsClient } from "./types";

export interface MetaCredentials {
  appId: string;
  appSecret: string;
  token: string;
  version: string;
}

export interface MetaClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const BASE = "https://graph.facebook.com";

export class MetaClient implements InsightsClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private maxRetries: number;

  constructor(
    private creds: MetaCredentials,
    deps: MetaClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep =
      deps.sleep ??
      ((ms) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      });
    this.maxRetries = deps.maxRetries ?? 5;
  }

  private url(path: string, params: Record<string, unknown>): string {
    const auth: Record<string, unknown> = { access_token: this.creds.token };
    if (this.creds.appSecret) {
      auth.appsecret_proof = appsecretProof(this.creds.token, this.creds.appSecret);
    }
    const qs = buildQuery({ ...params, ...auth });
    return `${BASE}/${this.creds.version}/${path}?${qs}`;
  }

  /** GET one page with retry/backoff; returns parsed JSON. */
  private async getPage(
    path: string,
    params: Record<string, unknown>,
    accountId = "",
  ): Promise<Record<string, unknown>> {
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(this.url(path, params));
      if (res.status === 429 || res.status >= 500) {
        if (attempt++ >= this.maxRetries)
          throw new Error(`Meta ${res.status} after ${attempt} retries`);
        await this.sleep(backoffMs(attempt));
        continue;
      }
      const body = (await res.json()) as Record<string, unknown>;
      const error = body?.error as { code?: unknown; message?: unknown } | undefined;
      if (error) throw new Error(`Meta error ${error.code}: ${error.message}`);
      if (accountId) {
        const usage = parseUsage(res.headers, accountId);
        if (shouldBackoff(usage))
          await this.sleep(
            Math.min(60_000, Math.max(1000, usage.estimatedTimeToRegainAccess * 60_000)),
          );
      }
      return body;
    }
  }

  /** GET an edge, following cursor pagination. */
  private async getPaged(
    path: string,
    params: Record<string, unknown>,
    accountId = "",
  ): Promise<GraphNode[]> {
    const out: GraphNode[] = [];
    let after: string | undefined;
    do {
      const body = await this.getPage(path, { ...params, after }, accountId);
      const data = body?.data;
      if (Array.isArray(data)) out.push(...(data as GraphNode[]));
      const paging = body?.paging as { next?: unknown; cursors?: { after?: unknown } } | undefined;
      after =
        paging?.next && typeof paging.cursors?.after === "string"
          ? paging.cursors.after
          : undefined;
    } while (after);
    return out;
  }

  async getAccounts(businessId: string): Promise<GraphNode[]> {
    const fields = ["account_id", "name", "currency", "account_status"];
    // System-user tokens enumerate via /me/adaccounts when no usable business id is
    // configured. BM ids are numeric; anything else (e.g. an email pasted into the
    // Settings field) would 400 every cycle, so fall back instead of dying.
    if (!businessId || !/^\d+$/.test(businessId)) {
      if (businessId) {
        console.warn(
          `[meta] business id ${JSON.stringify(businessId)} is not numeric; enumerating via /me/adaccounts`,
        );
      }
      return this.getPaged("me/adaccounts", { fields, limit: 200 });
    }
    const [owned, managed] = await Promise.all([
      this.getPaged(`${businessId}/owned_ad_accounts`, { fields, limit: 200 }),
      this.getPaged(`${businessId}/client_ad_accounts`, { fields, limit: 200 }),
    ]);
    const byId = new Map<string, GraphNode>();
    for (const a of [...owned, ...managed]) byId.set(String(a.id), a);
    return [...byId.values()];
  }

  getChildren(
    parentId: string,
    edge: string,
    fields: string[],
    extra: Record<string, unknown> = {},
  ): Promise<GraphNode[]> {
    const accountId = parentId.startsWith("act_") ? parentId : "";
    return this.getPaged(`${parentId}/${edge}`, { fields, limit: 200, ...extra }, accountId);
  }

  async getInsights(objectId: string, params: Record<string, unknown>): Promise<InsightRow[]> {
    const accountId = objectId.startsWith("act_") ? objectId : "";
    const rows = await this.getPaged(`${objectId}/insights`, { limit: 500, ...params }, accountId);
    return rows as unknown as InsightRow[];
  }

  async debugToken(): Promise<{ is_valid: boolean; scopes: string[] }> {
    const body = await this.getPage("debug_token", {
      input_token: this.creds.token,
    });
    const d = (body?.data ?? {}) as Record<string, unknown>;
    return {
      is_valid: Boolean(d.is_valid),
      scopes: Array.isArray(d.scopes) ? (d.scopes as string[]) : [],
    };
  }
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 2 ** attempt * 250) + Math.floor(Math.random() * 250);
}
