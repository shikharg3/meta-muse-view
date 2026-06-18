import { appsecretProof } from "./proof";
import { buildQuery } from "./url";
import { parseUsage, shouldBackoff, peakPressure } from "./rate-limit";
import type { GraphNode, InsightRow, InsightsClient, MetaApiEvent } from "./types";
import { NODE_FIELDS } from "./fieldsets";
import { Limiter } from "./limiter";

export interface MetaCredentials {
  appId: string;
  appSecret: string;
  token: string;
  version: string;
}

/** Persistence for discovered bad field sets, so bisection discovery runs once, not per process. */
export interface FieldStore {
  load(memoKey: string): Promise<string[]>;
  save(memoKey: string, badFields: string[]): Promise<void>;
}

export interface MetaClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  limiter?: Limiter;
  fieldStore?: FieldStore;
  onEvent?: (e: MetaApiEvent) => void;
}

const BASE = "https://graph.facebook.com";

export class MetaClient implements InsightsClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private maxRetries: number;
  private limiter?: Limiter;
  private fieldStore?: FieldStore;
  private loaded = new Set<string>();
  private onEvent?: (e: MetaApiEvent) => void;
  private lastProactive = new Map<string, number>();

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
    this.limiter = deps.limiter;
    this.fieldStore = deps.fieldStore;
    this.onEvent = deps.onEvent;
  }

  /** Route a request through the optional limiter (concurrency + pacing); identity when unset. */
  private gate<T>(fn: () => Promise<T>): Promise<T> {
    return this.limiter ? this.limiter.run(fn) : fn();
  }

  /** Forward a notable API event to the sink (if any). Proactive-backoff events are coalesced per
   *  account so a run near the limit doesn't flood the event log. */
  private emit(e: MetaApiEvent): void {
    if (!this.onEvent) return;
    if (e.kind === "rate_limit" && e.code === 0) {
      const last = this.lastProactive.get(e.accountId) ?? 0;
      if (e.at - last < 30_000) return;
      this.lastProactive.set(e.accountId, e.at);
    }
    try {
      this.onEvent(e);
    } catch {
      // the sink must never break a request
    }
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
      const res = await this.gate(() => this.fetchImpl(this.url(path, params)));
      if (res.status === 429 || res.status >= 500) {
        if (attempt++ >= this.maxRetries)
          throw new Error(`Meta ${res.status} after ${attempt} retries`);
        await this.sleep(backoffMs(attempt));
        continue;
      }
      const body = (await res.json()) as Record<string, unknown>;
      const error = body?.error as
        | { code?: unknown; message?: unknown; is_transient?: unknown }
        | undefined;
      if (error) {
        const code = Number(error.code);
        // #4 app limit, #17 user limit, #32 page limit, #613 custom, #80000-80014 BUC throttles.
        const rateLimited =
          error.is_transient === true ||
          code === 1 || // transient unknown
          code === 2 || // service temporarily unavailable
          code === 4 ||
          code === 17 ||
          code === 32 ||
          code === 613 ||
          (code >= 80000 && code <= 80014);
        if (rateLimited) {
          if (attempt < this.maxRetries) {
            attempt++;
            await this.sleep(Math.min(60_000, backoffMs(attempt) * 4));
            continue;
          }
          // Retries exhausted on a rate-limit code — surface it before giving up on this call.
          const u = accountId ? parseUsage(res.headers, accountId) : null;
          this.emit({
            kind: "rate_limit",
            code,
            message: String(error.message ?? ""),
            accountId,
            retryAfterMin: u?.estimatedTimeToRegainAccess ?? 0,
            pressure: u ? peakPressure(u) : 0,
            at: Date.now(),
          });
        }
        throw new Error(`Meta error ${error.code}: ${error.message}`);
      }
      if (accountId) {
        const usage = parseUsage(res.headers, accountId);
        if (shouldBackoff(usage)) {
          this.emit({
            kind: "rate_limit",
            code: 0,
            message: `approaching limit (peak ${peakPressure(usage)}%)`,
            accountId,
            retryAfterMin: usage.estimatedTimeToRegainAccess,
            pressure: peakPressure(usage),
            at: Date.now(),
          });
          await this.sleep(
            Math.min(60_000, Math.max(1000, usage.estimatedTimeToRegainAccess * 60_000)),
          );
        }
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

  private badFields = new Map<string, Set<string>>();

  private stripBad(memoKey: string, fields: string[]): string[] {
    const bad = this.badFields.get(memoKey);
    return bad ? fields.filter((f) => !bad.has(f)) : fields;
  }

  private recordBad(memoKey: string, fields: string[]): void {
    const set = this.badFields.get(memoKey) ?? new Set<string>();
    for (const f of fields) set.add(f);
    this.badFields.set(memoKey, set);
    void this.fieldStore?.save(memoKey, [...set]);
  }

  /** Load a key's persisted blocklist once, so bisection discovery isn't repeated each process. */
  private async ensureLoaded(memoKey: string): Promise<void> {
    if (this.loaded.has(memoKey)) return;
    this.loaded.add(memoKey);
    if (!this.fieldStore) return;
    try {
      const persisted = await this.fieldStore.load(memoKey);
      if (persisted.length > 0) {
        const set = this.badFields.get(memoKey) ?? new Set<string>();
        for (const f of persisted) set.add(f);
        this.badFields.set(memoKey, set);
      }
    } catch {
      // best-effort cache; fall back to live discovery
    }
  }

  /** #100 (nonexisting), #10 (permission) and #3 (unknown) all mean "a field must be dropped". */
  private isFieldError(e: unknown): boolean {
    const m = e instanceof Error ? e.message : "";
    return /error (?:100|10|3):|nonexisting field|not have permission|[Uu]nknown fields?/.test(m);
  }

  /** Field names Meta named in the error, if any ("nonexisting field (x)" / "Unknown fields: x"). */
  private parseBadFields(message: string): string[] {
    const out: string[] = [];
    const nonexisting = message.match(/nonexisting field \(([^)]+)\)/i);
    if (nonexisting) out.push(...nonexisting[1].split(/[\s,]+/));
    const unknown = message.match(/[Uu]nknown fields?:?\s*([\w,\s]+)/);
    if (unknown) out.push(...unknown[1].split(/[\s,]+/));
    return [...new Set(out.filter(Boolean))];
  }

  /** Maximal accepted subset of `fields`, isolated by bisection (for unnamed #10 permission errors). */
  private async resolveGoodFields(
    path: string,
    params: Record<string, unknown>,
    accountId: string,
    fields: string[],
    memoKey: string,
  ): Promise<string[]> {
    const probe = async (fs: string[]): Promise<boolean> => {
      try {
        await this.getPage(path, { ...params, fields: fs, limit: 1 }, accountId);
        return true;
      } catch (e) {
        if (this.isFieldError(e)) return false;
        throw e;
      }
    };
    const find = async (fs: string[]): Promise<string[]> => {
      if (fs.length === 0) return [];
      if (await probe(fs)) return fs;
      if (fs.length === 1) {
        this.recordBad(memoKey, fs);
        return [];
      }
      const mid = Math.floor(fs.length / 2);
      const left = await find(fs.slice(0, mid));
      const right = await find(fs.slice(mid));
      return [...left, ...right];
    };
    return find(fields);
  }

  /**
   * Run `exec(fields)` with field-error recovery: strip the persisted blocklist first, drop any
   * field Meta names in an error (fast path), else isolate the bad ones by bisection. Shared by the
   * paged, single-node, and async-insights paths so all three self-heal identically.
   */
  private async withFieldRecovery<T>(
    memoKey: string,
    requested: string[],
    accountId: string,
    probePath: string,
    probeParams: Record<string, unknown>,
    exec: (fields: string[]) => Promise<T>,
  ): Promise<T> {
    await this.ensureLoaded(memoKey);
    for (let attempt = 0; attempt < 12; attempt++) {
      const fields = this.stripBad(memoKey, requested);
      try {
        return await exec(fields);
      } catch (e) {
        if (!this.isFieldError(e)) throw e;
        const named = this.parseBadFields(e instanceof Error ? e.message : "").filter((f) =>
          fields.includes(f),
        );
        if (named.length > 0) {
          this.recordBad(memoKey, named);
          continue;
        }
        const good = await this.resolveGoodFields(
          probePath,
          probeParams,
          accountId,
          fields,
          memoKey,
        );
        return exec(good);
      }
    }
    throw new Error(`Meta: could not resolve a valid field set for ${probePath}`);
  }

  /** GET a fields-bearing edge, dropping fields Meta rejects (named fast-path, else bisection). */
  private pagedWithRecovery(
    path: string,
    params: Record<string, unknown>,
    accountId: string,
    memoKey: string,
  ): Promise<GraphNode[]> {
    const requested = Array.isArray(params.fields) ? (params.fields as string[]) : null;
    if (!requested) return this.getPaged(path, params, accountId);
    return this.withFieldRecovery(memoKey, requested, accountId, path, params, (fields) =>
      this.getPaged(path, { ...params, fields }, accountId),
    );
  }

  /** GET a single node with its full field set, dropping fields Meta rejects (memoKey = node type). */
  getNodeFull(id: string, fields: string[], memoKey: string, accountId = ""): Promise<GraphNode> {
    return this.withFieldRecovery(
      memoKey,
      fields,
      accountId,
      id,
      {},
      async (use) => (await this.getPage(id, { fields: use }, accountId)) as GraphNode,
    );
  }

  /** Submit an async insights report; returns the report_run_id. */
  async submitAsyncInsights(objectId: string, params: Record<string, unknown>): Promise<string> {
    const res = await this.gate(() =>
      this.fetchImpl(this.url(`${objectId}/insights`, params), { method: "POST" }),
    );
    const body = (await res.json()) as { report_run_id?: unknown; error?: { message?: unknown } };
    if (body.error) throw new Error(`Meta async submit error: ${body.error.message}`);
    return String(body.report_run_id);
  }

  /** Submit an async insights report, poll to completion, then page its rows. */
  private async runAsyncOnce(
    objectId: string,
    params: Record<string, unknown>,
    opts: { pollMs?: number; maxPolls?: number },
  ): Promise<InsightRow[]> {
    const runId = await this.submitAsyncInsights(objectId, params);
    const pollMs = opts.pollMs ?? 5000;
    const maxPolls = opts.maxPolls ?? 240;
    for (let i = 0; i < maxPolls; i++) {
      const status = await this.getPage(runId, {});
      const state = String(status.async_status ?? "");
      if (state === "Job Completed")
        return (await this.getPaged(`${runId}/insights`, {
          limit: 500,
        })) as unknown as InsightRow[];
      if (state === "Job Failed" || state === "Job Skipped")
        throw new Error(`Meta async report ${state} for ${objectId}`);
      await this.sleep(pollMs);
    }
    throw new Error(`Meta async report timed out for ${objectId}`);
  }

  /** Async insights with the same field-error recovery as the sync paths (pass a memoKey). */
  async runAsyncInsights(
    objectId: string,
    params: Record<string, unknown>,
    opts: { memoKey?: string; pollMs?: number; maxPolls?: number } = {},
  ): Promise<InsightRow[]> {
    const requested = Array.isArray(params.fields) ? (params.fields as string[]) : null;
    if (!opts.memoKey || !requested) return this.runAsyncOnce(objectId, params, opts);
    const accountId = objectId.startsWith("act_") ? objectId : "";
    return this.withFieldRecovery(
      opts.memoKey,
      requested,
      accountId,
      `${objectId}/insights`,
      params,
      (fields) => this.runAsyncOnce(objectId, { ...params, fields }, opts),
    );
  }

  /** Batched GET of relative urls (Graph caps each batch at 50); null per failed item. */
  async batchGet(relativeUrls: string[]): Promise<(Record<string, unknown> | null)[]> {
    const out: (Record<string, unknown> | null)[] = [];
    for (let i = 0; i < relativeUrls.length; i += 50) {
      const group = relativeUrls.slice(i, i + 50);
      const form = new URLSearchParams({
        access_token: this.creds.token,
        batch: JSON.stringify(group.map((u) => ({ method: "GET", relative_url: u }))),
      });
      if (this.creds.appSecret)
        form.set("appsecret_proof", appsecretProof(this.creds.token, this.creds.appSecret));
      const res = await this.gate(() =>
        this.fetchImpl(`${BASE}/${this.creds.version}`, { method: "POST", body: form }),
      );
      const arr = (await res.json()) as ({ code?: number; body?: string } | null)[];
      for (const item of Array.isArray(arr) ? arr : [])
        out.push(item && item.code === 200 && item.body ? JSON.parse(item.body) : null);
    }
    return out;
  }

  async getAccounts(_businessId: string): Promise<GraphNode[]> {
    // Full account field set; getChildren drops any field this token can't read. A system-user
    // token reads exactly its assigned accounts, which is what /me/adaccounts returns.
    return this.getChildren("me", "adaccounts", NODE_FIELDS.account, { limit: 200 });
  }

  getChildren(
    parentId: string,
    edge: string,
    fields: string[],
    extra: Record<string, unknown> = {},
  ): Promise<GraphNode[]> {
    const accountId = parentId.startsWith("act_") ? parentId : "";
    return this.pagedWithRecovery(
      `${parentId}/${edge}`,
      { fields, limit: 200, ...extra },
      accountId,
      edge,
    );
  }

  async getInsights(objectId: string, params: Record<string, unknown>): Promise<InsightRow[]> {
    const accountId = objectId.startsWith("act_") ? objectId : "";
    const bd = Array.isArray(params.breakdowns) ? (params.breakdowns as string[]).join(",") : "";
    const key = `insights:${params.level ?? ""}:${bd}`;
    const rows = await this.pagedWithRecovery(
      `${objectId}/insights`,
      { limit: 500, ...params },
      accountId,
      key,
    );
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
