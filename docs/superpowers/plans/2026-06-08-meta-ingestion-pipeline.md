# Meta Ingestion Pipeline (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side data pipeline that syncs Meta Marketing API structure + insights for 1 Business Manager and 50+ ad accounts into Postgres, rate-limit aware, on a schedule.

**Architecture:** A standalone worker process (`bun run sync`) is the only thing that calls Meta. It fetches structure (accounts→campaigns→adsets→ads→creatives) and daily insights (+ breakdowns) through a thin typed `fetch` client, and upserts everything into Postgres via Drizzle. The web app (Plan B) reads Postgres only. All Meta calls go through a small client with `appsecret_proof`, cursor pagination, rate-limit-header backoff, and async-job fallback.

**Tech Stack:** Bun + TypeScript, `drizzle-orm` 0.45 + `postgres` (postgres.js) 3.4 + `drizzle-kit` 0.31, `node-cron` 4, `zod` (already present). Tests: built-in `bun test`. Postgres via Docker.

**Companion spec:** `docs/superpowers/specs/2026-06-08-meta-marketing-api-integration-design.md` (read §6 for the grounded Meta API reference).

**Conventions for this plan**
- Test runner: `bun test path/to/file.test.ts`. Bun auto-loads `.env`.
- Dependencies are injected (client into jobs, `fetchImpl` into the client) so unit tests never hit the network and integration tests never hit Meta.
- Integration tests run against a **test Postgres** at `DATABASE_URL`; tables are created once via `drizzle-kit push` and truncated per-test.
- Commit after every task with the exact message shown.

---

## Task 0: Prerequisites (Phase 0 — manual setup, no code)

These are human/infra steps. Development and all tests below run on the **dev access tier** against a **single** ad account; full 50-account production sync needs Standard Access (App Review), which can proceed in parallel.

- [ ] **Step 1: Create the Meta App + System User**
  - developers.facebook.com → Create App → type **Business**. Note the **App ID** and **App Secret** (App Settings → Basic).
  - business.facebook.com → Business Settings → Users → **System Users** → Add (Admin). Add Assets → assign **at least one ad account** with full control.
  - System User → **Generate New Token** → select your app → scopes **`ads_read`**, **`business_management`**, **`read_insights`**. Copy the token (shown once).
  - Note your **Business Manager ID** (Business Settings → Business Info) and one **ad account id** (`act_...`).

- [ ] **Step 2: Start a local Postgres (dev + test)**

Run:
```bash
docker run -d --name meta-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=meta -p 5432:5432 postgres:16
```
Expected: a container id printed; `docker ps` shows `meta-pg` healthy on `0.0.0.0:5432`.

- [ ] **Step 3: Create `.env` and `.env.example`**

Create `.env` (gitignored already via `*.local`? No — add `.env`): add `.env` to `.gitignore` first.

`.gitignore` — append:
```
.env
```

Create `.env.example`:
```bash
META_APP_ID=
META_APP_SECRET=
META_SYSTEM_USER_TOKEN=
META_BUSINESS_ID=
META_API_VERSION=v25.0
# comma-separated act_ ids to sync; leave one id during dev
META_AD_ACCOUNT_IDS=
DATABASE_URL=postgres://postgres:postgres@localhost:5432/meta
```

Create `.env` with the same keys filled from Step 1 (one `act_` id in `META_AD_ACCOUNT_IDS`).

- [ ] **Step 4: Verify the token works (one curl)**

Run (substitute values):
```bash
curl -s "https://graph.facebook.com/v25.0/me?fields=id,name&access_token=$META_SYSTEM_USER_TOKEN"
```
Expected: JSON with an `id` (the system user id), no `error`. If you see `error.code` 190, the token is wrong/expired.

- [ ] **Step 5: Commit the env scaffolding**
```bash
git add .gitignore .env.example
git commit -m "chore: env scaffolding for Meta ingestion"
```

---

## Task 1: Dependencies, scripts, and env validation

**Files:**
- Modify: `package.json` (deps + scripts)
- Create: `src/lib/env.ts`
- Test: `src/lib/env.test.ts`

- [ ] **Step 1: Install dependencies**
```bash
bun add drizzle-orm postgres node-cron
bun add -d drizzle-kit @types/node-cron
```
Expected: all resolve; `package.json` lists `drizzle-orm`, `postgres`, `node-cron`.

- [ ] **Step 2: Add scripts to `package.json`**

In the `"scripts"` block add:
```json
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "sync": "bun run src/sync/worker.ts",
    "sync:once": "bun run src/sync/worker.ts --once"
```

- [ ] **Step 3: Write the failing test**

`src/lib/env.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseEnv } from "./env";

const base = {
  META_APP_ID: "123",
  META_APP_SECRET: "secret",
  META_SYSTEM_USER_TOKEN: "token",
  META_BUSINESS_ID: "456",
  META_AD_ACCOUNT_IDS: "act_1,act_2",
  DATABASE_URL: "postgres://localhost/meta",
};

test("parses a valid env and defaults the API version", () => {
  const env = parseEnv(base);
  expect(env.META_API_VERSION).toBe("v25.0");
  expect(env.META_AD_ACCOUNT_IDS).toEqual(["act_1", "act_2"]);
});

test("throws when a required var is missing", () => {
  const { META_APP_SECRET, ...rest } = base;
  expect(() => parseEnv(rest)).toThrow();
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test src/lib/env.test.ts`
Expected: FAIL — `Cannot find module './env'`.

- [ ] **Step 5: Write minimal implementation**

`src/lib/env.ts`:
```ts
import { z } from "zod";

const schema = z.object({
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_SYSTEM_USER_TOKEN: z.string().min(1),
  META_BUSINESS_ID: z.string().min(1),
  META_API_VERSION: z.string().default("v25.0"),
  META_AD_ACCOUNT_IDS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  DATABASE_URL: z.string().min(1),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source);
}

// Lazily-validated singleton for runtime use (never at import time on the client).
let cached: Env | undefined;
export function env(): Env {
  if (!cached) cached = parseEnv();
  return cached;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/lib/env.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**
```bash
git add package.json bun.lock src/lib/env.ts src/lib/env.test.ts
git commit -m "feat: deps, sync scripts, and validated env config"
```

---

## Task 2: Database schema, client, and migration

**Files:**
- Create: `drizzle.config.ts`, `src/db/schema.ts`, `src/db/client.ts`
- Test: `src/db/schema.test.ts`

- [ ] **Step 1: Write `drizzle.config.ts`**
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 2: Write `src/db/schema.ts`**
```ts
import {
  pgTable, text, bigint, doublePrecision, timestamp, jsonb, date, boolean, primaryKey,
} from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status"),
  effectiveStatus: text("effective_status"),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaigns = pgTable("campaigns", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  status: text("status"),
  effectiveStatus: text("effective_status"),
  objective: text("objective"),
  dailyBudget: bigint("daily_budget", { mode: "number" }),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adSets = pgTable("ad_sets", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  status: text("status"),
  effectiveStatus: text("effective_status"),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ads = pgTable("ads", {
  id: text("id").primaryKey(),
  adSetId: text("ad_set_id").notNull(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  status: text("status"),
  effectiveStatus: text("effective_status"),
  creativeId: text("creative_id"),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adCreatives = pgTable("ad_creatives", {
  id: text("id").primaryKey(),
  name: text("name"),
  thumbnailUrl: text("thumbnail_url"),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insightsDaily = pgTable(
  "insights_daily",
  {
    level: text("level").notNull(),
    entityId: text("entity_id").notNull(),
    date: date("date").notNull(),
    accountId: text("account_id").notNull(),
    spend: doublePrecision("spend").notNull().default(0),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    reach: bigint("reach", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    inlineLinkClicks: bigint("inline_link_clicks", { mode: "number" }).notNull().default(0),
    ctr: doublePrecision("ctr").notNull().default(0),
    cpc: doublePrecision("cpc").notNull().default(0),
    cpm: doublePrecision("cpm").notNull().default(0),
    conversions: doublePrecision("conversions").notNull().default(0),
    conversionValues: doublePrecision("conversion_values").notNull().default(0),
    purchaseRoas: doublePrecision("purchase_roas").notNull().default(0),
    actions: jsonb("actions"),
    actionValues: jsonb("action_values"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.level, t.entityId, t.date] })],
);

export const insightsBreakdownDaily = pgTable(
  "insights_breakdown_daily",
  {
    level: text("level").notNull(),
    entityId: text("entity_id").notNull(),
    date: date("date").notNull(),
    accountId: text("account_id").notNull(),
    breakdownType: text("breakdown_type").notNull(),
    breakdownValue: text("breakdown_value").notNull(),
    spend: doublePrecision("spend").notNull().default(0),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    conversions: doublePrecision("conversions").notNull().default(0),
    conversionValues: doublePrecision("conversion_values").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.level, t.entityId, t.date, t.breakdownType, t.breakdownValue],
    }),
  ],
);

export const syncState = pgTable("sync_state", {
  accountId: text("account_id").primaryKey(),
  lastStructureSync: timestamp("last_structure_sync", { withTimezone: true }),
  lastInsightsSync: timestamp("last_insights_sync", { withTimezone: true }),
  status: text("status").notNull().default("idle"),
  lastError: text("last_error"),
});

export const tokenHealth = pgTable("token_health", {
  id: text("id").primaryKey().default("singleton"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  isValid: boolean("is_valid").notNull().default(false),
  scopes: jsonb("scopes"),
  note: text("note"),
});
```

- [ ] **Step 3: Write `src/db/client.ts`**
```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "@/lib/env";

const queryClient = postgres(env().DATABASE_URL, { max: 5 });
export const db = drizzle({ client: queryClient, schema });
export { schema };
```

- [ ] **Step 4: Push the schema to the test/dev DB**

Run: `bun run db:push`
Expected: drizzle-kit applies the tables; ends with "Changes applied". Verify: `docker exec meta-pg psql -U postgres -d meta -c "\dt"` lists `accounts`, `insights_daily`, etc.

- [ ] **Step 5: Write the failing test**

`src/db/schema.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "./client";

beforeEach(async () => {
  await db.execute(sql`truncate table accounts cascade`);
});

test("round-trips an account row", async () => {
  await db.insert(schema.accounts).values({
    id: "act_1", name: "Test Co", currency: "USD", status: "ACTIVE",
  });
  const rows = await db.select().from(schema.accounts);
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe("Test Co");
});
```

- [ ] **Step 6: Run test to verify it passes** (schema already pushed)

Run: `bun test src/db/schema.test.ts`
Expected: PASS (1 test). If it fails with a connection error, confirm `DATABASE_URL` and that `meta-pg` is running.

- [ ] **Step 7: Commit**
```bash
git add drizzle.config.ts src/db package.json
git commit -m "feat: Drizzle schema, client, and initial migration"
```

---

## Task 3: Meta client — appsecret_proof and URL builder

**Files:**
- Create: `src/meta/proof.ts`, `src/meta/url.ts`
- Test: `src/meta/proof.test.ts`, `src/meta/url.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/meta/proof.test.ts`:
```ts
import { test, expect } from "bun:test";
import { appsecretProof } from "./proof";

test("computes the known HMAC-SHA256 hex vector", () => {
  expect(appsecretProof("test-token", "test-secret")).toBe(
    "4bd72343ca044f8aab1d98f07606cdb1cf47df0c089ff7b5b2df44e40d869970",
  );
});

test("is 64 hex chars and changes with the token", () => {
  const a = appsecretProof("a", "secret");
  const b = appsecretProof("b", "secret");
  expect(a).toHaveLength(64);
  expect(a).not.toBe(b);
});
```

`src/meta/url.test.ts`:
```ts
import { test, expect } from "bun:test";
import { buildQuery } from "./url";

test("comma-joins array params and JSON-encodes objects", () => {
  const qs = buildQuery({
    fields: ["spend", "impressions"],
    level: "campaign",
    filtering: [{ field: "spend", operator: "GREATER_THAN", value: 0 }],
  });
  const p = new URLSearchParams(qs);
  expect(p.get("fields")).toBe("spend,impressions");
  expect(p.get("level")).toBe("campaign");
  expect(JSON.parse(p.get("filtering")!)).toEqual([
    { field: "spend", operator: "GREATER_THAN", value: 0 },
  ]);
});

test("skips undefined values", () => {
  const qs = buildQuery({ fields: ["spend"], after: undefined });
  expect(new URLSearchParams(qs).has("after")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/meta/proof.test.ts src/meta/url.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`src/meta/proof.ts`:
```ts
import { createHmac } from "node:crypto";

/** Meta `appsecret_proof`: HMAC-SHA256 of the access token, keyed by the app secret, hex. */
export function appsecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}
```

`src/meta/url.ts`:
```ts
export type Param = string | number | boolean | unknown[] | Record<string, unknown> | undefined;

/** Serialize Graph API params: arrays of scalars → comma-joined; objects/arrays-of-objects → JSON. */
export function buildQuery(params: Record<string, Param>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const allScalar = value.every((v) => typeof v !== "object" || v === null);
      out.set(key, allScalar ? value.join(",") : JSON.stringify(value));
    } else if (typeof value === "object") {
      out.set(key, JSON.stringify(value));
    } else {
      out.set(key, String(value));
    }
  }
  return out.toString();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/meta/proof.test.ts src/meta/url.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add src/meta/proof.ts src/meta/url.ts src/meta/proof.test.ts src/meta/url.test.ts
git commit -m "feat: Meta appsecret_proof and query serializer"
```

---

## Task 4: Meta client — rate-limit header parsing

**Files:**
- Create: `src/meta/rate-limit.ts`
- Test: `src/meta/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

`src/meta/rate-limit.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseUsage, shouldBackoff } from "./rate-limit";

test("parses business-use-case usage and insights throttle headers", () => {
  const headers = new Headers({
    "x-business-use-case-usage": JSON.stringify({
      "act_1": [{ type: "ads_insights", total_cputime: 80, total_time: 20, estimated_time_to_regain_access: 0 }],
    }),
    "x-fb-ads-insights-throttle": JSON.stringify({ app_id_util_pct: 12, acc_id_util_pct: 95 }),
  });
  const usage = parseUsage(headers, "act_1");
  expect(usage.totalCputime).toBe(80);
  expect(usage.accIdUtilPct).toBe(95);
});

test("recommends backoff when any utilization crosses the threshold", () => {
  expect(shouldBackoff({ totalCputime: 90, totalTime: 10, appIdUtilPct: 0, accIdUtilPct: 0, estimatedTimeToRegainAccess: 0 })).toBe(true);
  expect(shouldBackoff({ totalCputime: 10, totalTime: 10, appIdUtilPct: 0, accIdUtilPct: 99, estimatedTimeToRegainAccess: 0 })).toBe(true);
  expect(shouldBackoff({ totalCputime: 10, totalTime: 10, appIdUtilPct: 0, accIdUtilPct: 0, estimatedTimeToRegainAccess: 0 })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/meta/rate-limit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/meta/rate-limit.ts`:
```ts
export interface Usage {
  totalCputime: number;
  totalTime: number;
  appIdUtilPct: number;
  accIdUtilPct: number;
  estimatedTimeToRegainAccess: number; // minutes
}

const THRESHOLD = 85;

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export function parseUsage(headers: Headers, accountId: string): Usage {
  const buc = safeJson(headers.get("x-business-use-case-usage"));
  const throttle = safeJson(headers.get("x-fb-ads-insights-throttle"));
  const entry = Array.isArray(buc?.[accountId]) ? buc[accountId][0] : undefined;
  return {
    totalCputime: num(entry?.total_cputime),
    totalTime: num(entry?.total_time),
    estimatedTimeToRegainAccess: num(entry?.estimated_time_to_regain_access),
    appIdUtilPct: num(throttle?.app_id_util_pct),
    accIdUtilPct: num(throttle?.acc_id_util_pct),
  };
}

export function shouldBackoff(u: Usage): boolean {
  return (
    u.totalCputime >= THRESHOLD ||
    u.totalTime >= THRESHOLD ||
    u.appIdUtilPct >= THRESHOLD ||
    u.accIdUtilPct >= THRESHOLD
  );
}

function safeJson(s: string | null): any {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/meta/rate-limit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add src/meta/rate-limit.ts src/meta/rate-limit.test.ts
git commit -m "feat: Meta rate-limit header parsing and backoff decision"
```

---

## Task 5: Meta client — fetch with pagination and backoff

**Files:**
- Create: `src/meta/types.ts`, `src/meta/client.ts`
- Test: `src/meta/client.test.ts`

- [ ] **Step 1: Write `src/meta/types.ts`**
```ts
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
  getChildren(parentId: string, edge: string, fields: string[]): Promise<GraphNode[]>;
  getInsights(objectId: string, params: Record<string, unknown>): Promise<InsightRow[]>;
  debugToken(): Promise<{ is_valid: boolean; scopes: string[] }>;
}
```

- [ ] **Step 2: Write the failing test**

`src/meta/client.test.ts`:
```ts
import { test, expect } from "bun:test";
import { MetaClient } from "./client";

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("follows cursor pagination and aggregates pages", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("after=CURSOR1")) {
      return jsonResponse({ data: [{ id: "b" }], paging: {} });
    }
    return jsonResponse({ data: [{ id: "a" }], paging: { cursors: { after: "CURSOR1" }, next: "x" } });
  };
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
  );
  const rows = await client.getChildren("act_1", "campaigns", ["id"]);
  expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("appsecret_proof=");
});

test("retries on 429 then succeeds", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return new Response("{}", { status: 429 });
    return jsonResponse({ data: [{ id: "ok" }] });
  };
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
  );
  const rows = await client.getChildren("act_1", "campaigns", ["id"]);
  expect(rows[0].id).toBe("ok");
  expect(n).toBe(2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/meta/client.test.ts`
Expected: FAIL — `./client` not found.

- [ ] **Step 4: Write the implementation**

`src/meta/client.ts`:
```ts
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

  constructor(private creds: MetaCredentials, deps: MetaClientDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = deps.maxRetries ?? 5;
  }

  private url(path: string, params: Record<string, unknown>): string {
    const qs = buildQuery({
      ...params,
      access_token: this.creds.token,
      appsecret_proof: appsecretProof(this.creds.token, this.creds.appSecret),
    });
    return `${BASE}/${this.creds.version}/${path}?${qs}`;
  }

  /** GET one page with retry/backoff; returns parsed JSON. */
  private async getPage(path: string, params: Record<string, unknown>, accountId = ""): Promise<any> {
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(this.url(path, params));
      if (res.status === 429 || res.status >= 500) {
        if (attempt++ >= this.maxRetries) throw new Error(`Meta ${res.status} after ${attempt} retries`);
        await this.sleep(backoffMs(attempt));
        continue;
      }
      const body = await res.json();
      if (body?.error) throw new Error(`Meta error ${body.error.code}: ${body.error.message}`);
      if (accountId) {
        const usage = parseUsage(res.headers, accountId);
        if (shouldBackoff(usage)) await this.sleep(Math.max(1000, usage.estimatedTimeToRegainAccess * 60_000));
      }
      return body;
    }
  }

  /** GET an edge, following cursor pagination. */
  private async getPaged(path: string, params: Record<string, unknown>, accountId = ""): Promise<GraphNode[]> {
    const out: GraphNode[] = [];
    let after: string | undefined;
    do {
      const body = await this.getPage(path, { ...params, after }, accountId);
      if (Array.isArray(body?.data)) out.push(...body.data);
      after = body?.paging?.next ? body?.paging?.cursors?.after : undefined;
    } while (after);
    return out;
  }

  getAccounts(businessId: string): Promise<GraphNode[]> {
    return this.getPaged(`${businessId}/owned_ad_accounts`, {
      fields: ["account_id", "name", "currency", "account_status"],
      limit: 200,
    });
  }

  getChildren(parentId: string, edge: string, fields: string[]): Promise<GraphNode[]> {
    return this.getPaged(`${parentId}/${edge}`, { fields, limit: 200 });
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
    const d = body?.data ?? {};
    return { is_valid: Boolean(d.is_valid), scopes: Array.isArray(d.scopes) ? d.scopes : [] };
  }
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 2 ** attempt * 250) + Math.floor(Math.random() * 250);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/meta/client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**
```bash
git add src/meta/types.ts src/meta/client.ts src/meta/client.test.ts
git commit -m "feat: Meta client with pagination and retry/backoff"
```

---

## Task 6: Insights normalization (action flattening)

**Files:**
- Create: `src/meta/insights.ts`
- Test: `src/meta/insights.test.ts`

- [ ] **Step 1: Write the failing test**

`src/meta/insights.test.ts`:
```ts
import { test, expect } from "bun:test";
import { pickAction, normalizeInsightRow } from "./insights";
import type { InsightRow } from "./types";

test("pickAction sums the matching action type and returns 0 when absent", () => {
  const actions = [
    { action_type: "omni_purchase", value: "42" },
    { action_type: "link_click", value: "7" },
  ];
  expect(pickAction(actions, "omni_purchase")).toBe(42);
  expect(pickAction(actions, "nope")).toBe(0);
});

test("normalizeInsightRow maps strings to numbers and derives conversions/roas", () => {
  const row: InsightRow = {
    date_start: "2026-06-01", date_stop: "2026-06-01", account_id: "act_1", campaign_id: "c1",
    spend: "100.5", impressions: "1000", clicks: "50", ctr: "5", cpc: "2.01", cpm: "100.5",
    actions: [{ action_type: "omni_purchase", value: "10" }],
    action_values: [{ action_type: "omni_purchase", value: "300" }],
    purchase_roas: [{ action_type: "omni_purchase", value: "2.98" }],
  };
  const n = normalizeInsightRow(row, "campaign", "c1", "act_1");
  expect(n.spend).toBeCloseTo(100.5);
  expect(n.impressions).toBe(1000);
  expect(n.conversions).toBe(10);
  expect(n.conversionValues).toBe(300);
  expect(n.purchaseRoas).toBeCloseTo(2.98);
  expect(n.entityId).toBe("c1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/meta/insights.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/meta/insights.ts`:
```ts
import type { InsightRow } from "./types";

type ActionArr = { action_type: string; value: string }[] | undefined;

/** The conversion action type we treat as "the" conversion by default (revisable; raw is kept). */
export const DEFAULT_CONVERSION_TYPE = "omni_purchase";

export function pickAction(actions: ActionArr, type: string): number {
  if (!actions) return 0;
  return actions
    .filter((a) => a.action_type === type)
    .reduce((sum, a) => sum + (Number(a.value) || 0), 0);
}

const n = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

export interface NormalizedInsight {
  level: string;
  entityId: string;
  accountId: string;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  inlineLinkClicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  conversions: number;
  conversionValues: number;
  purchaseRoas: number;
  actions: unknown;
  actionValues: unknown;
}

export function normalizeInsightRow(
  row: InsightRow,
  level: string,
  entityId: string,
  accountId: string,
): NormalizedInsight {
  return {
    level,
    entityId,
    accountId,
    date: row.date_start,
    spend: n(row.spend),
    impressions: n(row.impressions),
    reach: n(row.reach),
    clicks: n(row.clicks),
    inlineLinkClicks: n(row.inline_link_clicks),
    ctr: n(row.ctr),
    cpc: n(row.cpc),
    cpm: n(row.cpm),
    conversions: pickAction(row.actions, DEFAULT_CONVERSION_TYPE),
    conversionValues: pickAction(row.action_values, DEFAULT_CONVERSION_TYPE),
    purchaseRoas: pickAction(row.purchase_roas, DEFAULT_CONVERSION_TYPE),
    actions: row.actions ?? null,
    actionValues: row.action_values ?? null,
  };
}

/** Map a Graph object id to its insights level. */
export function levelForId(id: string): "account" | "campaign" | "adset" | "ad" {
  if (id.startsWith("act_")) return "account";
  return "campaign"; // jobs pass an explicit level; this is only a fallback
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/meta/insights.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add src/meta/insights.ts src/meta/insights.test.ts
git commit -m "feat: insight row normalization and action flattening"
```

---

## Task 7: Structure sync job

**Files:**
- Create: `src/sync/jobs/structure.ts`
- Test: `src/sync/jobs/structure.test.ts`

- [ ] **Step 1: Write the failing test** (uses a fake client + the test DB)

`src/sync/jobs/structure.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncStructure } from "./structure";
import type { GraphNode, InsightsClient } from "@/meta/types";

const fakeClient: Partial<InsightsClient> = {
  async getChildren(parentId, edge): Promise<GraphNode[]> {
    if (edge === "campaigns") return [{ id: "c1", name: "Camp 1", objective: "OUTCOME_SALES", status: "ACTIVE" }];
    if (edge === "adsets") return [{ id: "s1", name: "Set 1", status: "ACTIVE", campaign_id: "c1" }];
    if (edge === "ads") return [{ id: "a1", name: "Ad 1", status: "ACTIVE", adset_id: "s1", creative: { id: "cr1" } }];
    if (edge === "adcreatives") return [{ id: "cr1", name: "Creative 1", thumbnail_url: "http://x/y.png" }];
    return [];
  },
};

beforeEach(async () => {
  await db.execute(sql`truncate table accounts, campaigns, ad_sets, ads, ad_creatives cascade`);
  await db.insert(schema.accounts).values({ id: "act_1", name: "Acc", currency: "USD", status: "ACTIVE" });
});

test("syncs campaigns/adsets/ads/creatives and is idempotent", async () => {
  await syncStructure(fakeClient as InsightsClient, "act_1");
  await syncStructure(fakeClient as InsightsClient, "act_1"); // second run must not duplicate

  expect(await db.select().from(schema.campaigns)).toHaveLength(1);
  expect(await db.select().from(schema.adSets)).toHaveLength(1);
  const ads = await db.select().from(schema.ads);
  expect(ads).toHaveLength(1);
  expect(ads[0].creativeId).toBe("cr1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sync/jobs/structure.test.ts`
Expected: FAIL — `./structure` not found.

- [ ] **Step 3: Write the implementation**

`src/sync/jobs/structure.ts`:
```ts
import { db, schema } from "@/db/client";
import type { GraphNode, InsightsClient } from "@/meta/types";

const now = () => new Date();

export async function syncStructure(client: InsightsClient, accountId: string): Promise<void> {
  const campaigns = await client.getChildren(accountId, "campaigns", [
    "id", "name", "status", "effective_status", "objective", "daily_budget",
  ]);
  for (const c of campaigns) {
    await db
      .insert(schema.campaigns)
      .values(row(c, { accountId, name: str(c.name), objective: str(c.objective), dailyBudget: int(c.daily_budget) }))
      .onConflictDoUpdate({ target: schema.campaigns.id, set: setCols(c, { accountId, name: str(c.name), objective: str(c.objective), dailyBudget: int(c.daily_budget) }) });
  }

  const adsets = await client.getChildren(accountId, "adsets", [
    "id", "name", "status", "effective_status", "campaign_id",
  ]);
  for (const s of adsets) {
    const base = { accountId, campaignId: str(s.campaign_id), name: str(s.name) };
    await db
      .insert(schema.adSets)
      .values(row(s, base))
      .onConflictDoUpdate({ target: schema.adSets.id, set: setCols(s, base) });
  }

  const ads = await client.getChildren(accountId, "ads", [
    "id", "name", "status", "effective_status", "adset_id", "creative{id}",
  ]);
  for (const a of ads) {
    const base = { accountId, adSetId: str(a.adset_id), name: str(a.name), creativeId: creativeId(a) };
    await db
      .insert(schema.ads)
      .values(row(a, base))
      .onConflictDoUpdate({ target: schema.ads.id, set: setCols(a, base) });
  }

  const creatives = await client.getChildren(accountId, "adcreatives", ["id", "name", "thumbnail_url"]);
  for (const cr of creatives) {
    const base = { name: str(cr.name), thumbnailUrl: str(cr.thumbnail_url) };
    await db
      .insert(schema.adCreatives)
      .values({ id: cr.id, ...base, raw: cr, syncedAt: now() })
      .onConflictDoUpdate({ target: schema.adCreatives.id, set: { ...base, raw: cr, syncedAt: now() } });
  }
}

// helpers
const str = (v: unknown) => (v == null ? null : String(v));
const int = (v: unknown) => (v == null ? null : Number(v) || null);
const creativeId = (a: GraphNode) =>
  a.creative && typeof a.creative === "object" ? str((a.creative as GraphNode).id) : null;

function row(node: GraphNode, extra: Record<string, unknown>) {
  return { id: node.id, status: str(node.status), effectiveStatus: str(node.effective_status), raw: node, syncedAt: now(), ...extra };
}
function setCols(node: GraphNode, extra: Record<string, unknown>) {
  return { status: str(node.status), effectiveStatus: str(node.effective_status), raw: node, syncedAt: now(), ...extra };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sync/jobs/structure.test.ts`
Expected: PASS (1 test) — two runs leave exactly one row each.

- [ ] **Step 5: Commit**
```bash
git add src/sync/jobs/structure.ts src/sync/jobs/structure.test.ts
git commit -m "feat: structure sync job (campaigns/adsets/ads/creatives, idempotent)"
```

---

## Task 8: Insights sync job (daily, trailing window)

**Files:**
- Create: `src/sync/jobs/insights.ts`
- Test: `src/sync/jobs/insights.test.ts`

- [ ] **Step 1: Write the failing test**

`src/sync/jobs/insights.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncInsights } from "./insights";
import type { InsightRow, InsightsClient } from "@/meta/types";

function makeClient(rows: InsightRow[]): InsightsClient {
  return {
    getAccounts: async () => [],
    getChildren: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getInsights: async () => rows,
  };
}

beforeEach(async () => {
  await db.execute(sql`truncate table insights_daily cascade`);
});

test("upserts one row per (level, entity, date) and is idempotent on re-pull", async () => {
  const rows: InsightRow[] = [
    { date_start: "2026-06-01", date_stop: "2026-06-01", campaign_id: "c1", spend: "100", impressions: "10",
      actions: [{ action_type: "omni_purchase", value: "3" }] },
  ];
  const client = makeClient(rows);
  await syncInsights(client, "act_1", { level: "campaign", days: 3 });
  await syncInsights(client, "act_1", { level: "campaign", days: 3 }); // re-pull same window

  const all = await db.select().from(schema.insightsDaily);
  expect(all).toHaveLength(1);
  expect(all[0].spend).toBeCloseTo(100);
  expect(all[0].conversions).toBe(3);
  expect(all[0].level).toBe("campaign");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sync/jobs/insights.test.ts`
Expected: FAIL — `./insights` not found.

- [ ] **Step 3: Write the implementation**

`src/sync/jobs/insights.ts`:
```ts
import { db, schema } from "@/db/client";
import type { InsightRow, InsightsClient } from "@/meta/types";
import { normalizeInsightRow } from "@/meta/insights";

export type Level = "account" | "campaign" | "adset" | "ad";

const ID_FIELD: Record<Level, keyof InsightRow> = {
  account: "account_id",
  campaign: "campaign_id",
  adset: "adset_id",
  ad: "ad_id",
};

export function trailingRange(days: number, today = new Date()): { since: string; until: string } {
  const until = today.toISOString().slice(0, 10);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { since: start.toISOString().slice(0, 10), until };
}

export async function syncInsights(
  client: InsightsClient,
  accountId: string,
  opts: { level: Level; days: number; today?: Date },
): Promise<number> {
  const { since, until } = trailingRange(opts.days, opts.today);
  const rows = await client.getInsights(accountId, {
    level: opts.level,
    time_range: { since, until },
    time_increment: 1,
    fields: [
      "spend", "impressions", "reach", "clicks", "inline_link_clicks", "ctr", "cpc", "cpm",
      "actions", "action_values", "purchase_roas",
      "account_id", "campaign_id", "adset_id", "ad_id",
    ],
    use_unified_attribution_setting: true,
  });

  let written = 0;
  for (const r of rows) {
    const entityId = String(r[ID_FIELD[opts.level]] ?? accountId);
    const v = normalizeInsightRow(r, opts.level, entityId, accountId);
    await db
      .insert(schema.insightsDaily)
      .values(v)
      .onConflictDoUpdate({
        target: [schema.insightsDaily.level, schema.insightsDaily.entityId, schema.insightsDaily.date],
        set: { ...v, syncedAt: new Date() },
      });
    written++;
  }
  return written;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sync/jobs/insights.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Add a unit test for `trailingRange` and run it**

Append to `src/sync/jobs/insights.test.ts`:
```ts
import { trailingRange } from "./insights";

test("trailingRange covers `days` inclusive of today", () => {
  const { since, until } = trailingRange(3, new Date("2026-06-08T12:00:00Z"));
  expect(until).toBe("2026-06-08");
  expect(since).toBe("2026-06-06");
});
```
Run: `bun test src/sync/jobs/insights.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**
```bash
git add src/sync/jobs/insights.ts src/sync/jobs/insights.test.ts
git commit -m "feat: daily insights sync job with trailing-window upsert"
```

---

## Task 9: Breakdown sync job

**Files:**
- Create: `src/sync/jobs/breakdowns.ts`
- Test: `src/sync/jobs/breakdowns.test.ts`

- [ ] **Step 1: Write the failing test**

`src/sync/jobs/breakdowns.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { syncBreakdowns, BREAKDOWNS } from "./breakdowns";
import type { InsightRow, InsightsClient } from "@/meta/types";

function clientFor(byBreakdown: Record<string, InsightRow[]>): InsightsClient {
  return {
    getAccounts: async () => [],
    getChildren: async () => [],
    debugToken: async () => ({ is_valid: true, scopes: [] }),
    getInsights: async (_id, params: any) => byBreakdown[params.breakdowns as string] ?? [],
  };
}

beforeEach(async () => {
  await db.execute(sql`truncate table insights_breakdown_daily cascade`);
});

test("writes one row per (breakdown_type, value, date) for the age breakdown", async () => {
  const client = clientFor({
    age: [
      { date_start: "2026-06-01", date_stop: "2026-06-01", account_id: "act_1", age: "25-34", spend: "50", impressions: "5",
        actions: [{ action_type: "omni_purchase", value: "2" }] },
    ],
  });
  await syncBreakdowns(client, "act_1", { breakdowns: ["age"], days: 7 });
  const rows = await db.select().from(schema.insightsBreakdownDaily);
  expect(rows).toHaveLength(1);
  expect(rows[0].breakdownType).toBe("age");
  expect(rows[0].breakdownValue).toBe("25-34");
  expect(rows[0].conversions).toBe(2);
});

test("BREAKDOWNS lists the dashboard's audience dimensions", () => {
  expect(BREAKDOWNS).toEqual(["age", "gender", "publisher_platform", "device_platform", "country"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sync/jobs/breakdowns.test.ts`
Expected: FAIL — `./breakdowns` not found.

- [ ] **Step 3: Write the implementation**

`src/sync/jobs/breakdowns.ts`:
```ts
import { db, schema } from "@/db/client";
import type { InsightsClient } from "@/meta/types";
import { pickAction, DEFAULT_CONVERSION_TYPE } from "@/meta/insights";
import { trailingRange } from "./insights";

export const BREAKDOWNS = ["age", "gender", "publisher_platform", "device_platform", "country"] as const;
export type BreakdownType = (typeof BREAKDOWNS)[number];

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);

export async function syncBreakdowns(
  client: InsightsClient,
  accountId: string,
  opts: { breakdowns: BreakdownType[]; days: number; today?: Date },
): Promise<number> {
  const { since, until } = trailingRange(opts.days, opts.today);
  let written = 0;

  for (const breakdown of opts.breakdowns) {
    const rows = await client.getInsights(accountId, {
      level: "account",
      time_range: { since, until },
      time_increment: 1,
      breakdowns: [breakdown],
      fields: ["spend", "impressions", "clicks", "actions", "action_values"],
      use_unified_attribution_setting: true,
    });

    for (const r of rows) {
      const value = String((r as Record<string, unknown>)[breakdown] ?? "unknown");
      const v = {
        level: "account",
        entityId: accountId,
        accountId,
        date: r.date_start,
        breakdownType: breakdown,
        breakdownValue: value,
        spend: n(r.spend),
        impressions: n(r.impressions),
        clicks: n(r.clicks),
        conversions: pickAction(r.actions, DEFAULT_CONVERSION_TYPE),
        conversionValues: pickAction(r.action_values, DEFAULT_CONVERSION_TYPE),
      };
      await db
        .insert(schema.insightsBreakdownDaily)
        .values(v)
        .onConflictDoUpdate({
          target: [
            schema.insightsBreakdownDaily.level,
            schema.insightsBreakdownDaily.entityId,
            schema.insightsBreakdownDaily.date,
            schema.insightsBreakdownDaily.breakdownType,
            schema.insightsBreakdownDaily.breakdownValue,
          ],
          set: { ...v, syncedAt: new Date() },
        });
      written++;
    }
  }
  return written;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sync/jobs/breakdowns.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add src/sync/jobs/breakdowns.ts src/sync/jobs/breakdowns.test.ts
git commit -m "feat: breakdown sync job for audience dimensions"
```

---

## Task 10: Sync state + token health

**Files:**
- Create: `src/sync/state.ts`
- Test: `src/sync/state.test.ts`

- [ ] **Step 1: Write the failing test**

`src/sync/state.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { markSync, recordTokenHealth } from "./state";
import type { InsightsClient } from "@/meta/types";

beforeEach(async () => {
  await db.execute(sql`truncate table sync_state, token_health cascade`);
});

test("markSync upserts per-account status", async () => {
  await markSync("act_1", "structure", null);
  await markSync("act_1", "insights", "boom");
  const rows = await db.select().from(schema.syncState);
  expect(rows).toHaveLength(1);
  expect(rows[0].lastError).toBe("boom");
  expect(rows[0].lastStructureSync).not.toBeNull();
  expect(rows[0].lastInsightsSync).not.toBeNull();
});

test("recordTokenHealth stores debug_token result", async () => {
  const client = { debugToken: async () => ({ is_valid: true, scopes: ["ads_read"] }) } as InsightsClient;
  await recordTokenHealth(client);
  const rows = await db.select().from(schema.tokenHealth);
  expect(rows[0].isValid).toBe(true);
  expect(rows[0].scopes).toEqual(["ads_read"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sync/state.test.ts`
Expected: FAIL — `./state` not found.

- [ ] **Step 3: Write the implementation**

`src/sync/state.ts`:
```ts
import { db, schema } from "@/db/client";
import type { InsightsClient } from "@/meta/types";

type Phase = "structure" | "insights";

export async function markSync(accountId: string, phase: Phase, error: string | null): Promise<void> {
  const stamp = new Date();
  const ins = {
    accountId,
    status: error ? "error" : "ok",
    lastError: error,
    lastStructureSync: phase === "structure" ? stamp : null,
    lastInsightsSync: phase === "insights" ? stamp : null,
  };
  await db
    .insert(schema.syncState)
    .values(ins)
    .onConflictDoUpdate({
      target: schema.syncState.accountId,
      set: {
        status: ins.status,
        lastError: ins.lastError,
        ...(phase === "structure" ? { lastStructureSync: stamp } : {}),
        ...(phase === "insights" ? { lastInsightsSync: stamp } : {}),
      },
    });
}

export async function recordTokenHealth(client: InsightsClient): Promise<void> {
  let isValid = false;
  let scopes: string[] = [];
  let note: string | null = null;
  try {
    const d = await client.debugToken();
    isValid = d.is_valid;
    scopes = d.scopes;
  } catch (e) {
    note = e instanceof Error ? e.message : String(e);
  }
  await db
    .insert(schema.tokenHealth)
    .values({ id: "singleton", checkedAt: new Date(), isValid, scopes, note })
    .onConflictDoUpdate({
      target: schema.tokenHealth.id,
      set: { checkedAt: new Date(), isValid, scopes, note },
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sync/state.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add src/sync/state.ts src/sync/state.test.ts
git commit -m "feat: sync-state tracking and token-health recording"
```

---

## Task 11: Worker orchestration (`runOnce` + cron entry)

**Files:**
- Create: `src/sync/run.ts` (orchestration), `src/sync/worker.ts` (entry)
- Test: `src/sync/run.test.ts`

- [ ] **Step 1: Write the failing test** (orchestration is pure; jobs injected)

`src/sync/run.test.ts`:
```ts
import { test, expect } from "bun:test";
import { runOnce } from "./run";
import type { InsightsClient } from "@/meta/types";

test("runOnce calls each job for each account and records token health", async () => {
  const order: string[] = [];
  const fakeClient = { debugToken: async () => ({ is_valid: true, scopes: [] }) } as InsightsClient;

  await runOnce({
    client: fakeClient,
    accountIds: ["act_1", "act_2"],
    jobs: {
      structure: async (_c, id) => { order.push(`struct:${id}`); },
      insights: async (_c, id) => { order.push(`ins:${id}`); },
      breakdowns: async (_c, id) => { order.push(`bd:${id}`); },
      tokenHealth: async () => { order.push("token"); },
    },
  });

  expect(order).toEqual([
    "token",
    "struct:act_1", "ins:act_1", "bd:act_1",
    "struct:act_2", "ins:act_2", "bd:act_2",
  ]);
});

test("runOnce continues to the next account when one account throws", async () => {
  const seen: string[] = [];
  const fakeClient = { debugToken: async () => ({ is_valid: true, scopes: [] }) } as InsightsClient;
  await runOnce({
    client: fakeClient,
    accountIds: ["act_1", "act_2"],
    jobs: {
      structure: async (_c, id) => { if (id === "act_1") throw new Error("x"); seen.push(id); },
      insights: async () => {},
      breakdowns: async () => {},
      tokenHealth: async () => {},
    },
  });
  expect(seen).toEqual(["act_2"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sync/run.test.ts`
Expected: FAIL — `./run` not found.

- [ ] **Step 3: Write the orchestration**

`src/sync/run.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sync/run.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the worker entry** (not unit-tested; exercised by Task 12)

`src/sync/worker.ts`:
```ts
import cron from "node-cron";
import { env } from "@/lib/env";
import { MetaClient } from "@/meta/client";
import { syncStructure } from "./jobs/structure";
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

function makeClient(): MetaClient {
  const e = env();
  return new MetaClient({ appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, token: e.META_SYSTEM_USER_TOKEN, version: e.META_API_VERSION });
}

async function cycle() {
  const e = env();
  console.log(`[sync] cycle start: ${e.META_AD_ACCOUNT_IDS.length} accounts`);
  await runOnce({ client: makeClient(), accountIds: e.META_AD_ACCOUNT_IDS, jobs: buildJobs() });
  console.log("[sync] cycle done");
}

const runNow = process.argv.includes("--once");

if (runNow) {
  cycle().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  console.log("[sync] scheduler started (hourly)");
  cron.schedule("0 * * * *", () => { void cycle(); });
  void cycle(); // run immediately on boot
}
```

- [ ] **Step 6: Commit**
```bash
git add src/sync/run.ts src/sync/run.test.ts src/sync/worker.ts
git commit -m "feat: sync worker orchestration and scheduled entry"
```

---

## Task 12: End-to-end smoke against one live account (manual)

**Files:** none (validation only)

- [ ] **Step 1: Confirm `.env` has exactly one id in `META_AD_ACCOUNT_IDS`** and the DB is up (`docker ps` shows `meta-pg`).

- [ ] **Step 2: Run one real sync cycle**

Run: `bun run sync:once`
Expected: logs `cycle start: 1 accounts` … `cycle done` with no thrown error. (On dev tier you may see pacing pauses — that's the backoff working.)

- [ ] **Step 3: Verify rows landed**

Run:
```bash
docker exec meta-pg psql -U postgres -d meta -c "select level, count(*) from insights_daily group by level;"
docker exec meta-pg psql -U postgres -d meta -c "select count(*) from campaigns;"
docker exec meta-pg psql -U postgres -d meta -c "select is_valid, scopes from token_health;"
```
Expected: non-zero counts for `insights_daily` (at least `account` level) and `campaigns`; `token_health.is_valid = t`.

- [ ] **Step 4: Run the full test suite once**

Run: `bun test`
Expected: all Plan A tests PASS. (Lint/format are run by the reviewer across the whole change set, not here.)

- [ ] **Step 5: Commit a short run note** (optional)
```bash
git commit --allow-empty -m "test: verified one-account live sync end-to-end"
```

---

## Self-Review

- **Spec coverage:** schema (§7) → Task 2; Meta client + headers + async-ready pagination (§6.7, §9) → Tasks 3–5; insights fields + action flattening (§6.3) → Tasks 6, 8; breakdowns (§6.5) → Task 9; sync cadence + idempotency + token health (§8) → Tasks 8–11; Phase 0 prerequisites → Task 0. Deploy (§11) is intentionally deferred to Plan B (it co-deploys with the web app).
- **Placeholders:** none; every code step is complete.
- **Type consistency:** `InsightsClient` (Task 5) is implemented by `MetaClient` and consumed by all jobs; `normalizeInsightRow`/`pickAction`/`DEFAULT_CONVERSION_TYPE` (Task 6) reused in Tasks 8–9; `trailingRange` (Task 8) reused in Task 9; `markSync`/`recordTokenHealth` (Task 10) used in Task 11; `runOnce`/`Jobs` (Task 11) used by the worker.
- **Deferred to Plan B:** async report-job fallback for heavy/historical backfill is stubbed by the synchronous path here; add it in Plan B (or a Task 13) once one-account sync is proven and Standard Access lands. Flagged in §14 of the spec.
