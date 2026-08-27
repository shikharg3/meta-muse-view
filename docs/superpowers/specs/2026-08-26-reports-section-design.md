# Reports section — design

**Date:** 2026-08-26
**Status:** design awaiting review; nothing built
**Branch:** `feat/reports-section` (off `feat/meta-integration` @ `ed72e0a`)

## Problem

`/reports` is a one-shot form. You pick a client, a range, some columns, a breakdown and a markup;
it renders a table; you download a CSV or PDF. Navigate away and every choice is gone, no record
exists of what was generated, and there is no way to say what a client was told last month.

The option set is also far narrower than the data we hold. Measured against production Postgres on
the droplet (`159.65.110.111`, 2026-08-26):

| Fact | Value |
| --- | --- |
| Metric fields requested from Meta per sync | **203** — `INSIGHT_METRICS`, `src/meta/fieldsets.ts:301-505` |
| Distinct keys ever present in `insights_daily.raw` | **111** (40k ad-level rows, `spend > 1`, 400 days) — ~90 after identity fields |
| Distinct `action_type` values in `actions` | **63**, collapsing to **17** semantic families |
| Metric columns the builder offers | **22** — `REPORT_COLUMNS`, `src/lib/report-options.ts:11-34` |
| Event families the builder offers | **5 of 17** (`EVENT_FAMILIES`, `src/server/agg.ts:78`) |
| Promoted `insights_daily` columns read by the engine | **7 of 27** — `dbRowSource`, `src/server/agent/report.ts:330-340` |
| Date range presets | **4** (`[7,14,30,90]`, `report-options.ts:66`) against Meta's 20 |
| Fields permanently blocklisted per level | **21** (`configurable_*`, `*_targeting`, `labels`, SKAN) |

Two numbers explain the shape of the fix. `raw` median is **16 keys per row** (p95 82–96, max 101) —
Meta omits zero-valued fields, so sparsity is normal rather than damage; and `db.select()` at
`report.ts:342` is **unprojected**, so `raw` is already fetched on every report and discarded. The
data is on the wire already.

## Scope

In:

1. **Persistent section** — templates, run history, snapshot-on-export.
2. **Dynamic column catalog** — ~150 columns from data already stored, replacing two
   hand-maintained maps.
3. **Full UI redesign** of the builder and preview.
4. **20 date presets** (local date math only).

Out, deliberately:

- **Period-over-period comparison.** A real engine change; not selected.
- **Two-dimension breakdowns.** The engine supports one dimension plus a `byDay` flag
  (`report.ts:90-143`); lifting that is separable work.
- **Syncing new breakdown groups.** Would add Meta API load to an app already suspended once
  (`src/meta/rate-limit.ts:100`). Also largely unnecessary: Meta's `breakdowns` enum has 88 values
  but its guide states *"only some permutations of breakdowns are available"* — roughly **30 legal
  permutations**, of which we already sync 20 groups and expose 23 dimensions.
- **Batch / multi-client runs.** One report at a time.
- **Scheduled delivery.** Export is the delivery.

## Part A — the section

### Semantics

A template is a **recipe**, re-run against current data. A run becomes an **immutable snapshot the
moment it is exported**, because export is the delivery: the CSV or PDF leaving the browser is what
the client receives. Un-exported runs are drafts.

This answers "what did we tell them in March?" without storing every throwaway preview forever.

Snapshots preserve **numbers**, not bytes. The stored payload replays through the same renderer, so
identical figures are guaranteed permanently; identical PDF bytes hold only while `ReportBlock`'s
jspdf layout is unchanged. Storing rendered files was rejected — the app has no blob storage, and the
numbers are what a client would dispute.

### Schema

Two tables in `src/db/schema.ts`, migrated via `db:generate` + `db:migrate`.

```ts
export const reportTemplates = pgTable("report_templates", {
  id: text("id").primaryKey(),                    // crypto.randomUUID()
  name: text("name").notNull(),
  clientId: text("client_id").references(() => clients.id, { onDelete: "cascade" }),
  columns: jsonb("columns").notNull(),             // string[] of catalog keys, IN USER ORDER
  breakdown: text("breakdown").notNull().default("none"),
  splitByDay: boolean("split_by_day").notNull().default(false),
  markup: doublePrecision("markup"),
  rangePreset: text("range_preset"),               // a DATE_PRESETS key, null = ask at run time
  campaignIds: jsonb("campaign_ids"),              // only legal when clientId is set
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp(...).notNull().defaultNow(),
  updatedAt: timestamp(...).notNull().defaultNow(),
}, (t) => [index("report_templates_client_idx").on(t.clientId)]);
```

`client_id` **nullable** is the whole trick: set = a one-click client-bound template; null = a
generic shape with the client chosen at run time. Both were asked for, and one nullable FK delivers
both without per-client override merge rules.

`campaign_ids` is only accepted when `client_id` is set — campaign ids belong to exactly one client,
so on a generic template they would save a filter that can never match. The server fn rejects rather
than silently storing it.

```ts
export const reportRuns = pgTable("report_runs", {
  id: text("id").primaryKey(),
  templateId: text("template_id").references(() => reportTemplates.id, { onDelete: "set null" }),
  clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  params: jsonb("params").notNull(),               // the exact ClientReportInput used
  payload: jsonb("payload").notNull(),             // the frozen ReportPayload
  since: date("since").notNull(),
  until: date("until").notNull(),
  rowCount: integer("row_count").notNull(),
  ranBy: text("ran_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp(...).notNull().defaultNow(),
  exportedAt: timestamp(...),                      // NULL = draft. The snapshot boundary.
  exportedFormats: jsonb("exported_formats"),      // string[]: "csv" | "pdf"
}, (t) => [
  index("report_runs_exported_idx").on(t.exportedAt, t.createdAt),
  index("report_runs_client_idx").on(t.clientId, t.exportedAt),
]);
```

`client_id` uses **RESTRICT**, matching the infra tables' convention and the fact that clients are
soft-deleted via `removed_at` (`schema.ts:270-272`) rather than dropped. History must outlive a
client leaving the Notion board.

`exported_formats` is an array so exporting CSV *then* PDF from one run appends, instead of creating
two history entries for identical numbers. `exported_at` records the first export only.

`since`/`until`/`row_count` are denormalised off `params`/`payload` purely so history filters and
sorts in SQL.

### Flow

1. `createReportRun` computes the payload by delegating to the existing `reportForClient`, writes a
   `report_runs` row with `exported_at = NULL`, and returns `{ payload, runId }`. **Not** named
   `runReport`: that name is already taken by `report.ts:685`, the core report producer called by
   `reportForClient`, by the LLM tool path at `tools.ts:550`, and by eight tests in `agent.test.ts`.
2. The CSV/PDF buttons call `markReportExported({ runId, format })`, which stamps `exported_at` (if
   unset) and appends to `exported_formats`.
3. History lists runs where `exported_at IS NOT NULL`.
4. Drafts are pruned by the sync worker's daily-gated block — `src/sync/worker.ts:155` already runs
   once-per-calendar-day work off `today() !== lastFullDay`. Retention: **7 days**.

The server never trusts client-supplied numbers: the archived payload is the server's own
computation, and export only flips a flag.

### Routes

`reports.tsx` becomes a thin tab layout with `<Outlet/>`, exactly as `portal.tsx` does for
`/portal/*`.

| file | URL | purpose |
| --- | --- | --- |
| `reports.tsx` | — | layout: History / New / Templates |
| `reports.index.tsx` | `/reports` | history |
| `reports.new.tsx` | `/reports/new` | builder, seeded by `?template=<id>` |
| `reports.$runId.tsx` | `/reports/:runId` | a frozen run, read-only, re-downloadable |
| `reports.templates.tsx` | `/reports/templates` | template CRUD |

`AppSidebar.tsx:59` still points at `/reports`, which now lands on history rather than an empty form.

## Part B — the catalog and the engine

### Why the current design cannot grow

A column today must be registered in **two parallel hand-maintained maps** — `REPORT_COLUMNS`
(`report-options.ts:11-34`, client-side labels) and `VALUE_FNS` (`report.ts:154-177`, server-side
value functions) — across up to seven touch points. When they disagree, `VALUE_FNS[k](a)` at
`report.ts:600` is unguarded and **report generation crashes**. That is why the list has stayed at 22.

### Sources

All three already exist in the database:

| source | available | exposed today |
| --- | --- | --- |
| promoted `insights_daily` columns | 27 | 7 |
| `raw` jsonb metrics | ~90 of 111 measured keys | 0 |
| `EVENT_FAMILIES` × {count, value} + derived cost-per | 51 | 8 |
| derived ratios with no stored equivalent | ~10 | 7 |

The ~150 figure is `~90` scalar metrics (the 111 measured `raw` keys less ~21 identity/dimension
fields; the 27 promoted columns overlap this set rather than adding to it) `+ 51` event-family
columns `+ ~10` derived ratios with no stored equivalent. It is an estimate to be replaced by the
exact count once the registry is written, not a target to pad toward.

`accumulate` (`report.ts:516-517`) already folds **every** action type into `a.events`. Twelve of the
seventeen families — add-to-cart, view content, subscriptions, trials started, searches, contacts,
app installs, messaging conversations, post engagements, video views, add payment info, link clicks —
are aggregated in memory right now and simply have no column.

### The synonym trap

Meta reports one conversion under many `action_type` values. Measured: the purchase family returns
**eight** variants (`omni_purchase`, `purchase`, `onsite_web_purchase`,
`offsite_conversion.fb_pixel_purchase`, `web_in_store_purchase`, `onsite_web_app_purchase`,
`web_app_in_store_purchase`, `offsite_purchase_add_20_s_calls`) **all reading exactly 1372**.

A naive one-column-per-`action_type` catalog would therefore show "Purchases" eight times with
identical numbers and let a user sum them into an 8× overcount. `EVENT_FAMILIES` (`agg.ts:78`) already
solves this with preference-ordered synonyms and first-present-wins dedupe (`familyCount`,
`agg.ts:164`). The catalog is **family-based**, never action-type-based.

Family lists are extended with synonyms found in production but absent from the registry
(`web_in_store_purchase`, `onsite_web_app_purchase`, `web_app_in_store_purchase`,
`offsite_*_add_20_s_calls`, `offsite_*_add_meta_leads`). Harmless while a preferred variant is
present, wrong when it is the only one.

### Descriptors

`VALUE_FNS` and `COL_META` are deleted. One registry in a client-safe `src/lib/report-catalog.ts`
(no DB or secret imports — the rule `report-options.ts` already follows):

```ts
type MetricSource =
  // A named numeric field. `dbRowSource` merges `raw` under the promoted columns, so one kind
  // covers both — promoted values win on key collision because they are already normalised.
  | { kind: "scalar"; field: string }
  // One de-duplicated EVENT_FAMILIES family (agg.ts:78). Counts and values only — see below.
  | { kind: "event"; family: string; measure: "count" | "value" }
  // A single literal Meta action_type. Legacy-compat ONLY, for the existing conversions /
  // conversion_value / roas columns, which pin `omni_purchase` rather than the family.
  | { kind: "action"; type: string; measure: "count" | "value" }
  // The objective-aware "result" count, which needs objectiveByCampaign and so cannot be a scalar.
  | { kind: "result" }
  | { kind: "derived"; deps: string[]; fn: (v: Readonly<Record<string, number>>) => number };

interface ReportMetric {
  key: string;
  label: string;
  group: MetricGroup;
  kind: ReportColumnKind;   // text | int | money | float | pct
  source: MetricSource;
}
```

Consequences, each retiring a current defect:

- Adding a column is **one entry**, not seven registration points.
- The engine resolves descriptors generically, so there is no second map to fall out of step with and
  nothing for `VALUE_FNS[k]` to be undefined about.
- `Agg` becomes `{ scalars: Map<string, number>; events: Map<string, number>; eventValues: Map<string, number> }`.
  Totals iterate the same maps instead of restating a field list, so the totals bug cannot recur.
- `eventValues` is new but trivial — `canonicalEvents` (`agg.ts:151`) already computes value-per-family;
  the report never asked.

### Hard rule: cost and ratio metrics are always derived

Markup inflates spend once, at `report.ts:574` (`a.spend *= factor`), and every metric deriving from
spend inherits it.

`raw` also contains Meta's **precomputed** `cpc`, `cpm`, `cpp`, `cost_per_action_type`,
`cost_per_unique_click`, `cost_per_inline_link_click`, `cost_per_outbound_click`,
`landing_page_view_per_link_click`, `marketing_messages_cost_per_*` and every `*_rate` — roughly
25-30 of the ~90 candidate fields.

**There is deliberately no `"cost"` measure and no raw-sourced cost field, so a mis-sourced cost
column is not representable.** Sourcing Meta's precomputed values would bypass the markup and print
un-inflated costs beside inflated spend in a client-facing report — silently understating what the
client is being charged. Every cost-per metric is therefore `{ kind: "derived" }` over spend and a
count, enforced by the type rather than by review. Meta's precomputed cost fields are excluded from
the catalog entirely rather than offered conditionally, because a column correct only when markup is
zero is a trap.

### Groups

Nine, which is what makes ~150 items navigable: **Delivery** · **Clicks & traffic** ·
**Engagement** · **Video** · **Conversions** · **Conversion value** · **Cost per** ·
**Quality & ranking** · **Messaging**.

### Availability

A server fn `reportCatalogFor({ clientId, since, until })` scans the selected rows and returns the
`string[]` of descriptor keys holding non-zero data. The UI filters the picker against that set; the
engine does not consult it, so a report explicitly requesting an empty column still renders zeros
rather than failing.

This is not a nicety. `marketing_messages_*` is 11 fields present on 7,579 rows — essential for a
WhatsApp client, pure noise for everyone else. `quality_ranking` is non-null in **0 of 513,253**
ad-level rows and must never be offered at all. Without the filter, a 150-item picker is worse than
today's 22.

## Part C — the UI

### What is wrong

| defect | evidence |
| --- | --- |
| Column picker is an unbounded flat chip cloud — no search, groups, or scroll container | `ReportBuilder.tsx:253-259` |
| It lives in a 360px sidebar | `reports.tsx:73` |
| Breakdown is a native `<select>` with 24 flat options | `ReportBuilder.tsx:265-275` |
| Column order is forced to catalog order, not yours | `ReportBuilder.tsx:92` |
| Chosen columns are never visible as an ordered set | selection exists only as highlight state |
| Campaign filter is another cloud with no search | `ReportBuilder.tsx:198` |
| Preview wraps every header instead of scrolling | `ReportBlock.tsx` table is `w-full`, no `min-w`/`nowrap` |
| Markup field uses its placeholder as documentation | `ReportBuilder.tsx:296` |

At 22 chips the cloud is already ~8 rows inside 360px; at 150 it is ~55 rows and pushes the Generate
button far below the fold. The picker cannot be fixed in place — it needs different furniture.

### Layout

`/reports/new` becomes a **config rail** (~320px: client, range, breakdown, campaigns, markup,
template) plus a **full-width live preview**. The column picker moves out of the rail into a
**dialog**, because it is the one control that genuinely needs the viewport, and a two-pane transfer
list is the established answer to "choose 15 of 150".

### Columns dialog

- Left pane: search, the nine groups, availability-filtered.
- Right pane: selected columns **in order** — drag to reorder, click to remove.
- Footer: `12 selected · 38 of 150 metrics have data for this client and range · show all`.

That footer is load-bearing. Availability **hides** rather than greys, because greying 112 of 150 rows
is noise — but hiding silently would leave someone hunting for ROAS on a client with no purchase
data, so the count and the escape hatch are always on screen.

### Other controls

- **Breakdown**: searchable `Command` popover grouped Entity / Audience / Placement / Time / Assets.
  No new dependency — that is the `Popover` + `Command` pattern the client picker already uses at
  `ReportBuilder.tsx:132-174`. Ad-level-only asset dims are marked; dims with no synced rows for the
  range are omitted.
- **Date range**: grouped popover — Relative (yesterday, last 3/7/14/28/30/90d), Calendar (this/last
  week, month, quarter, year, MTD), All time — plus the custom pair. Twenty presets, all local date
  math against our own daily rows. A `DATE_PRESETS` registry keyed by string, resolved to
  `since`/`until` server-side so a stored template stays meaningful over time.
- **Campaign filter**: the same searchable popover with All / None, replacing the chip cloud.
- **Markup**: a real label and helper text.

### Preview

`overflow-x-auto` wrapper, `min-w-max` + `whitespace-nowrap` table, sticky header row and sticky
dimension column.

**Explicitly no virtualization.** `MAX_ROWS = 500` (`report.ts:520`) already caps output and
500 × 30 cells is unremarkable for the DOM. Written down so nobody adds a windowing dependency for a
problem that does not exist.

### Export limits

CSV is unlimited. PDF flips to landscape above 6 columns today (`ReportBlock.tsx:49`) and is
unreadable above roughly 12 at any orientation, so the PDF button **warns** above the threshold
instead of quietly emitting an unusable document.

## Bugs fixed as part of this work

1. **Totals ignore every event column.** `report.ts:607-617` accumulates 8 scalar fields and never
   `a.events`, so every event column (purchases, leads, registrations, landing page views) and every
   cost-per column renders **0 in the totals row** today. Adding ~50 event columns would multiply the
   defect; the `Agg`-as-maps change removes the duplicated field list that caused it.
2. **Unguarded value lookup.** `report.ts:600` `VALUE_FNS[k](a)` and the `COL_META.get(k)!`
   assertions at `report.ts:590,595` crash report generation on a catalog/engine mismatch. Descriptors
   remove the second map.
3. **Column order.** `ReportBuilder.tsx:92` re-sorts the selection into catalog order; it will emit
   the user's order.

## Known issue left open

The hourly refresh requests only `CORE_METRICS` (12 fields, `cycle.ts:145`) and the upsert at
`insights.ts:172` does `set: { ...values, syncedAt }`, so promoted columns absent from that pass are
written NULL over good values. Measured effect: `quality_ranking` non-null in **0 of 513,253**
ad-level rows; `raw` p95 82 keys inside the 28-day refresh window against 96 outside. The guard for
exactly this hazard exists eighteen lines earlier at `insights.ts:154-159` for the attribution-window
columns and was never applied to the metric columns.

This is sync-side, out of scope here, and worth its own change. Until then the availability filter
hides the affected metrics automatically, which is the correct user-facing behaviour either way.

## Error handling

- **Empty result.** `contributors < accountIds.length` already produces a note
  (`report.ts:621-624`); keep it, and add an explicit empty state distinguishing "no data in range"
  from "no accounts mapped to this client".
- **Unknown catalog key** (a stored template referencing a retired metric): drop the key, render the
  report, and surface `2 columns in this template are no longer available`. Never crash, never
  silently produce a narrower report without saying so.
- **Template referencing a soft-deleted client**: allowed to open read-only, blocked from running,
  with the reason named.
- **Snapshot replay of a payload whose column set predates a catalog change**: the payload carries its
  own `columns` array, so it renders from itself and never re-consults the catalog. This is the reason
  the payload is stored whole rather than as params plus a key list.
- **Export of a run that no longer exists**: 404 to history with a message, not a blank page.

## Testing

Pinned by existing tests in `report.test.ts` (`normalizeColumns`, `parseBreakdown`, `resolveRange`,
`buildReport` aggregation / markup / event-dedup / ordering) — all must keep passing, since the
descriptor refactor must not change any number a current column produces.

New tests, each defending a contract that a plausible bug would break:

1. **Catalog completeness** — every descriptor resolves without throwing for a synthetic `Agg`. This
   is the test whose absence allowed the unguarded-crash defect.
2. **Totals include event columns** — a two-row report with purchases totals to the sum, not 0. Fails
   against today's engine.
3. **Family dedupe** — a row carrying all eight purchase synonyms yields `purchases = 1372`, not
   10,976.
4. **Markup applies to every cost metric** — for each `derived` cost descriptor, a 10% markup raises
   it by exactly 10%. This is the test that enforces the no-`raw`-cost-fields rule; any descriptor
   sourcing a precomputed Meta cost field fails it.
5. **Snapshot immutability** — a stored payload renders identically after the catalog changes
   underneath it.
6. **Export stamping** — first export sets `exported_at` and appends the format; second export of a
   different format appends without moving `exported_at`.
7. **Draft pruning** — runs with `exported_at IS NULL` older than retention are deleted; exported runs
   never are.
8. **Generic template rejects `campaign_ids`** — the server fn refuses rather than storing an
   unmatchable filter.
9. **Date presets** — each of the 20 resolves to the expected `since`/`until` against a fixed clock,
   including month/quarter/year boundaries.

## Build sequence

1. Descriptor registry + engine refactor behind the existing 22 columns; existing tests green, zero
   behaviour change. Fixes bugs 1 and 2.
2. Catalog expansion to ~150 metrics + `reportCatalogFor` availability fn.
3. `DATE_PRESETS` registry and resolution.
4. Schema + `createReportRun` / `markReportExported` / template CRUD + draft pruning.
5. Route split and the tab layout.
6. Columns dialog, breakdown and range popovers, preview scroll behaviour.
7. Template and history UI.

Steps 1-3 are pure server/lib work behind an unchanged UI; steps 5-7 are pure UI over a settled
contract.
