# Meta Frontend Wiring (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the dashboard's `src/lib/mock-data.ts` with live data read from Postgres (populated by the Plan A worker), via TanStack Start server functions; add the credentials Settings page; fix the `/accounts/$id` routing bug; then deploy to the droplet.

**Architecture:** Each route loads data in a `loader` that calls a `createServerFn` handler. Server functions query Postgres (Drizzle) and return the **exact shapes the existing components already consume** (`AdAccount`, `Campaign`, breakdown rows, KPI aggregate, daily series), so components change minimally. Metrics are aggregated from `insights_daily` / `insights_breakdown_daily` over a rolling window; structure (names, objectives, nesting) comes from the structure tables. Secrets never reach the client. Deploy = web + worker under systemd, nginx + Basic Auth + Let's Encrypt.

**Tech Stack:** TanStack Start (`createServerFn`), TanStack Router loaders, Drizzle (`src/db`), Bun, existing shadcn components.

**Companion spec:** `docs/superpowers/specs/2026-06-08-meta-marketing-api-integration-design.md` (§10, §11). Plan A (already implemented) provides `src/db/schema.ts`, `src/db/client.ts` (`db`, `schema`), `src/lib/credentials.ts` (`getCredentials`, `saveCredentials`, `Credentials`), `src/meta/client.ts` (`MetaClient`).

**Conventions**
- Tests: `bun test`. DB-backed tests run against the droplet Postgres via the running SSH tunnel; they seed rows then assert.
- Server fns are server-only (they import `@/db/client`). Default window for aggregates: **last 30 days** (`WINDOW_DAYS = 30`).
- STRICT ESLint: no `any` (use `unknown`), `Promise.withResolvers`. Skip project-wide tsc/lint during tasks; controller runs gates at the end.
- Commit after each task with the message shown.

---

## Task B1: Extract shared types + formatters (decouple from mock-data)

**Files:** Create `src/lib/types.ts`, `src/lib/format.ts`; Test `src/lib/format.test.ts`

Components currently import types and `fmt*` from `mock-data.ts`. Move them to standalone modules so deleting mock-data is clean.

- [ ] **Step 1: Write `src/lib/types.ts`** (copy the interfaces verbatim from `mock-data.ts`, no data)
```ts
export type AccountStatus = "ACTIVE" | "PAUSED" | "DISABLED" | "PENDING";
export type CampaignObjective =
  | "CONVERSIONS" | "TRAFFIC" | "REACH" | "VIDEO_VIEWS"
  | "APP_INSTALLS" | "LEAD_GEN" | "BRAND_AWARENESS";
export type CampaignStatus = "ACTIVE" | "PAUSED" | "LEARNING" | "COMPLETED";

export interface AdAccount {
  id: string; name: string; currency: string; status: AccountStatus;
  spend: number; impressions: number; clicks: number; conversions: number;
  revenue: number; ctr: number; cpc: number; cpm: number; roas: number;
  reach: number; frequency: number; spark: number[];
}
export interface Ad {
  id: string; name: string; status: CampaignStatus; spend: number;
  impressions: number; ctr: number; cpc: number; roas: number; conversions: number;
  format: "Image" | "Video" | "Carousel" | "Collection"; thumbHue: number; thumbnailUrl?: string | null;
}
export interface AdSet {
  id: string; name: string; status: CampaignStatus; spend: number;
  ctr: number; roas: number; audience: string; ads: Ad[];
}
export interface Campaign {
  id: string; name: string; status: CampaignStatus; objective: CampaignObjective;
  accountId: string; accountName: string; spend: number; impressions: number;
  conversions: number; ctr: number; cpc: number; cpm: number; roas: number; adSets: AdSet[];
}
export interface CreativeCard extends Ad { campaign: string; account: string; }
export interface BreakdownRow { label: string; spend: number; conversions: number; roas: number; }
export interface Kpis {
  spend: number; impressions: number; clicks: number; conversions: number; revenue: number;
  reach: number; ctr: number; cpc: number; cpm: number; roas: number; frequency: number;
}
export interface TrendPoint { date: string; spend: number; conversions: number; revenue: number; }
```

- [ ] **Step 2: Write the failing test for formatters**

`src/lib/format.test.ts`:
```ts
import { test, expect } from "bun:test";
import { fmtCurrency, fmtNumber, fmtCompact, fmtPct } from "./format";

test("formatters match the previous mock-data behavior", () => {
  expect(fmtCurrency(1500)).toBe("$1,500");
  expect(fmtNumber(12345)).toBe("12,345");
  expect(fmtCompact(1500000)).toBe("1.5M");
  expect(fmtPct(3.14159)).toBe("3.14%");
});
```

- [ ] **Step 3: Run test to verify it fails** — `bun test src/lib/format.test.ts` → FAIL (module missing).

- [ ] **Step 4: Write `src/lib/format.ts`** (copy the four `fmt*` fns verbatim from `mock-data.ts` lines 292-305)
```ts
export function fmtCurrency(n: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);
}
export function fmtNumber(n: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}
export function fmtCompact(n: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
export function fmtPct(n: number, digits = 2) {
  return `${n.toFixed(digits)}%`;
}
```

- [ ] **Step 5: Run test to verify it passes** — `bun test src/lib/format.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git add src/lib/types.ts src/lib/format.ts src/lib/format.test.ts && git commit -m "feat: extract shared types and formatters from mock-data"`

---

## Task B2: Aggregation helpers + dashboard server functions

**Files:** Create `src/server/agg.ts`, `src/server/fns/dashboard.ts`; Test `src/server/fns/dashboard.test.ts`

Server functions query Postgres and return the component shapes. `agg.ts` holds the derived-metric math (shared, pure, unit-testable without a DB).

- [ ] **Step 1: Write the failing test for the pure metric math**

`src/server/fns/dashboard.test.ts`:
```ts
import { test, expect } from "bun:test";
import { deriveKpis, deriveRoas } from "@/server/agg";

test("deriveKpis computes ratios from summed totals", () => {
  const k = deriveKpis({ spend: 100, impressions: 1000, clicks: 50, conversions: 10, revenue: 300, reach: 800 });
  expect(k.ctr).toBeCloseTo(5);      // 50/1000*100
  expect(k.cpc).toBeCloseTo(2);      // 100/50
  expect(k.cpm).toBeCloseTo(100);    // 100/1000*1000
  expect(k.roas).toBeCloseTo(3);     // 300/100
  expect(k.frequency).toBeCloseTo(1.25); // 1000/800
});

test("deriveRoas guards divide-by-zero", () => {
  expect(deriveRoas(0, 0)).toBe(0);
  expect(deriveRoas(300, 100)).toBeCloseTo(3);
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test src/server/fns/dashboard.test.ts` → FAIL.

- [ ] **Step 3: Write `src/server/agg.ts`**
```ts
import type { Kpis } from "@/lib/types";

export interface Totals {
  spend: number; impressions: number; clicks: number;
  conversions: number; revenue: number; reach: number;
}

const div = (a: number, b: number): number => (b > 0 ? a / b : 0);
export const deriveRoas = (revenue: number, spend: number): number => div(revenue, spend);

export function deriveKpis(t: Totals): Kpis {
  return {
    ...t,
    ctr: div(t.clicks, t.impressions) * 100,
    cpc: div(t.spend, t.clicks),
    cpm: div(t.spend, t.impressions) * 1000,
    roas: div(t.revenue, t.spend),
    frequency: div(t.impressions, t.reach),
  };
}

/** Window start as YYYY-MM-DD, `days` before `today` (inclusive). */
export function windowStart(days: number, today = new Date()): string {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test src/server/fns/dashboard.test.ts` → PASS (2 tests).

- [ ] **Step 5: Write `src/server/fns/dashboard.ts`** (server functions; queries Postgres)
```ts
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { deriveKpis, windowStart, type Totals } from "@/server/agg";
import type { AdAccount, BreakdownRow, Campaign, CreativeCard, Kpis, TrendPoint } from "@/lib/types";

const WINDOW_DAYS = 30;
const SPARK_DAYS = 14;

const num = (v: unknown): number => Number(v ?? 0);

/** Summed insight totals grouped by entity, for a level over the window. */
function totalsByEntity(level: string, since: string) {
  return db
    .select({
      entityId: schema.insightsDaily.entityId,
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
      impressions: sql<number>`coalesce(sum(${schema.insightsDaily.impressions}),0)`,
      clicks: sql<number>`coalesce(sum(${schema.insightsDaily.clicks}),0)`,
      conversions: sql<number>`coalesce(sum(${schema.insightsDaily.conversions}),0)`,
      revenue: sql<number>`coalesce(sum(${schema.insightsDaily.conversionValues}),0)`,
      reach: sql<number>`coalesce(max(${schema.insightsDaily.reach}),0)`,
    })
    .from(schema.insightsDaily)
    .where(and(eq(schema.insightsDaily.level, level), gte(schema.insightsDaily.date, since)))
    .groupBy(schema.insightsDaily.entityId);
}

export const listAccounts = createServerFn({ method: "GET" }).handler(async (): Promise<AdAccount[]> => {
  const since = windowStart(WINDOW_DAYS);
  const accounts = await db.select().from(schema.accounts);
  const totals = await totalsByEntity("account", since);
  const totalsById = new Map(totals.map((t) => [t.entityId, t]));

  // daily spend per account for sparklines
  const sparkSince = windowStart(SPARK_DAYS);
  const sparkRows = await db
    .select({
      entityId: schema.insightsDaily.entityId,
      date: schema.insightsDaily.date,
      spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
    })
    .from(schema.insightsDaily)
    .where(and(eq(schema.insightsDaily.level, "account"), gte(schema.insightsDaily.date, sparkSince)))
    .groupBy(schema.insightsDaily.entityId, schema.insightsDaily.date)
    .orderBy(schema.insightsDaily.date);
  const sparkById = new Map<string, number[]>();
  for (const r of sparkRows) {
    const arr = sparkById.get(r.entityId) ?? [];
    arr.push(Math.round(num(r.spend)));
    sparkById.set(r.entityId, arr);
  }

  return accounts.map((a) => {
    const t = totalsById.get(a.id);
    const totals: Totals = {
      spend: num(t?.spend), impressions: num(t?.impressions), clicks: num(t?.clicks),
      conversions: num(t?.conversions), revenue: num(t?.revenue), reach: num(t?.reach),
    };
    const k = deriveKpis(totals);
    return {
      id: a.id, name: a.name, currency: a.currency,
      status: (a.status ?? "ACTIVE") as AdAccount["status"],
      ...k, spark: sparkById.get(a.id) ?? [],
    };
  });
});

export const getOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ kpis: Kpis; topAccounts: AdAccount[]; topCampaigns: Campaign[]; trend: TrendPoint[] }> => {
    const since = windowStart(WINDOW_DAYS);
    const accounts = await listAccounts();
    const totals: Totals = accounts.reduce(
      (s, a) => ({
        spend: s.spend + a.spend, impressions: s.impressions + a.impressions, clicks: s.clicks + a.clicks,
        conversions: s.conversions + a.conversions, revenue: s.revenue + a.revenue, reach: s.reach + a.reach,
      }),
      { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, reach: 0 },
    );
    const trendRows = await db
      .select({
        date: schema.insightsDaily.date,
        spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
        conversions: sql<number>`coalesce(sum(${schema.insightsDaily.conversions}),0)`,
        revenue: sql<number>`coalesce(sum(${schema.insightsDaily.conversionValues}),0)`,
      })
      .from(schema.insightsDaily)
      .where(and(eq(schema.insightsDaily.level, "account"), gte(schema.insightsDaily.date, since)))
      .groupBy(schema.insightsDaily.date)
      .orderBy(schema.insightsDaily.date);
    const campaigns = await listCampaigns();
    return {
      kpis: deriveKpis(totals),
      topAccounts: [...accounts].sort((a, b) => b.spend - a.spend).slice(0, 6),
      topCampaigns: [...campaigns].sort((a, b) => b.roas - a.roas).slice(0, 5),
      trend: trendRows.map((r) => ({ date: r.date, spend: num(r.spend), conversions: num(r.conversions), revenue: num(r.revenue) })),
    };
  },
);

export const listCampaigns = createServerFn({ method: "GET" }).handler(async (): Promise<Campaign[]> => {
  const since = windowStart(WINDOW_DAYS);
  const [campaignRows, adsetRows, adRows, accountRows, campTotals, adTotals] = await Promise.all([
    db.select().from(schema.campaigns),
    db.select().from(schema.adSets),
    db.select().from(schema.ads),
    db.select().from(schema.accounts),
    totalsByEntity("campaign", since),
    totalsByEntity("ad", since),
  ]);
  const accName = new Map(accountRows.map((a) => [a.id, a.name]));
  const campT = new Map(campTotals.map((t) => [t.entityId, t]));
  const adT = new Map(adTotals.map((t) => [t.entityId, t]));

  const adsByAdset = new Map<string, typeof adRows>();
  for (const ad of adRows) {
    const arr = adsByAdset.get(ad.adSetId) ?? [];
    arr.push(ad); adsByAdset.set(ad.adSetId, arr);
  }
  const adsetsByCampaign = new Map<string, typeof adsetRows>();
  for (const s of adsetRows) {
    const arr = adsetsByCampaign.get(s.campaignId) ?? [];
    arr.push(s); adsetsByCampaign.set(s.campaignId, arr);
  }

  return campaignRows.map((c) => {
    const t = campT.get(c.id);
    const k = deriveKpis({
      spend: num(t?.spend), impressions: num(t?.impressions), clicks: num(t?.clicks),
      conversions: num(t?.conversions), revenue: num(t?.revenue), reach: num(t?.reach),
    });
    const adSets = (adsetsByCampaign.get(c.id) ?? []).map((s) => {
      const ads = (adsByAdset.get(s.id) ?? []).map((ad) => {
        const at = adT.get(ad.id);
        const ak = deriveKpis({
          spend: num(at?.spend), impressions: num(at?.impressions), clicks: num(at?.clicks),
          conversions: num(at?.conversions), revenue: num(at?.revenue), reach: num(at?.reach),
        });
        return {
          id: ad.id, name: ad.name, status: (ad.status ?? "ACTIVE") as Campaign["status"],
          spend: ak.spend, impressions: ak.impressions, ctr: ak.ctr, cpc: ak.cpc, roas: ak.roas,
          conversions: ak.conversions, format: "Image" as const, thumbHue: 210, thumbnailUrl: null,
        };
      });
      return {
        id: s.id, name: s.name, status: (s.status ?? "ACTIVE") as Campaign["status"],
        spend: ads.reduce((x, a) => x + a.spend, 0),
        ctr: ads.length ? ads.reduce((x, a) => x + a.ctr, 0) / ads.length : 0,
        roas: ads.length ? ads.reduce((x, a) => x + a.roas, 0) / ads.length : 0,
        audience: s.name, ads,
      };
    });
    return {
      id: c.id, name: c.name, status: (c.status ?? "ACTIVE") as Campaign["status"],
      objective: (c.objective ?? "CONVERSIONS") as Campaign["objective"],
      accountId: c.accountId, accountName: accName.get(c.accountId) ?? c.accountId,
      spend: k.spend, impressions: k.impressions, conversions: k.conversions,
      ctr: k.ctr, cpc: k.cpc, cpm: k.cpm, roas: k.roas, adSets,
    };
  });
});

export const getAccount = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<{ account: AdAccount; campaigns: Campaign[]; trend: TrendPoint[] } | null> => {
    const accounts = await listAccounts();
    const account = accounts.find((a) => a.id === id);
    if (!account) return null;
    const since = windowStart(WINDOW_DAYS);
    const allCampaigns = await listCampaigns();
    const trendRows = await db
      .select({
        date: schema.insightsDaily.date,
        spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}),0)`,
        conversions: sql<number>`coalesce(sum(${schema.insightsDaily.conversions}),0)`,
        revenue: sql<number>`coalesce(sum(${schema.insightsDaily.conversionValues}),0)`,
      })
      .from(schema.insightsDaily)
      .where(and(eq(schema.insightsDaily.level, "account"), eq(schema.insightsDaily.entityId, id), gte(schema.insightsDaily.date, since)))
      .groupBy(schema.insightsDaily.date)
      .orderBy(schema.insightsDaily.date);
    return {
      account,
      campaigns: allCampaigns.filter((c) => c.accountId === id),
      trend: trendRows.map((r) => ({ date: r.date, spend: num(r.spend), conversions: num(r.conversions), revenue: num(r.revenue) })),
    };
  });

export const listCreatives = createServerFn({ method: "GET" }).handler(async (): Promise<CreativeCard[]> => {
  const campaigns = await listCampaigns();
  const out: CreativeCard[] = [];
  for (const c of campaigns) {
    for (const s of c.adSets) {
      for (const ad of s.ads) out.push({ ...ad, campaign: c.name, account: c.accountName });
    }
  }
  return out.sort((a, b) => b.spend - a.spend).slice(0, 36);
});

export const getBreakdowns = createServerFn({ method: "GET" }).handler(
  async (): Promise<Record<"age" | "gender" | "publisher_platform" | "device_platform" | "country", BreakdownRow[]>> => {
    const since = windowStart(WINDOW_DAYS);
    const rows = await db
      .select({
        breakdownType: schema.insightsBreakdownDaily.breakdownType,
        breakdownValue: schema.insightsBreakdownDaily.breakdownValue,
        spend: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.spend}),0)`,
        conversions: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.conversions}),0)`,
        revenue: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.conversionValues}),0)`,
      })
      .from(schema.insightsBreakdownDaily)
      .where(gte(schema.insightsBreakdownDaily.date, since))
      .groupBy(schema.insightsBreakdownDaily.breakdownType, schema.insightsBreakdownDaily.breakdownValue);
    const empty = { age: [], gender: [], publisher_platform: [], device_platform: [], country: [] } as Record<string, BreakdownRow[]>;
    for (const r of rows) {
      (empty[r.breakdownType] ??= []).push({
        label: r.breakdownValue, spend: num(r.spend), conversions: num(r.conversions),
        roas: num(r.revenue) / Math.max(1, num(r.spend)),
      });
    }
    for (const k of Object.keys(empty)) empty[k].sort((a, b) => b.spend - a.spend);
    return empty as Record<"age" | "gender" | "publisher_platform" | "device_platform" | "country", BreakdownRow[]>;
  },
);
```

- [ ] **Step 6: Add a DB-backed integration test** (seed rows, assert aggregation)

Append to `src/server/fns/dashboard.test.ts`:
```ts
import { beforeEach } from "bun:test";
import { sql as dsql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { listAccounts } from "./dashboard";

beforeEach(async () => {
  await db.execute(dsql`truncate table accounts, insights_daily cascade`);
});

test("listAccounts aggregates insights_daily into KPIs", async () => {
  const today = new Date().toISOString().slice(0, 10);
  await db.insert(schema.accounts).values({ id: "act_1", name: "Acc", currency: "USD", status: "ACTIVE" });
  await db.insert(schema.insightsDaily).values([
    { level: "account", entityId: "act_1", date: today, accountId: "act_1", spend: 100, impressions: 1000, clicks: 50, conversions: 10, conversionValues: 300, reach: 800 },
  ]);
  const accts = await listAccounts();
  const a = accts.find((x) => x.id === "act_1")!;
  expect(a.spend).toBeCloseTo(100);
  expect(a.roas).toBeCloseTo(3);     // 300/100
  expect(a.ctr).toBeCloseTo(5);      // 50/1000*100
  expect(a.spark.length).toBeGreaterThan(0);
});
```

- [ ] **Step 7: Run tests** — `bun test src/server/fns/dashboard.test.ts` → PASS (3 tests).

- [ ] **Step 8: Commit** — `git add src/server/agg.ts src/server/fns/dashboard.ts src/server/fns/dashboard.test.ts && git commit -m "feat: dashboard server functions backed by Postgres aggregation"`

---

## Task B3: Settings server functions (credentials + health)

**Files:** Create `src/server/fns/settings.ts`; Test `src/server/fns/settings.test.ts`

- [ ] **Step 1: Write the failing test**

`src/server/fns/settings.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getSettings, saveCredentialsForm } from "./settings";

beforeEach(async () => {
  await db.execute(sql`truncate table meta_credentials, token_health, sync_state cascade`);
});

test("getSettings masks secrets and reports presence", async () => {
  await saveCredentialsForm({ data: { appId: "111", appSecret: "shh", token: "tok", businessId: "999", accountIds: "act_1, act_2" } });
  const s = await getSettings();
  expect(s.appId).toBe("111");
  expect(s.businessId).toBe("999");
  expect(s.accountIds).toEqual(["act_1", "act_2"]);
  expect(s.hasSecret).toBe(true);
  expect(s.hasToken).toBe(true);
  // never leaks plaintext secrets
  expect(JSON.stringify(s)).not.toContain("shh");
  expect(JSON.stringify(s)).not.toContain("tok");
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test src/server/fns/settings.test.ts` → FAIL.

- [ ] **Step 3: Write `src/server/fns/settings.ts`**
```ts
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getCredentials, saveCredentials } from "@/lib/credentials";
import { MetaClient } from "@/meta/client";

export interface SettingsView {
  appId: string; businessId: string; accountIds: string[]; apiVersion: string;
  hasSecret: boolean; hasToken: boolean;
  token: { isValid: boolean; scopes: string[]; checkedAt: string | null } | null;
  sync: { accounts: number; lastInsightsSync: string | null; errors: number } | null;
}

export const getSettings = createServerFn({ method: "GET" }).handler(async (): Promise<SettingsView> => {
  const [cred] = await db.select().from(schema.metaCredentials).where(eq(schema.metaCredentials.id, "singleton"));
  const [health] = await db.select().from(schema.tokenHealth).where(eq(schema.tokenHealth.id, "singleton"));
  const states = await db.select().from(schema.syncState);
  return {
    appId: cred?.appId ?? "",
    businessId: cred?.businessId ?? "",
    accountIds: (cred?.accountIds as string[] | null) ?? [],
    apiVersion: cred?.apiVersion ?? "v25.0",
    hasSecret: Boolean(cred?.appSecretEnc),
    hasToken: Boolean(cred?.systemUserTokenEnc),
    token: health
      ? { isValid: health.isValid, scopes: (health.scopes as string[] | null) ?? [], checkedAt: health.checkedAt?.toISOString() ?? null }
      : null,
    sync: states.length
      ? {
          accounts: states.length,
          lastInsightsSync: states.map((s) => s.lastInsightsSync?.toISOString() ?? "").sort().at(-1) || null,
          errors: states.filter((s) => s.status === "error").length,
        }
      : null,
  };
});

interface CredsForm { appId: string; appSecret?: string; token?: string; businessId: string; accountIds: string; }

export const saveCredentialsForm = createServerFn({ method: "POST" })
  .validator((d: CredsForm) => d)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const existing = await getCredentials();
    // Secrets are write-only from the UI: keep the stored secret if the field is left blank.
    const appSecret = data.appSecret?.trim() || existing?.appSecret || "";
    const token = data.token?.trim() || existing?.token || "";
    await saveCredentials({
      appId: data.appId.trim(),
      appSecret,
      token,
      businessId: data.businessId.trim(),
      accountIds: data.accountIds.split(",").map((s) => s.trim()).filter(Boolean),
    });
    return { ok: true };
  });

export const testConnection = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ isValid: boolean; scopes: string[]; error?: string }> => {
    const creds = await getCredentials();
    if (!creds) return { isValid: false, scopes: [], error: "No credentials saved" };
    try {
      const client = new MetaClient({ appId: creds.appId, appSecret: creds.appSecret, token: creds.token, version: creds.apiVersion });
      const d = await client.debugToken();
      await db.insert(schema.tokenHealth)
        .values({ id: "singleton", checkedAt: new Date(), isValid: d.is_valid, scopes: d.scopes, note: null })
        .onConflictDoUpdate({ target: schema.tokenHealth.id, set: { checkedAt: new Date(), isValid: d.is_valid, scopes: d.scopes, note: null } });
      return { isValid: d.is_valid, scopes: d.scopes };
    } catch (e) {
      return { isValid: false, scopes: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
);
```

- [ ] **Step 4: Run test to verify it passes** — `bun test src/server/fns/settings.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add src/server/fns/settings.ts src/server/fns/settings.test.ts && git commit -m "feat: settings server functions (masked credentials, test connection)"`

---

## Task B4: Wire routes to loaders + fix `/accounts/$id`

**Files:** Modify `src/routes/{index,campaigns,creatives,audiences}.tsx`, `src/routes/accounts.$id.tsx`; rename `src/routes/accounts.tsx` → `src/routes/accounts.index.tsx`; Modify all to import types/formatters from `@/lib/types` + `@/lib/format`.

Pattern for every data route: add a `loader` that calls the server fn, replace the `mock-data` import with `Route.useLoaderData()`, and import `fmt*`/types from the new modules. Client-side filter/sort stays.

- [ ] **Step 1: Fix the routing bug** — rename the file so list + detail are sibling leaves.
```bash
git mv src/routes/accounts.tsx src/routes/accounts.index.tsx
```
Then in `accounts.index.tsx` change the route id `createFileRoute("/accounts")` → `createFileRoute("/accounts/")`, add a `loader: async () => ({ accounts: await listAccounts() })` (import `listAccounts` from `@/server/fns/dashboard`), and replace the `accounts` mock import with `const { accounts } = Route.useLoaderData()`. Import `fmt*` from `@/lib/format`, types from `@/lib/types`. Run `bun run dev` is not needed; rely on the browser smoke in Task B6.

- [ ] **Step 2: `index.tsx`** — add `loader: async () => await getOverview()`; replace mock imports. Use `const { kpis, topAccounts, topCampaigns, trend } = Route.useLoaderData()`. Replace `aggregate(accounts)` usages with `kpis`, `accounts`-derived lists with `topAccounts`/`topCampaigns`, `timeSeries` with `trend`. KPI sparkline arrays that were hardcoded inline may stay as-is (decorative) or be dropped. Import `fmt*` from `@/lib/format`. The `placementBreakdown` mini-panel on overview: load via `getBreakdowns()` in the same loader and pass `breakdowns.publisher_platform` (or drop that panel if empty-tolerant).

- [ ] **Step 3: `accounts.$id.tsx`** — replace the mock loader with:
```ts
import { getAccount } from "@/server/fns/dashboard";
// in route options:
loader: async ({ params }) => {
  const data = await getAccount({ data: params.id });
  if (!data) throw notFound();
  return data;
},
```
Component: `const { account, campaigns, trend } = Route.useLoaderData()`. This also resolves the TS2339 `useLoaderData` error once the parent is an index route. Import `fmt*`/types from the new modules.

- [ ] **Step 4: `campaigns.tsx`** — add `loader: async () => ({ campaigns: await listCampaigns() })`; `const { campaigns } = Route.useLoaderData()`; keep the client-side objective/search filtering. Swap imports.

- [ ] **Step 5: `creatives.tsx`** — add `loader: async () => ({ creatives: await listCreatives() })`; `const { creatives } = Route.useLoaderData()`. The card currently builds a CSS gradient from `thumbHue`; keep that as the fallback, but when `c.thumbnailUrl` is set, render `<img src={c.thumbnailUrl} className="absolute inset-0 size-full object-cover" />` over the gradient. Swap imports.

- [ ] **Step 6: `audiences.tsx`** — add `loader: async () => await getBreakdowns()`; `const breakdowns = Route.useLoaderData()`; pass `breakdowns.age`, `breakdowns.gender`, `breakdowns.publisher_platform` (Placement panel), `breakdowns.device_platform` (Device panel), `breakdowns.country`. Swap imports.

- [ ] **Step 7: Verify routing + loaders compile** — `bunx tsc --noEmit` should now have **zero** errors (the `accounts.$id` error is resolved by the rename). Fix any import errors. Commit:
```bash
git add src/routes && git commit -m "feat: wire routes to DB-backed server functions; fix /accounts/\$id routing"
```

---

## Task B5: Credentials Settings page

**Files:** Rewrite `src/routes/settings.tsx`

Replace the mock placeholder with a real credentials form (secrets write-only & masked), a "Test connection" action, and token-health + sync status. Remove the fake "Team access" section (no app RBAC — nginx Basic Auth gates access).

- [ ] **Step 1: Rewrite `settings.tsx`**
```tsx
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getSettings, saveCredentialsForm, testConnection } from "@/server/fns/settings";
import { CheckCircle2, KeyRound, RefreshCw, XCircle } from "lucide-react";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings — MetaConsole" }] }),
  loader: async () => await getSettings(),
  component: Settings,
});

function Settings() {
  const s = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState({ appId: s.appId, appSecret: "", token: "", businessId: s.businessId, accountIds: s.accountIds.join(", ") });
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const onSave = async () => {
    setSaving(true);
    await saveCredentialsForm({ data: form });
    setSaving(false);
    setForm((f) => ({ ...f, appSecret: "", token: "" }));
    await router.invalidate();
  };
  const onTest = async () => {
    setTestResult("Testing…");
    const r = await testConnection();
    setTestResult(r.isValid ? `Valid · scopes: ${r.scopes.join(", ") || "none"}` : `Invalid: ${r.error ?? "token rejected"}`);
    await router.invalidate();
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-3xl">
      <PageHeader title="Settings" description="Meta Marketing API credentials and sync status." />

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center"><KeyRound className="size-4 text-primary" /></div>
          <h3 className="text-sm font-semibold flex-1">System User Credentials</h3>
          {s.token && (
            <span className={`inline-flex items-center gap-1 text-xs font-medium ${s.token.isValid ? "text-success" : "text-destructive"}`}>
              {s.token.isValid ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
              {s.token.isValid ? "Connected" : "Invalid"}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input label="App ID" value={form.appId} onChange={(v) => setForm({ ...form, appId: v })} />
          <Input label="Business Manager ID" value={form.businessId} onChange={(v) => setForm({ ...form, businessId: v })} />
          <Input label={`App Secret ${s.hasSecret ? "(set — leave blank to keep)" : ""}`} type="password" value={form.appSecret} onChange={(v) => setForm({ ...form, appSecret: v })} />
          <Input label={`System User Token ${s.hasToken ? "(set — leave blank to keep)" : ""}`} type="password" value={form.token} onChange={(v) => setForm({ ...form, token: v })} />
          <div className="col-span-2"><Input label="Ad account IDs (comma-separated; blank = all owned)" value={form.accountIds} onChange={(v) => setForm({ ...form, accountIds: v })} /></div>
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button onClick={onSave} disabled={saving} className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50">{saving ? "Saving…" : "Save credentials"}</button>
          <button onClick={onTest} className="h-9 px-4 rounded-md border border-border text-xs font-medium">Test connection</button>
          {testResult && <span className="text-xs text-muted-foreground">{testResult}</span>}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center"><RefreshCw className="size-4 text-primary" /></div>
          <h3 className="text-sm font-semibold">Sync status</h3>
        </div>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <Field label="Accounts tracked" value={s.sync ? String(s.sync.accounts) : "—"} />
          <Field label="Last insights sync" value={s.sync?.lastInsightsSync ?? "never"} />
          <Field label="Accounts in error" value={s.sync ? String(s.sync.errors) : "—"} />
          <Field label="API version" value={s.apiVersion} />
        </div>
      </section>
    </div>
  );
}

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-mono" />
    </label>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (<div><div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div><div className="font-mono mt-1 truncate">{value}</div></div>);
}
```

- [ ] **Step 2: Verify** — `bunx tsc --noEmit` clean. Commit:
```bash
git add src/routes/settings.tsx && git commit -m "feat: credentials Settings page (save, test connection, sync status)"
```

---

## Task B6: Delete mock-data + full verification

- [ ] **Step 1: Confirm nothing imports mock-data**

Run: `bun run -e "true"` then search the repo: there must be **no** remaining `from "@/lib/mock-data"` imports (controller will `search` for it). If any remain, fix them to use `@/lib/types` / `@/lib/format` / server fns.

- [ ] **Step 2: Delete the file**
```bash
git rm src/lib/mock-data.ts
```

- [ ] **Step 3: Full gate**

Run: `bunx tsc --noEmit` → **zero errors**. Run: `bun test` → all green. Commit:
```bash
git commit -am "chore: remove mock-data; dashboard fully DB-backed"
```

- [ ] **Step 4: Browser smoke (controller)** — start `bun run dev`, seed a few rows into the droplet DB (or run the live sync once creds exist), and confirm every route renders DB-backed data with no console errors, and `/accounts/<id>` now shows the **detail** page (routing fixed). With an empty DB, routes must render gracefully (empty states, no crashes).

---

## Task B7: Deploy to the droplet (GATED on a subdomain)

**Prereq from the user:** a subdomain pointed at `159.65.110.111` (A record), e.g. `meta.<yourdomain>`. Until then, B1–B6 stand alone (the app runs locally against the droplet DB).

- [ ] **Step 1: Push the branch to the droplet** (bare repo + worktree, or clone from GitHub) into `/opt/meta-dashboard`, `bun install`, `bun run build`.
- [ ] **Step 2: systemd units** — `meta-web.service` (`bun run start`/Nitro output) and `meta-sync.service` (`bun run sync`), both with `EnvironmentFile=/opt/meta-dashboard/.env` (DATABASE_URL=local socket/127.0.0.1, APP_ENCRYPTION_KEY). `WantedBy=multi-user.target`, `Restart=always`.
- [ ] **Step 3: nginx** — server block for the subdomain proxying to the web app's port; `auth_basic` + `/etc/nginx/.htpasswd` (create with `htpasswd -c`). `ufw` already allows 80/443.
- [ ] **Step 4: TLS** — `certbot --nginx -d meta.<domain>`.
- [ ] **Step 5: Verify** — visit the subdomain (Basic Auth prompt → dashboard), confirm the worker service is active and a sync cycle ran (`journalctl -u meta-sync`).

---

## Self-Review

- **Spec coverage (§10):** server fns return existing shapes → B2/B3; loaders + routing fix → B4; Settings credentials management → B5; delete mock-data → B6; deploy + Basic Auth → B7. §11 ops → B7.
- **Placeholders:** none; server-fn code is complete. Per-route edits in B4 specify the exact loader + import change (the components already exist; only data source changes).
- **Type consistency:** `AdAccount`/`Campaign`/`AdSet`/`Ad`/`BreakdownRow`/`Kpis`/`TrendPoint` (B1) are returned by the B2/B3 server fns and consumed by the B4/B5 routes; `deriveKpis`/`windowStart` (B2) reused across server fns.
- **Verification reality:** B2/B3 are unit+integration tested against seeded DB rows. B4/B5 are typecheck + browser-smoke verified. End-to-end "real Meta data on screen" requires the Plan A live sync (credentials) — the same blocker as Plan A Task 12. B7 requires a subdomain.
