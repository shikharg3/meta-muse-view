# Reports Catalog & Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two hand-maintained report column maps with one descriptor catalog, grow the
column set from 22 to ~150 using data already in the database, and add 20 date presets — all behind
the existing UI, with today's 22 columns producing identical numbers.

**Architecture:** A client-safe descriptor registry (`src/lib/report-catalog.ts`) declares every
metric as data: a key, label, group, format kind, and a tagged `MetricSource` saying where the number
comes from. The engine gains one generic resolver over those descriptors, replacing `VALUE_FNS`, and
`Agg` becomes maps keyed by field name instead of eight fixed properties — which is what makes the
totals row structurally unable to disagree with the data rows. Cost metrics are `derived` over spend
by construction, so markup can never be bypassed.

**Tech Stack:** TypeScript, TanStack Start, Drizzle ORM on Postgres, `bun:test`, bun.

---

## Prerequisites

Work in the worktree `I:/Coding/DOTMeta/mmv-reports` on branch `feat/reports-section`.

Spec: `docs/superpowers/specs/2026-08-26-reports-section-design.md`. This plan implements **Part B**
and the date presets. Part A (templates, run history, snapshot-on-export) and Part C (the UI rebuild)
are Plan 2, written after this lands.

Test commands:

- `bun test src/server/agent/report.test.ts` — the primary loop. Pure logic, no DB, ~120ms. **11
  tests pass on a clean baseline.**
- `bun test src/server/agent/agent.test.ts` — the integration guard for the LLM report path. **Requires
  `TEST_DATABASE_URL`** pointing at a throwaway Postgres (see `test-setup.ts:3`); without it all 19
  tests fail on 5s hook timeouts. Run it before the final commit, not in the inner loop.
- `bun run lint` and `bun run build` before the final commit.

Two pre-existing failures elsewhere in the suite (`stored Telegram credentials win over env`,
`setUserPassword rotates the password`) are DB-dependent and unrelated; ignore them.

---

## File Structure

| File | Responsibility |
| --- | --- |
| **Create** `src/lib/report-catalog.ts` | Client-safe descriptor registry: `MetricSource`, `ReportMetric`, `MetricGroup`, `REPORT_METRICS`, lookup helpers. No DB, no secret, no server imports — the rule `report-options.ts` already follows. |
| **Create** `src/lib/report-catalog.test.ts` | Catalog invariants: unique keys, resolvable deps, no cost metric sourced from a stored field. |
| **Create** `src/lib/date-presets.ts` | `DATE_PRESETS` registry + `resolvePreset(key, today)`. Pure date math, injectable clock. |
| **Create** `src/lib/date-presets.test.ts` | All 20 presets against a fixed clock, including month/quarter/year boundaries. |
| **Create** `src/server/fns/report-catalog.ts` | `reportCatalogFor` — which descriptor keys hold non-zero data for a client + range. |
| **Modify** `src/lib/report-options.ts` | Keeps breakdowns, range presets and default keys. `REPORT_COLUMNS` becomes a projection of the catalog, filtered to `LEGACY_UI_COLUMN_KEYS`. |
| **Modify** `src/server/agent/report.ts` | Delete `COL_META`/`VALUE_FNS`. `Agg` → maps. Add the descriptor resolver. `dbRowSource` merges `raw`. |
| **Modify** `src/server/agg.ts` | Extend `EVENT_FAMILIES` with production synonyms; export `FAMILY_LABELS` and `familyValue`. |
| **Modify** `src/server/agent/report.test.ts` | Characterization test + new behaviour tests. |

### Deliberate, time-boxed scaffolding

`LEGACY_UI_COLUMN_KEYS` in `report-options.ts` exists only so the current chip-cloud picker keeps
showing 22 options instead of 150 while Plan 2 builds the real picker. **Plan 2, Task 1 deletes it.**
It is one explicit list projecting from the single catalog — not a second catalog.

---

### Task 1: Pin today's output before changing anything

A refactor of a numeric engine needs a characterization test first, or "no behaviour change" is a
claim rather than a fact. The values below were captured by running the current engine.

**Files:**
- Test: `src/server/agent/report.test.ts` (append)

- [ ] **Step 1: Write the characterization test**

Append to `src/server/agent/report.test.ts`:

```ts
import { REPORT_COLUMNS } from "@/lib/report-options";

// Two days of one campaign, carrying three purchase synonyms so family de-dup is exercised.
const goldenRows: InsightRow[] = [
  row("2026-01-01", "c1", {
    spend: "100",
    impressions: "10000",
    reach: "8000",
    clicks: "500",
    inline_link_clicks: "400",
    actions: [
      { action_type: "omni_purchase", value: "10" },
      { action_type: "purchase", value: "10" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "10" },
      { action_type: "omni_complete_registration", value: "25" },
      { action_type: "lead", value: "5" },
      { action_type: "omni_initiated_checkout", value: "15" },
      { action_type: "omni_landing_page_view", value: "300" },
    ],
    action_values: [
      { action_type: "omni_purchase", value: "2500" },
      { action_type: "purchase", value: "2500" },
    ],
  }),
  row("2026-01-02", "c1", {
    spend: "50",
    impressions: "4000",
    reach: "3500",
    clicks: "200",
    inline_link_clicks: "150",
    actions: [
      { action_type: "omni_purchase", value: "4" },
      { action_type: "omni_complete_registration", value: "10" },
      { action_type: "lead", value: "2" },
      { action_type: "omni_landing_page_view", value: "120" },
    ],
    action_values: [{ action_type: "omni_purchase", value: "900" }],
  }),
];

const goldenSpec = (o: { byDay: boolean; markup?: number }) => ({
  accountIds: ["act_1"],
  since: "2026-01-01",
  until: "2026-01-02",
  columns: REPORT_COLUMNS.map((c) => c.key),
  breakdown: "none" as const,
  byDay: o.byDay,
  objectiveByCampaign: { c1: "OUTCOME_SALES" },
  markup: o.markup,
});

test("characterization: every legacy column, one total row", async () => {
  const p = await buildReport(rowSource({ act_1: goldenRows }), goldenSpec({ byDay: false }), "Acme");
  expect(p.columns.map((c) => c.key)).toEqual([
    "spend", "impressions", "reach", "clicks", "link_clicks", "ctr", "cpc", "cpm", "frequency",
    "results", "cost_per_result", "conversions", "conversion_value", "roas", "registrations",
    "leads", "initiate_checkout", "purchases", "landing_page_views", "cost_per_registration",
    "cost_per_lead", "cost_per_purchase",
  ]);
  const [r] = p.rows;
  expect(r.slice(0, 5)).toEqual([150, 14000, 11500, 700, 550]);
  expect(r[5]).toBe(5);                       // ctr
  expect(r[6] as number).toBeCloseTo(0.214285, 5);  // cpc
  expect(r[7] as number).toBeCloseTo(10.714285, 5); // cpm
  expect(r[8] as number).toBeCloseTo(1.217391, 5);  // frequency
  expect(r[9]).toBe(14);                      // results (OUTCOME_SALES -> purchases)
  expect(r[11]).toBe(14);                     // conversions (omni_purchase)
  expect(r[12]).toBe(3400);                   // conversion_value
  expect(r[13] as number).toBeCloseTo(22.666666, 5); // roas
  // Event families de-duplicate: 3 purchase synonyms must not treble the count.
  expect(r.slice(14, 19)).toEqual([35, 7, 15, 14, 420]);
  expect(r[19] as number).toBeCloseTo(4.285714, 5);  // cost_per_registration
  expect(r[20] as number).toBeCloseTo(21.428571, 5); // cost_per_lead
  expect(r[21] as number).toBeCloseTo(10.714285, 5); // cost_per_purchase
  expect(p.totals).toBeNull();
});

test("characterization: markup inflates spend and every derived cost, never delivery", async () => {
  const p = await buildReport(
    rowSource({ act_1: goldenRows }),
    goldenSpec({ byDay: true, markup: 0.1 }),
    "Acme",
  );
  const [d1] = p.rows;
  expect(d1[1] as number).toBeCloseTo(110, 6);   // spend +10%
  expect(d1[2]).toBe(10000);                     // impressions untouched
  expect(d1[7] as number).toBeCloseTo(0.22, 6);  // cpc +10%
  expect(d1[23] as number).toBeCloseTo(11, 6);   // cost_per_purchase +10% (index shifted by _dim)
  expect(d1[15] as number).toBeCloseTo(22.727272, 5); // roas falls
});
```

- [ ] **Step 2: Run to verify it passes against current code**

Run: `bun test src/server/agent/report.test.ts`
Expected: PASS, 13 tests. These values came from the live engine, so a failure here means the working
tree already differs from the captured baseline — stop and investigate rather than editing the numbers.

- [ ] **Step 3: Commit**

```bash
git add src/server/agent/report.test.ts
git commit -m "test(report): pin current column output before the catalog refactor"
```

---

### Task 2: Fix the totals row dropping every event column

`buildReport` builds totals by restating eight scalar fields (`report.ts:607-617`) and never copies
`a.events`, so `familyCount` sees an empty map. Measured today: a by-day report's totals row ends
`…,0,0,0,0,0,0,0,0` for registrations, leads, initiate_checkout, purchases, landing_page_views and all
three cost-per columns, while the same data as a single row gives `35, 7, 15, 14, 420, 4.29, 21.43,
10.71`.

**Files:**
- Modify: `src/server/agent/report.ts:606-618`
- Test: `src/server/agent/report.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
test("totals include event and cost-per columns, not zeros", async () => {
  const p = await buildReport(rowSource({ act_1: goldenRows }), goldenSpec({ byDay: true }), "Acme");
  const t = p.totals!;
  expect(t[0]).toBe("Total");
  expect(t[1]).toBe(150);                        // spend still right
  expect(t.slice(15, 20)).toEqual([35, 7, 15, 14, 420]); // registrations..landing_page_views
  expect(t[20] as number).toBeCloseTo(4.285714, 5);  // cost_per_registration
  expect(t[21] as number).toBeCloseTo(21.428571, 5); // cost_per_lead
  expect(t[22] as number).toBeCloseTo(10.714285, 5); // cost_per_purchase
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/agent/report.test.ts`
Expected: FAIL — received `[0, 0, 0, 0, 0]` for the event slice.

- [ ] **Step 3: Implement the fix**

Replace `src/server/agent/report.ts:606-617` with:

```ts
  // Totals across every key (only meaningful when there are multiple rows). Folding the event maps
  // in is what the previous version omitted, which zeroed every event and cost-per column.
  const total = emptyAgg();
  for (const a of aggByKey.values()) {
    total.spend += a.spend;
    total.impressions += a.impressions;
    total.reach += a.reach;
    total.clicks += a.clicks;
    total.linkClicks += a.linkClicks;
    total.results += a.results;
    total.conversions += a.conversions;
    total.conversionValue += a.conversionValue;
    for (const [type, n] of a.events) total.events.set(type, (total.events.get(type) ?? 0) + n);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/agent/report.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/agent/report.ts src/server/agent/report.test.ts
git commit -m "fix(report): total the event columns instead of reporting zero

buildReport restated eight scalar fields to build the totals row and never
copied the events map, so familyCount saw an empty map: every event column
(purchases, leads, registrations, landing page views) and all three cost-per
columns rendered 0 in the totals row of any by-day or broken-down report,
while the same data as a single total row was correct."
```

---

### Task 3: The descriptor catalog, expressing today's 22 columns

**Files:**
- Create: `src/lib/report-catalog.ts`
- Create: `src/lib/report-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/report-catalog.test.ts`:

```ts
import { test, expect } from "bun:test";
import { REPORT_METRICS, metric, LEGACY_UI_COLUMN_KEYS } from "./report-catalog";

test("keys are unique", () => {
  const keys = REPORT_METRICS.map((m) => m.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("every derived dependency resolves to a real metric", () => {
  const keys = new Set(REPORT_METRICS.map((m) => m.key));
  for (const m of REPORT_METRICS) {
    if (m.source.kind !== "derived") continue;
    for (const dep of m.source.deps) {
      expect(keys.has(dep)).toBe(true);
    }
  }
});

test("no cost or ratio metric reads a stored field", () => {
  // Meta ships precomputed cpc/cpm/cost_per_* in `raw`; sourcing them would bypass the markup
  // applied to spend and understate what a client is charged.
  for (const m of REPORT_METRICS) {
    const isCostOrRatio = /^(cost_per_|cpc|cpm|cpp|ctr|roas)/.test(m.key) || m.group === "cost";
    if (!isCostOrRatio) continue;
    expect(m.source.kind).toBe("derived");
  }
});

test("every legacy UI key exists in the catalog", () => {
  for (const k of LEGACY_UI_COLUMN_KEYS) expect(metric(k)).toBeDefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/lib/report-catalog.test.ts`
Expected: FAIL — `Cannot find module './report-catalog'`.

- [ ] **Step 3: Write the catalog**

Create `src/lib/report-catalog.ts`:

```ts
/**
 * Report metric catalog — the single source of truth for what a report can contain.
 *
 * Client-safe by contract: no DB, server or secret imports, because the column picker and the
 * server engine must agree by construction rather than by two lists staying in sync. The previous
 * design kept labels in report-options.ts and value functions in report.ts, and an entry present in
 * one but not the other crashed report generation.
 *
 * Adding a metric means adding ONE entry here.
 */
export type ReportColumnKind = "text" | "int" | "money" | "float" | "pct";

export type MetricGroup =
  | "delivery"
  | "traffic"
  | "engagement"
  | "video"
  | "conversions"
  | "value"
  | "cost"
  | "quality"
  | "messaging";

export const GROUP_LABELS: Record<MetricGroup, string> = {
  delivery: "Delivery",
  traffic: "Clicks & traffic",
  engagement: "Engagement",
  video: "Video",
  conversions: "Conversions",
  value: "Conversion value",
  cost: "Cost per",
  quality: "Quality & ranking",
  messaging: "Messaging",
};

export type MetricSource =
  /** A named numeric field on the insight row. `dbRowSource` merges `raw` beneath the promoted
   *  columns, so this one kind covers both; promoted values win because they are normalised. */
  | { kind: "scalar"; field: string }
  /** One de-duplicated EVENT_FAMILIES family (src/server/agg.ts). */
  | { kind: "event"; family: string; measure: "count" | "value" }
  /** A single literal Meta action_type. Legacy-compat only: `conversions` / `conversion_value`
   *  pin `omni_purchase` rather than the Purchases family, and must keep doing so. */
  | { kind: "action"; type: string; measure: "count" | "value" }
  /** The objective-aware result count; needs objectiveByCampaign, so it cannot be a scalar. */
  | { kind: "result" }
  /** Computed from other metrics. The ONLY legal source for a cost or ratio. */
  | { kind: "derived"; deps: string[]; fn: (v: Readonly<Record<string, number>>) => number };

export interface ReportMetric {
  key: string;
  label: string;
  group: MetricGroup;
  kind: ReportColumnKind;
  source: MetricSource;
}

const ratio = (num: string, den: string, scale = 1) => ({
  kind: "derived" as const,
  deps: [num, den],
  fn: (v: Readonly<Record<string, number>>) => (v[den] ? (v[num] / v[den]) * scale : 0),
});

/** Cost per one unit of `den`. Always derived from spend so the client markup is inherited. */
const costPer = (den: string) => ratio("spend", den);

export const REPORT_METRICS: ReportMetric[] = [
  // — delivery
  { key: "spend", label: "Spend", group: "delivery", kind: "money", source: { kind: "scalar", field: "spend" } },
  { key: "impressions", label: "Impressions", group: "delivery", kind: "int", source: { kind: "scalar", field: "impressions" } },
  { key: "reach", label: "Reach", group: "delivery", kind: "int", source: { kind: "scalar", field: "reach" } },
  { key: "frequency", label: "Frequency", group: "delivery", kind: "float", source: ratio("impressions", "reach") },
  { key: "cpm", label: "CPM", group: "delivery", kind: "money", source: ratio("spend", "impressions", 1000) },

  // — traffic
  { key: "clicks", label: "Clicks", group: "traffic", kind: "int", source: { kind: "scalar", field: "clicks" } },
  { key: "link_clicks", label: "Link Clicks", group: "traffic", kind: "int", source: { kind: "scalar", field: "inline_link_clicks" } },
  { key: "ctr", label: "CTR", group: "traffic", kind: "pct", source: ratio("clicks", "impressions", 100) },
  { key: "cpc", label: "CPC", group: "traffic", kind: "money", source: ratio("spend", "clicks") },

  // — conversions
  { key: "results", label: "Results", group: "conversions", kind: "int", source: { kind: "result" } },
  { key: "conversions", label: "Conversions", group: "conversions", kind: "int", source: { kind: "action", type: "omni_purchase", measure: "count" } },
  { key: "registrations", label: "Registrations", group: "conversions", kind: "int", source: { kind: "event", family: "Registrations", measure: "count" } },
  { key: "leads", label: "Leads", group: "conversions", kind: "int", source: { kind: "event", family: "Leads", measure: "count" } },
  { key: "initiate_checkout", label: "Checkouts", group: "conversions", kind: "int", source: { kind: "event", family: "Checkouts initiated", measure: "count" } },
  { key: "purchases", label: "Purchases", group: "conversions", kind: "int", source: { kind: "event", family: "Purchases", measure: "count" } },
  { key: "landing_page_views", label: "Landing Page Views", group: "conversions", kind: "int", source: { kind: "event", family: "Landing page views", measure: "count" } },

  // — value
  { key: "conversion_value", label: "Conv. Value", group: "value", kind: "money", source: { kind: "action", type: "omni_purchase", measure: "value" } },
  { key: "roas", label: "ROAS", group: "value", kind: "float", source: ratio("conversion_value", "spend") },

  // — cost
  { key: "cost_per_result", label: "Cost / Result", group: "cost", kind: "money", source: costPer("results") },
  { key: "cost_per_registration", label: "Cost / Reg.", group: "cost", kind: "money", source: costPer("registrations") },
  { key: "cost_per_lead", label: "Cost / Lead", group: "cost", kind: "money", source: costPer("leads") },
  { key: "cost_per_purchase", label: "Cost / Purchase", group: "cost", kind: "money", source: costPer("purchases") },
];

const BY_KEY = new Map(REPORT_METRICS.map((m) => [m.key, m]));
export const metric = (key: string): ReportMetric | undefined => BY_KEY.get(key);

/**
 * The 22 keys the current chip-cloud picker shows, in its historical display order.
 *
 * SCAFFOLDING with a defined end: it exists so the old picker keeps showing 22 options instead of
 * every catalog entry while the new picker is built. Deleted by Plan 2, Task 1.
 */
export const LEGACY_UI_COLUMN_KEYS = [
  "spend", "impressions", "reach", "clicks", "link_clicks", "ctr", "cpc", "cpm", "frequency",
  "results", "cost_per_result", "conversions", "conversion_value", "roas", "registrations",
  "leads", "initiate_checkout", "purchases", "landing_page_views", "cost_per_registration",
  "cost_per_lead", "cost_per_purchase",
];
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/lib/report-catalog.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/report-catalog.ts src/lib/report-catalog.test.ts
git commit -m "feat(report): add the metric descriptor catalog"
```

---

### Task 4: Resolve descriptors in the engine and delete the parallel maps

**Files:**
- Modify: `src/server/agent/report.ts` — delete `COL_META` (`:149`) and `VALUE_FNS` (`:154-177`); change `Agg` (`:64-74`), `emptyAgg` (`:496-506`), `accumulate` (`:507-518`), the cell/label/totals code (`:589-618`)
- Modify: `src/lib/report-options.ts` — project `REPORT_COLUMNS` from the catalog
- Modify: `src/server/agg.ts` — export `familyValue`

This task is a pure refactor: **its real test is that Task 1's two characterization tests pass
unchanged.** Do not add assertions that encode the new internals.

One genuinely new guard is worth writing, because it is the test whose absence let the two maps drift
into a crash in the first place. Note it passes trivially today (22 keys, all with resolvers) and
becomes load-bearing after Task 7 grows the catalog.

- [ ] **Step 1: Write the guard test**

```ts
import { REPORT_METRICS } from "@/lib/report-catalog";

test("every catalog metric renders through the engine", async () => {
  const p = await buildReport(
    rowSource({ act_1: goldenRows }),
    { ...goldenSpec({ byDay: false }), columns: REPORT_METRICS.map((m) => m.key) },
    "Acme",
  );
  expect(p.columns.length).toBe(REPORT_METRICS.length);
  for (const [i, cell] of p.rows[0].entries()) {
    expect(Number.isFinite(cell as number), `${p.columns[i].key} produced ${cell}`).toBe(true);
  }
});

test("an unknown column key is dropped rather than rendered", async () => {
  const p = await buildReport(
    rowSource({ act_1: goldenRows }),
    { ...goldenSpec({ byDay: false }), columns: ["spend", "not_a_real_metric", "purchases"] },
    "Acme",
  );
  expect(p.columns.map((c) => c.key)).toEqual(["spend", "purchases"]);
  expect(p.rows[0]).toEqual([150, 14]);
});
```

- [ ] **Step 2: Run to see where you start**

Run: `bun test src/server/agent/report.test.ts`
Expected: the unknown-key test **already passes** — `report.ts:533` filters through `COL_META.has(k)`,
so a key absent from the catalog never reaches the value lookup. The crash this refactor removes needs
*drift*: a key present in `REPORT_COLUMNS` (hence in `COL_META`) with no `VALUE_FNS` entry, which then
hits the unguarded `VALUE_FNS[k](a)` at `report.ts:600`. That state cannot be reproduced in a test
without editing the very list this task deletes, which is the point: after this task there is one list
and the failure mode stops existing.

The `every catalog metric renders` test fails to compile until `REPORT_METRICS` is imported and Task 3
has landed; run it after Step 3.

- [ ] **Step 3: Implement**

In `src/server/agg.ts`, add beside `familyCount`:

```ts
/** Value for one canonical event family, using the same first-present-variant de-dup as familyCount. */
export function familyValue(sums: Map<string, number>, label: string): number {
  const fam = EVENT_FAMILIES.find((f) => f.label === label);
  if (!fam) return 0;
  const key = fam.types.find((t) => sums.has(t));
  return key ? Math.round(sums.get(key) ?? 0) : 0;
}
```

In `src/server/agent/report.ts`, replace the `Agg` interface (`:64-74`) with:

```ts
/**
 * Per-row-key accumulator. Scalars live in a map keyed by insight-row field name rather than fixed
 * properties, so the totals row folds the same structures the data rows do and cannot silently omit
 * one (which is exactly how every event column came to total zero).
 */
interface Agg {
  scalars: Map<string, number>;
  results: number;
  events: Map<string, number>;
  eventValues: Map<string, number>;
}
```

Replace `emptyAgg` (`:496-506`) and `accumulate` (`:507-518`) with:

```ts
const emptyAgg = (): Agg => ({
  scalars: new Map(),
  results: 0,
  events: new Map(),
  eventValues: new Map(),
});

const addTo = (m: Map<string, number>, key: string, n: number): void => {
  if (n) m.set(key, (m.get(key) ?? 0) + n);
};

/** Sum only the fields the selected descriptors actually need. */
function accumulate(
  a: Agg,
  r: InsightRow,
  objectiveByCampaign: Record<string, string>,
  fields: readonly string[],
): void {
  for (const f of fields) addTo(a.scalars, f, num((r as Record<string, unknown>)[f]));
  a.results += resultValue(r, objectiveByCampaign[String(r.campaign_id ?? "")]);
  for (const act of (r.actions as { action_type: string; value: string }[] | undefined) ?? [])
    addTo(a.events, act.action_type, Number(act.value) || 0);
  for (const act of (r.action_values as { action_type: string; value: string }[] | undefined) ?? [])
    addTo(a.eventValues, act.action_type, Number(act.value) || 0);
}

const mergeAgg = (into: Agg, from: Agg): void => {
  for (const [k, v] of from.scalars) addTo(into.scalars, k, v);
  into.results += from.results;
  for (const [k, v] of from.events) addTo(into.events, k, v);
  for (const [k, v] of from.eventValues) addTo(into.eventValues, k, v);
};

/** Field names a descriptor set needs summed, following `derived` dependencies transitively. */
function neededFields(keys: readonly string[]): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const m = metric(key);
    if (!m) return;
    if (m.source.kind === "scalar") out.add(m.source.field);
    else if (m.source.kind === "derived") m.source.deps.forEach(walk);
  };
  keys.forEach(walk);
  return [...out];
}

/** Resolve one descriptor against an accumulator, memoising so shared deps compute once. */
function resolveMetric(key: string, a: Agg, memo: Map<string, number>): number {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const m = metric(key);
  if (!m) return 0;
  let v = 0;
  switch (m.source.kind) {
    case "scalar":
      v = a.scalars.get(m.source.field) ?? 0;
      break;
    case "result":
      v = a.results;
      break;
    case "action":
      v =
        (m.source.measure === "count" ? a.events : a.eventValues).get(m.source.type) ?? 0;
      break;
    case "event":
      v =
        m.source.measure === "count"
          ? familyCount(a.events, m.source.family)
          : familyValue(a.eventValues, m.source.family);
      break;
    case "derived": {
      const deps: Record<string, number> = {};
      for (const d of m.source.deps) deps[d] = resolveMetric(d, a, memo);
      v = m.source.fn(deps);
      break;
    }
  }
  memo.set(key, v);
  return v;
}
```

Update the imports at the top of `report.ts`:

```ts
import { familyCount, familyValue } from "@/server/agg";
import { metric, REPORT_METRICS } from "@/lib/report-catalog";
```

Delete `COL_META` (`:149`), `costPer` (`:150-153`) and `VALUE_FNS` (`:154-177`) entirely. Point
`normalizeColumns` at the catalog by replacing its lookup line (`:217`):

```ts
    const k = metric(key) ? key : COLUMN_ALIASES[key.replace(/[^a-z]/g, "")];
```

In `buildReport`, replace the column filter (`:533`), the column build (`:589-598`), the cell builder
(`:600`) and the totals loop (`:606-618`) with:

```ts
  const metricCols = keys.filter((k) => metric(k) !== undefined);
```

```ts
  const fields = neededFields(cols);
```
(place immediately before the `for (const acc of spec.accountIds)` loop, and pass it through:
`accumulate(a, r, spec.objectiveByCampaign, fields);`)

```ts
  const columns: ReportColumn[] = [
    ...(hasDimCol ? [{ key: "_dim", label: dimLabel, kind: "text" as const }] : []),
    ...cols.map((k) => {
      const m = metric(k)!;
      return { key: m.key, label: m.label, kind: m.kind };
    }),
  ];

  const metricCells = (a: Agg): number[] => {
    const memo = new Map<string, number>();
    return cols.map((k) => resolveMetric(k, a, memo));
  };
```

```ts
  // Totals across every key (only meaningful when there are multiple rows).
  const total = emptyAgg();
  for (const a of aggByKey.values()) mergeAgg(total, a);
```

Markup now inflates the scalar map instead of a property — replace `report.ts:572-575`:

```ts
  if (spec.markup) {
    const factor = 1 + spec.markup;
    for (const a of aggByKey.values()) {
      const s = a.scalars.get("spend");
      if (s) a.scalars.set("spend", s * factor);
    }
  }
```

And the row ordering at `:579`, which read `a.spend`:

```ts
  else if (dim !== "none")
    order.sort(
      (x, y) => (aggByKey.get(y)!.scalars.get("spend") ?? 0) - (aggByKey.get(x)!.scalars.get("spend") ?? 0),
    );
```

Finally, in `src/lib/report-options.ts` replace the hand-written `REPORT_COLUMNS` array (`:11-34`)
with a projection, keeping the exported type so the UI is untouched:

```ts
import { LEGACY_UI_COLUMN_KEYS, metric, type ReportColumnKind } from "./report-catalog";

export type { ReportColumnKind };

export interface ReportColumnDef {
  key: string;
  label: string;
  kind: ReportColumnKind;
}

/** Projection of the catalog for the current picker. See LEGACY_UI_COLUMN_KEYS — Plan 2 removes it. */
export const REPORT_COLUMNS: ReportColumnDef[] = LEGACY_UI_COLUMN_KEYS.map((k) => {
  const m = metric(k)!;
  return { key: m.key, label: m.label, kind: m.kind };
});
```

- [ ] **Step 4: Run to verify everything passes**

Run: `bun test src/server/agent/report.test.ts src/lib/report-catalog.test.ts`
Expected: PASS, 19 tests. The two characterization tests from Task 1 must pass **unchanged** — that is
the proof the refactor moved no number.

- [ ] **Step 5: Run the integration guard**

Run: `TEST_DATABASE_URL=<throwaway-pg-url> bun test src/server/agent/agent.test.ts`
Expected: PASS, 19 tests. This covers the LLM path through `tools.ts:550`, which shares the engine.

- [ ] **Step 6: Commit**

```bash
git add src/server/agent/report.ts src/server/agg.ts src/lib/report-options.ts src/server/agent/report.test.ts
git commit -m "refactor(report): resolve columns from descriptors, delete the parallel maps

REPORT_COLUMNS and VALUE_FNS were two hand-maintained lists that had to agree,
and an entry in one but not the other crashed generation at an unguarded
VALUE_FNS[k](a). Columns now resolve from one catalog of descriptors, Agg keeps
scalars in a map so totals fold the same structures the data rows do, and an
unknown key is dropped instead of throwing. No reported number changes."
```

---

### Task 5: Merge `raw` into the row so stored metrics are reachable

`dbRowSource` selects whole rows (`report.ts:342` is an unprojected `db.select()`) but maps only seven
fields into `InsightRow`, discarding the `raw` jsonb that already arrived. Merging it costs no extra
query.

**Files:**
- Modify: `src/server/agent/report.ts:330-340` (the `core` mapper)
- Test: `src/server/agent/report.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("a raw-sourced metric reads through to the report", async () => {
  // `unique_clicks` is not a promoted column; it exists only inside the synced `raw` blob.
  const p = await buildReport(
    rowSource({ act_1: [row("2026-01-01", "c1", { spend: "10", unique_clicks: "7" })] }),
    { ...goldenSpec({ byDay: false }), columns: ["spend", "unique_clicks"] },
    "Acme",
  );
  expect(p.rows[0]).toEqual([10, 7]);
});
```

Add the descriptor it needs to `REPORT_METRICS` in `src/lib/report-catalog.ts`, in the traffic group:

```ts
  { key: "unique_clicks", label: "Unique Clicks", group: "traffic", kind: "int", source: { kind: "scalar", field: "unique_clicks" } },
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/agent/report.test.ts`
Expected: FAIL — `[10, 0]`, because nothing maps `unique_clicks` onto the row.

This test passes as soon as the descriptor exists, because `accumulate` reads named fields off the row
generically. It fails only for the DB path, which Step 3 fixes; keep the test as the guard for the
descriptor contract.

- [ ] **Step 3: Implement the raw merge**

In `dbRowSource`, replace the `core` mapper (`report.ts:330-340`) with:

```ts
  const core = (r: typeof schema.insightsDaily.$inferSelect): InsightRow => ({
    // `raw` is the full Meta response for the row and is already on the wire (the select above is
    // unprojected), so spreading it makes ~90 stored metrics reachable at no query cost. Promoted
    // columns are spread last: they are normalised numbers and must win on any key collision.
    ...((r.raw ?? {}) as Record<string, unknown>),
    date_start: r.date,
    date_stop: r.date,
    spend: String(r.spend),
    impressions: String(r.impressions),
    reach: String(r.reach),
    clicks: String(r.clicks),
    inline_link_clicks: String(r.inlineLinkClicks),
    actions: (r.actions ?? undefined) as InsightRow["actions"],
    action_values: (r.actionValues ?? undefined) as InsightRow["action_values"],
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/agent/report.test.ts src/lib/report-catalog.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/agent/report.ts src/lib/report-catalog.ts src/server/agent/report.test.ts
git commit -m "feat(report): merge the synced raw blob into report rows

dbRowSource selected whole rows and mapped only seven fields, discarding the
raw jsonb it had already fetched. Spreading it under the promoted columns makes
the stored metric set reachable without a second query."
```

---

### Task 6: Extend the event families with the synonyms production actually returns

Measured on production: the Purchases family returns eight variants, three of which
(`web_in_store_purchase`, `onsite_web_app_purchase`, `web_app_in_store_purchase`) are absent from
`EVENT_FAMILIES`. Harmless while a preferred variant is present, wrong when it is the only one.

**Files:**
- Modify: `src/server/agg.ts:78-127`
- Test: `src/server/agg.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or append `src/server/agg.test.ts`:

```ts
import { test, expect } from "bun:test";
import { familyCount } from "./agg";

test("a family matches even when only a late synonym is present", () => {
  // A row carrying ONLY the in-store purchase variant still counts as Purchases.
  expect(familyCount(new Map([["web_in_store_purchase", 12]]), "Purchases")).toBe(12);
});

test("preference order wins so synonyms never double-count", () => {
  const sums = new Map([
    ["omni_purchase", 10],
    ["purchase", 10],
    ["web_in_store_purchase", 10],
  ]);
  expect(familyCount(sums, "Purchases")).toBe(10);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/agg.test.ts`
Expected: FAIL on the first test — received `0`.

- [ ] **Step 3: Implement**

In `src/server/agg.ts`, extend the affected families' `types` arrays (preference order preserved —
`omni_*` first, the bare name next, platform-specific variants last):

```ts
  {
    label: "Purchases",
    types: [
      "omni_purchase",
      "purchase",
      "offsite_conversion.fb_pixel_purchase",
      "onsite_web_purchase",
      "onsite_web_app_purchase",
      "web_in_store_purchase",
      "web_app_in_store_purchase",
    ],
  },
  {
    label: "Leads",
    types: [
      "lead",
      "onsite_web_lead",
      "offsite_conversion.fb_pixel_lead",
      "offsite_lead_add_20_s_calls",
    ],
  },
  {
    label: "Registrations",
    types: [
      "omni_complete_registration",
      "complete_registration",
      "offsite_conversion.fb_pixel_complete_registration",
      "offsite_complete_registration_add_meta_leads",
      "offsite_complete_registration_add_20_s_calls",
    ],
  },
```

Extend `Checkouts initiated` with `offsite_initiate_checkout_add_20_s_calls` and `View content` with
`offsite_content_view_add_meta_leads` and `offsite_content_view_add_20_s_calls`, in the same trailing
position.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/agg.test.ts src/server/agent/report.test.ts`
Expected: PASS. The Task 1 characterization test still passes — it uses `omni_*` variants, which keep
winning on preference order.

- [ ] **Step 5: Commit**

```bash
git add src/server/agg.ts src/server/agg.test.ts
git commit -m "fix(agg): recognise the purchase and lead synonyms production returns

Measured against prod: the purchase family returns eight action_types, three of
which were missing from EVENT_FAMILIES. Absent variants only matter when they
are the sole one present, in which case the family silently counted zero."
```

---

### Task 7: Expand the catalog to the full stored metric set

**Files:**
- Modify: `src/lib/report-catalog.ts`
- Test: `src/lib/report-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the catalog covers the measured stored metric set", () => {
  // Sanity floor, not a target: prod carries 111 distinct raw keys and 17 event families.
  expect(REPORT_METRICS.length).toBeGreaterThan(120);
  for (const g of Object.keys(GROUP_LABELS) as MetricGroup[]) {
    expect(REPORT_METRICS.some((m) => m.group === g)).toBe(true);
  }
});

test("every event family is exposed as count, value and cost-per", () => {
  const families = [...new Set(
    REPORT_METRICS.flatMap((m) => (m.source.kind === "event" ? [m.source.family] : [])),
  )];
  expect(families.length).toBeGreaterThanOrEqual(17);
});
```

Import `GROUP_LABELS` and the `MetricGroup` type in the test file.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/lib/report-catalog.test.ts`
Expected: FAIL — length is 23, and the `video`/`quality`/`messaging`/`engagement` groups are empty.

- [ ] **Step 3: Implement**

Generate the event-family triples programmatically rather than typing 51 entries — the family list is
already the single source of truth, so restating it would be a second list to drift:

```ts
/** Families, in the display order EVENT_FAMILIES declares. Mirror of agg.ts's labels; the catalog is
 *  client-safe and cannot import the server module, so the labels are asserted equal by a test. */
export const EVENT_FAMILY_LABELS = [
  "Purchases", "Leads", "Registrations", "Add to cart", "Checkouts initiated", "View content",
  "Add payment info", "Subscriptions", "Trials started", "Searches", "Contacts", "App installs",
  "Messaging conversations", "Landing page views", "Link clicks", "Post engagements", "Video views",
] as const;

const slug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, "_");

const eventMetrics = (): ReportMetric[] =>
  EVENT_FAMILY_LABELS.flatMap((family): ReportMetric[] => {
    const k = slug(family);
    return [
      { key: `event_${k}`, label: family, group: "conversions", kind: "int", source: { kind: "event", family, measure: "count" } },
      { key: `value_${k}`, label: `${family} value`, group: "value", kind: "money", source: { kind: "event", family, measure: "value" } },
      { key: `cost_per_${k}`, label: `Cost / ${family}`, group: "cost", kind: "money", source: costPer(`event_${k}`) },
    ];
  });
```

Add the stored scalar metrics. Each entry is one line; the group and format kind are the editorial
content that auto-generation cannot supply:

```ts
const STORED_SCALARS: [key: string, label: string, group: MetricGroup, kind: ReportColumnKind][] = [
  ["unique_clicks", "Unique Clicks", "traffic", "int"],
  ["outbound_clicks", "Outbound Clicks", "traffic", "int"],
  ["unique_outbound_clicks", "Unique Outbound Clicks", "traffic", "int"],
  ["inline_post_engagement", "Post Engagements", "engagement", "int"],
  ["full_view_impressions", "Full-View Impressions", "delivery", "int"],
  ["full_view_reach", "Full-View Reach", "delivery", "int"],
  ["instagram_profile_visits", "Instagram Profile Visits", "engagement", "int"],
  ["estimated_ad_recallers", "Estimated Ad Recallers", "engagement", "int"],
  ["video_play_actions", "Video Plays", "video", "int"],
  ["marketing_messages_delivered", "Messages Delivered", "messaging", "int"],
  ["marketing_messages_read", "Messages Read", "messaging", "int"],
  ["marketing_messages_link_btn_click", "Message Link Clicks", "messaging", "int"],
  ["marketing_messages_quick_reply_btn_click", "Message Quick Replies", "messaging", "int"],
  // …continue for the remaining measured keys; run the availability probe below to enumerate them.
];
```

**Enumerate the real key set rather than guessing.** Run this against a read-only production
connection and add every returned key not already present:

```sql
WITH s AS (
  SELECT raw FROM insights_daily
  WHERE level = 'ad' AND spend > 1 AND date > CURRENT_DATE - 400 LIMIT 40000
)
SELECT DISTINCT jsonb_object_keys(raw) AS key FROM s ORDER BY 1;
```

Exclude, deliberately:
- identity and dimension fields (`account_id`, `ad_id`, `campaign_name`, `date_start`, `objective`, …)
- **every precomputed cost or rate field** (`cpc`, `cpm`, `cpp`, `cost_per_*`, `*_rate`,
  `*_per_link_click`, `ctr`, `unique_ctr`) — these are `derived` entries instead, or the markup is
  bypassed. The Task 3 test enforces this.

Append the ranking metrics as `text` scalars in the `quality` group (`engagement_rate_ranking`,
`conversion_rate_ranking`) — note `quality_ranking` is non-null in 0 of 513,253 production rows and is
included only so the availability filter can hide it rather than the catalog pretending it does not
exist.

Assemble the export:

```ts
export const REPORT_METRICS: ReportMetric[] = [
  ...BASE_METRICS,        // the 23 from Task 3
  ...STORED_SCALARS.map(([key, label, group, kind]): ReportMetric => ({
    key, label, group, kind, source: { kind: "scalar", field: key },
  })),
  ...eventMetrics(),
  ...DERIVED_RATIOS,      // cost_per_unique_click, cost_per_outbound_click, etc.
];
```

- [ ] **Step 4: Add the label-parity test**

Because the client-safe catalog cannot import `agg.ts`, assert the two label lists agree. Add to
`src/server/agg.test.ts` (server-side, so it may import both):

```ts
import { EVENT_FAMILY_LABELS } from "@/lib/report-catalog";
import { eventFamilyLabels } from "./agg";

test("catalog family labels match EVENT_FAMILIES exactly", () => {
  expect([...EVENT_FAMILY_LABELS]).toEqual(eventFamilyLabels());
});
```

Export the accessor from `src/server/agg.ts`:

```ts
/** Family labels in declaration order, so the client-safe catalog can be asserted against them. */
export const eventFamilyLabels = (): string[] => EVENT_FAMILIES.map((f) => f.label);
```

- [ ] **Step 5: Run to verify everything passes**

Run: `bun test src/lib/report-catalog.test.ts src/server/agg.test.ts src/server/agent/report.test.ts`
Expected: PASS. Characterization tests unchanged — the legacy 22 keys keep their keys and values.

- [ ] **Step 6: Commit**

```bash
git add src/lib/report-catalog.ts src/lib/report-catalog.test.ts src/server/agg.ts src/server/agg.test.ts
git commit -m "feat(report): expand the catalog to the full stored metric set"
```

---

### Task 8: Availability — which metrics have data for this client and range

**Files:**
- Create: `src/server/fns/report-catalog.ts`
- Test: `src/server/fns/report-catalog.db.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { availableMetricKeys } from "./report-catalog";

test("only metrics with non-zero data are reported available", async () => {
  const keys = await availableMetricKeys({
    accountIds: ["act_avail_1"],
    since: "2026-01-01",
    until: "2026-01-02",
  });
  expect(keys).toContain("spend");
  expect(keys).toContain("event_purchases");
  // quality_ranking is never populated by the sync; it must not be offered.
  expect(keys).not.toContain("quality_ranking");
});
```

Seed `insights_daily` in the test with one ad-level row for `act_avail_1` carrying `spend`,
`impressions` and an `omni_purchase` action, following the seeding style already used in
`src/server/agent/agent.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL=<throwaway-pg-url> bun test src/server/fns/report-catalog.db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createServerFn } from "@tanstack/react-start";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db/client";
import * as schema from "@/db/schema";
import { REPORT_METRICS, metric } from "@/lib/report-catalog";
import { getClientRow, effectiveAccountIds } from "@/sync/jobs/clients";
import { resolveRange } from "@/server/agent/report";

/**
 * Which catalog keys hold non-zero data for a window. Sampled, not exhaustive: the picker only needs
 * to know whether a metric is worth offering, and a full scan of every row would cost more than the
 * report itself. The engine never consults this — a report explicitly asking for an empty column
 * still renders zeros rather than failing.
 */
export async function availableMetricKeys(args: {
  accountIds: string[];
  since: string;
  until: string;
}): Promise<string[]> {
  if (args.accountIds.length === 0) return [];
  const rows = await db
    .select({ raw: schema.insightsDaily.raw, actions: schema.insightsDaily.actions })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.level, "ad"),
        inArray(schema.insightsDaily.accountId, args.accountIds),
        gte(schema.insightsDaily.date, args.since),
        lte(schema.insightsDaily.date, args.until),
      ),
    )
    .limit(5000);

  const fields = new Set<string>();
  const actionTypes = new Set<string>();
  for (const r of rows) {
    for (const [k, v] of Object.entries((r.raw ?? {}) as Record<string, unknown>)) {
      if (Number(v)) fields.add(k);
    }
    for (const a of (r.actions as { action_type: string; value: string }[] | null) ?? []) {
      if (Number(a.value)) actionTypes.add(a.action_type);
    }
  }

  const has = (key: string, seen = new Set<string>()): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    const m = metric(key);
    if (!m) return false;
    switch (m.source.kind) {
      case "scalar":
        return fields.has(m.source.field);
      case "action":
        return actionTypes.has(m.source.type);
      case "event":
        return EVENT_MEMBERS[m.source.family]?.some((t) => actionTypes.has(t)) ?? false;
      case "result":
        return true;
      case "derived":
        return m.source.deps.every((d) => has(d, seen));
    }
  };
  return REPORT_METRICS.filter((m) => has(m.key)).map((m) => m.key);
}

export const reportCatalogFor = createServerFn({ method: "POST" })
  .inputValidator((d: { clientId: string; days?: number; since?: string; until?: string }) => d)
  .handler(async ({ data }) => {
    const row = await getClientRow(data.clientId);
    if (!row) return { keys: [] as string[] };
    const range = resolveRange(data);
    if (!range) return { keys: [] as string[] };
    return {
      keys: await availableMetricKeys({
        accountIds: effectiveAccountIds(row),
        since: range.since,
        until: range.until,
      }),
    };
  });
```

`EVENT_MEMBERS` is a `Record<string, string[]>` of family label → member action types, exported from
`src/server/agg.ts` alongside `eventFamilyLabels`:

```ts
/** Family label → member action_types, for availability checks. */
export const EVENT_MEMBERS: Record<string, string[]> = Object.fromEntries(
  EVENT_FAMILIES.map((f) => [f.label, f.types]),
);
```

Import it in the server fn: `import { EVENT_MEMBERS } from "@/server/agg";`

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL=<throwaway-pg-url> bun test src/server/fns/report-catalog.db.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/server/fns/report-catalog.ts src/server/fns/report-catalog.db.test.ts src/server/agg.ts
git commit -m "feat(report): report which metrics have data for a client and range"
```

---

### Task 9: Twenty date presets

`resolveRange` accepts a `days` count or an explicit `since`/`until` and nothing else, so the builder
offers `[7, 14, 30, 90]`. Presets are local date math against our own daily rows — no API involvement.

**Files:**
- Create: `src/lib/date-presets.ts`
- Create: `src/lib/date-presets.test.ts`
- Modify: `src/server/agent/report.ts:733-751` (`resolveRange` accepts a `preset`)

- [ ] **Step 1: Write the failing test**

Create `src/lib/date-presets.test.ts`:

```ts
import { test, expect } from "bun:test";
import { DATE_PRESETS, resolvePreset } from "./date-presets";

// A Wednesday, mid-month, mid-quarter — so week/month/quarter boundaries are all non-trivial.
const TODAY = "2026-08-26";

test("every preset resolves to an inclusive ISO range", () => {
  for (const p of DATE_PRESETS) {
    const r = resolvePreset(p.key, TODAY);
    expect(r).not.toBeNull();
    expect(r!.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r!.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r!.since <= r!.until).toBe(true);
  }
});

test("calendar presets land on real boundaries", () => {
  expect(resolvePreset("yesterday", TODAY)).toEqual({ since: "2026-08-25", until: "2026-08-25" });
  expect(resolvePreset("this_month", TODAY)).toEqual({ since: "2026-08-01", until: "2026-08-26" });
  expect(resolvePreset("last_month", TODAY)).toEqual({ since: "2026-07-01", until: "2026-07-31" });
  expect(resolvePreset("this_quarter", TODAY)).toEqual({ since: "2026-07-01", until: "2026-08-26" });
  expect(resolvePreset("last_quarter", TODAY)).toEqual({ since: "2026-04-01", until: "2026-06-30" });
  expect(resolvePreset("last_year", TODAY)).toEqual({ since: "2025-01-01", until: "2025-12-31" });
  // Monday-start week: 2026-08-26 is a Wednesday.
  expect(resolvePreset("this_week_mon_today", TODAY)).toEqual({ since: "2026-08-24", until: "2026-08-26" });
  expect(resolvePreset("last_week_mon_sun", TODAY)).toEqual({ since: "2026-08-17", until: "2026-08-23" });
});

test("relative presets exclude today, matching the trailing-window convention", () => {
  expect(resolvePreset("last_7d", TODAY)).toEqual({ since: "2026-08-19", until: "2026-08-25" });
});

test("an unknown preset is null, never a silent wrong range", () => {
  expect(resolvePreset("nonsense", TODAY)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/lib/date-presets.test.ts`
Expected: FAIL — `Cannot find module './date-presets'`.

- [ ] **Step 3: Implement**

Create `src/lib/date-presets.ts`. Compute in UTC on plain `YYYY-MM-DD` strings — the report already
aggregates stored `date` values, and introducing a local timezone here would shift a client's month
boundary:

```ts
/**
 * Named report ranges, mirroring Meta's date_preset vocabulary.
 *
 * Resolved locally: reports read our own daily rows, so a preset is date arithmetic and never an API
 * concern. Relative windows END YESTERDAY, matching the existing trailing-window convention — today
 * is partial and Meta keeps restating it for ~28 days.
 */
export interface DatePreset {
  key: string;
  label: string;
  group: "relative" | "calendar" | "all";
}

export const DATE_PRESETS: DatePreset[] = [
  { key: "yesterday", label: "Yesterday", group: "relative" },
  { key: "last_3d", label: "Last 3 days", group: "relative" },
  { key: "last_7d", label: "Last 7 days", group: "relative" },
  { key: "last_14d", label: "Last 14 days", group: "relative" },
  { key: "last_28d", label: "Last 28 days", group: "relative" },
  { key: "last_30d", label: "Last 30 days", group: "relative" },
  { key: "last_90d", label: "Last 90 days", group: "relative" },
  { key: "today", label: "Today", group: "calendar" },
  { key: "this_week_mon_today", label: "This week (Mon–today)", group: "calendar" },
  { key: "this_week_sun_today", label: "This week (Sun–today)", group: "calendar" },
  { key: "last_week_mon_sun", label: "Last week (Mon–Sun)", group: "calendar" },
  { key: "last_week_sun_sat", label: "Last week (Sun–Sat)", group: "calendar" },
  { key: "this_month", label: "This month", group: "calendar" },
  { key: "last_month", label: "Last month", group: "calendar" },
  { key: "this_quarter", label: "This quarter", group: "calendar" },
  { key: "last_quarter", label: "Last quarter", group: "calendar" },
  { key: "this_year", label: "This year", group: "calendar" },
  { key: "last_year", label: "Last year", group: "calendar" },
  { key: "maximum", label: "All time", group: "all" },
];

const MAXIMUM_DAYS = 1125; // ≈37 months, Meta's retention ceiling and the sync's backfill target.

const utc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const shift = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);

export function resolvePreset(
  key: string,
  today: string,
): { since: string; until: string } | null {
  const t = utc(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const yesterday = shift(t, -1);
  const trailing = (n: number) => ({ since: iso(shift(t, -n)), until: iso(yesterday) });
  const monthStart = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm, 1)));
  const monthEnd = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm + 1, 0)));
  // 0=Sun..6=Sat. Monday-start weeks treat Sunday as day 7.
  const dow = t.getUTCDay();
  const sinceMon = dow === 0 ? 6 : dow - 1;
  const q = Math.floor(m / 3);

  switch (key) {
    case "today":
      return { since: today, until: today };
    case "yesterday":
      return { since: iso(yesterday), until: iso(yesterday) };
    case "last_3d":
      return trailing(3);
    case "last_7d":
      return trailing(7);
    case "last_14d":
      return trailing(14);
    case "last_28d":
      return trailing(28);
    case "last_30d":
      return trailing(30);
    case "last_90d":
      return trailing(90);
    case "this_week_mon_today":
      return { since: iso(shift(t, -sinceMon)), until: today };
    case "this_week_sun_today":
      return { since: iso(shift(t, -dow)), until: today };
    case "last_week_mon_sun":
      return { since: iso(shift(t, -sinceMon - 7)), until: iso(shift(t, -sinceMon - 1)) };
    case "last_week_sun_sat":
      return { since: iso(shift(t, -dow - 7)), until: iso(shift(t, -dow - 1)) };
    case "this_month":
      return { since: monthStart(y, m), until: today };
    case "last_month":
      return { since: monthStart(y, m - 1), until: monthEnd(y, m - 1) };
    case "this_quarter":
      return { since: monthStart(y, q * 3), until: today };
    case "last_quarter":
      return { since: monthStart(y, q * 3 - 3), until: monthEnd(y, q * 3 - 1) };
    case "this_year":
      return { since: monthStart(y, 0), until: today };
    case "last_year":
      return { since: monthStart(y - 1, 0), until: monthEnd(y - 1, 11) };
    case "maximum":
      return { since: iso(shift(t, -MAXIMUM_DAYS)), until: iso(yesterday) };
    default:
      return null;
  }
}
```

Then teach `resolveRange` about presets, in `src/server/agent/report.ts:733`:

```ts
/** Resolve a preset key, a `days` count, or explicit since/until into a date range. */
export function resolveRange(input: {
  preset?: unknown;
  days?: unknown;
  since?: unknown;
  until?: unknown;
}): { since: string; until: string } | null {
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  if (
    typeof input.since === "string" &&
    isoRe.test(input.since) &&
    typeof input.until === "string" &&
    isoRe.test(input.until)
  ) {
    return { since: input.since, until: input.until };
  }
  if (typeof input.preset === "string") {
    const r = resolvePreset(input.preset, new Date().toISOString().slice(0, 10));
    if (r) return r;
  }
  const days = Math.round(Number(input.days));
  // Clamp to the insights retention target (≈37 months) — history is synced to account creation.
  if (Number.isFinite(days) && days > 0) return trailingRange(Math.min(days, 1125));
  return null;
}
```

Add `preset?: string` to `ClientReportInput` (`report.ts:753`) and import `resolvePreset`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/lib/date-presets.test.ts src/server/agent/report.test.ts`
Expected: PASS. Explicit `since`/`until` still take precedence, so no existing test changes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/date-presets.ts src/lib/date-presets.test.ts src/server/agent/report.ts
git commit -m "feat(report): add the twenty named date presets"
```

---

### Task 10: Verify the whole surface and hand off

- [ ] **Step 1: Full pure suite**

Run: `bun test src/lib src/server/agent/report.test.ts src/server/agg.test.ts`
Expected: PASS. Only the two known DB-dependent failures may appear if the whole `src/lib` tree is
included without `TEST_DATABASE_URL`.

- [ ] **Step 2: DB suite**

Run: `TEST_DATABASE_URL=<throwaway-pg-url> bun test src/server`
Expected: PASS, including `agent.test.ts`'s eight `runReport` cases.

- [ ] **Step 3: Lint and typecheck**

Run: `bun run lint && bun run build`
Expected: no errors. The build is the typecheck — `REPORT_COLUMNS` consumers
(`ReportBuilder.tsx:14`, `settings.tsx`, `chat` components) must still compile against the projection.

- [ ] **Step 4: Smoke test the real UI**

Run: `bun run dev`, open `/reports`, generate a report for any client with a by-day breakdown, and
confirm the totals row shows non-zero purchases/leads where the day rows do. That row is the visible
proof of the Task 2 fix; a screenshot of it belongs in the handoff.

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "chore(report): verify the catalog engine end to end"
git push origin feat/reports-section
```

---

## Self-Review

**Spec coverage.** Part B "Sources" → Tasks 3, 5, 7. "Synonym trap" → Task 6 plus the Task 1
characterization assertion. "Descriptors" → Tasks 3-4. "Hard rule: cost derived" → Task 3's third
test, enforced structurally by the absence of a `cost` measure. "Groups" → Task 3 + Task 7's group
coverage test. "Availability" → Task 8. Date presets → Task 9. Bugs 1-3 → Tasks 2, 4, and Task 4's
`REPORT_COLUMNS` projection respectively.

**Not covered here, by design:** Part A (schema, run ledger, templates, routes) and Part C (the UI
rebuild) are Plan 2. The known-open sync issue (hourly refresh nulling promoted columns) stays open;
Task 7 deliberately keeps `quality_ranking` in the catalog so the availability filter hides it rather
than the catalog pretending it does not exist.

**Placeholder scan.** One task carries an intentional enumeration step rather than a literal list:
Task 7's `STORED_SCALARS` gives 13 concrete entries plus the exact SQL to enumerate the rest, because
the remaining keys are per-account facts that must be read from the database, not invented in a plan.
The exclusion rules for that enumeration are explicit and machine-checked by Task 3's cost test.

**Type consistency.** `MetricSource` kinds (`scalar` / `event` / `action` / `result` / `derived`) are
used identically in Tasks 3, 4, 7 and 8. `metric(key)` is the single lookup everywhere.
`familyCount`/`familyValue` are the paired accessors. `Agg` is `{ scalars, results, events,
eventValues }` in Tasks 4-8 — note `results` is a plain number, not a map entry, because it is
objective-derived rather than a row field.
