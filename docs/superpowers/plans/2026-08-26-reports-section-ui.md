# Reports Section & UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/reports` from a one-shot form into a persistent section — saved templates, run history frozen on export, all 112 catalog metrics behind a searchable grouped picker, and 19 named date presets.

**Architecture:** Plan 1 landed the engine; this plan is the section and its UI. Two new tables (`report_templates`, `report_runs`) plus plain server functions in `src/server/fns/reports.ts` with `createServerFn` wrappers in `src/lib/api/reports.ts`. `/reports` becomes a flat-file layout route with `<Outlet/>` and `Link`-based tabs. The column picker moves out of the 320px rail into a two-pane dialog filtered by `getReportCatalog` availability.

**Tech Stack:** TanStack Start (file routes, server fns, `router.invalidate()`), Drizzle/Postgres, shadcn/ui (dialog, popover, command), `bun:test`, bun.

---

## Prerequisites

Worktree `I:/Coding/DOTMeta/mmv-reports`, branch `feat/reports-section` (currently `= origin/feat/meta-integration`).

Spec: `docs/superpowers/specs/2026-08-26-reports-section-design.md` — Part A (the section) and Part C (the UI). Part B shipped in Plan 1.

- `bun test src/lib src/server/agg.test.ts src/server/agent/report.test.ts src/server/fns/report-catalog.test.ts` — baseline **232 pass, 4 fail**; the 4 are `ECONNREFUSED 127.0.0.1:5432` in untouched files. Not your problem.
- DB-backed tests need `TEST_DATABASE_URL` and `--timeout 120000` if tunneled (a truncate of ~40 tables over SSH exceeds the 5s default).
- `bun run lint`, `bun run build` (build IS the typecheck) before the final commit. `src/server/fns/settings.test.ts` has a pre-existing prettier error — leave it.

## Conventions this plan MUST follow

Surveyed from the codebase; deviating creates a second convention.

| concern | convention | evidence |
| --- | --- | --- |
| Server fn layering | `src/server/fns/*.ts` = plain `async function` + `requireAdmin()`. `src/lib/api/*.ts` = thin `createServerFn().inputValidator().handler()` forwarders. **`createServerFn` never appears under `server/fns`.** | `src/server/fns/infra/pages.ts:21`, `src/lib/api/infrastructure.ts:180-204` |
| Errors | Reads **throw** (`requireAdmin()`); mutations **return** `{ ok: boolean; error?: string }` | `pages.ts:70-83`, `pages.ts:200` |
| Migrations | **Hand-written idempotent DDL in a comment block**, run once on the droplet before deploy. `src/db/migrations/` does not exist; `bun run db:push` is recorded as unsafe (proposes a destructive PK rebuild on a 458k-row table) | `src/server/fns/conversations.ts:5-25` |
| jsonb columns | bare `jsonb("name")`, cast at the read site. Never `.$type<>()` on jsonb | `schema.ts:316`, `conversations.ts:92` |
| Refresh after mutation | `const router = useRouter(); … await router.invalidate();` — there is no `useMutation` anywhere | `src/routes/infrastructure.pages.tsx` |
| Feedback | inline `useState<string \| null>` message; **no toasts** (`sonner` installed, `<Toaster/>` never mounted, `toast()` never called) | repo-wide |
| Checkboxes | raw `<input type="checkbox" className="size-3.5 accent-primary" />`; `ui/checkbox.tsx` has zero consumers | `ReportBuilder.tsx:277-282` |
| Tabs | `Link` + `activeOptions={{ exact }}` + `activeProps` inside a layout route rendering `<Outlet/>`. `ui/tabs.tsx` has zero consumers — do not introduce it | `src/portal/components/Shell.tsx:38-54`, `src/routes/portal.tsx:40` |
| Searchable picker | `Popover` + `Command`/`CommandInput`/`CommandGroup`/`CommandItem` | `ReportBuilder.tsx:132-174` |
| Audit trail | `await audit("<domain>.<action>", detail)` on admin mutations | `pages.ts:203` |

## File Structure

| File | Responsibility |
| --- | --- |
| **Modify** `src/db/schema.ts` | Append `reportTemplates`, `reportRuns` |
| **Create** `src/server/fns/reports.ts` | Idempotent DDL block; template CRUD; `createReportRun`; `markReportExported`; `fetchReportRuns`; `fetchReportRun`; `pruneReportDrafts` |
| **Create** `src/server/fns/reports.test.ts` | Pure validation rules (generic template rejects campaign ids; export stamping arithmetic) |
| **Create** `src/lib/api/reports.ts` | `createServerFn` wrappers |
| **Create** `src/components/reports/ColumnPickerDialog.tsx` | Two-pane searchable grouped picker over all 112 metrics |
| **Create** `src/components/reports/RangePicker.tsx` | Grouped preset popover + custom pair |
| **Create** `src/components/reports/BreakdownPicker.tsx` | Searchable grouped breakdown popover |
| **Modify** `src/components/chat/ReportBuilder.tsx` | Use the three new controls; emit user column order; real markup label |
| **Modify** `src/components/chat/ReportBlock.tsx` | Horizontal scroll, nowrap, sticky first column, PDF width warning |
| **Create** `src/routes/reports.tsx` | Layout: tabs + `<Outlet/>` |
| **Create** `src/routes/reports.index.tsx` | History |
| **Create** `src/routes/reports.new.tsx` | Builder (today's `reports.tsx` body) |
| **Create** `src/routes/reports.$runId.tsx` | Frozen run, read-only |
| **Create** `src/routes/reports.templates.tsx` | Template CRUD |
| **Delete** `src/routes/reports.tsx` (old body) | Becomes the layout; body moves to `reports.new.tsx` |
| **Modify** `src/lib/report-options.ts` | **Delete `LEGACY_UI_COLUMN_KEYS` projection**; `REPORT_COLUMNS` becomes the full catalog |
| **Modify** `src/lib/report-catalog.ts` | Delete `LEGACY_UI_COLUMN_KEYS` |
| **Modify** `src/sync/worker.ts` | Call `pruneReportDrafts()` in the daily-gated block |

---

### Task 1: Schema + idempotent DDL

**Files:** Modify `src/db/schema.ts`; Create `src/server/fns/reports.ts`

- [ ] **Step 1: Append the tables** to `src/db/schema.ts` (bare jsonb, timestamptz, explicit indexes — matching `conversations` at `:291` and `infraPages` at `:517`)

```ts
// Saved report recipes. `client_id` NULL = a generic shape whose client is chosen at run time;
// set = a one-click client-bound template. One nullable FK delivers both without override rules.
export const reportTemplates = pgTable(
  "report_templates",
  {
    id: text("id").primaryKey(), // crypto.randomUUID()
    name: text("name").notNull(),
    clientId: text("client_id").references(() => clients.id, { onDelete: "cascade" }),
    columns: jsonb("columns").notNull(), // string[] catalog keys, IN USER ORDER
    breakdown: text("breakdown").notNull().default("none"),
    splitByDay: boolean("split_by_day").notNull().default(false),
    markup: doublePrecision("markup"),
    rangePreset: text("range_preset"), // a DATE_PRESETS key; null = ask at run time
    campaignIds: jsonb("campaign_ids"), // only legal when clientId is set
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("report_templates_client_idx").on(t.clientId)],
);

// One row per generated report. `exported_at` NULL = draft; the first export freezes the payload as
// the snapshot of what the client actually received. RESTRICT on client_id because clients are
// soft-deleted via removed_at and history must outlive a client leaving the Notion board.
export const reportRuns = pgTable(
  "report_runs",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id").references(() => reportTemplates.id, { onDelete: "set null" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    params: jsonb("params").notNull(), // the exact ClientReportInput used
    payload: jsonb("payload").notNull(), // the frozen ReportPayload
    since: date("since").notNull(),
    until: date("until").notNull(),
    rowCount: integer("row_count").notNull(),
    ranBy: text("ran_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    exportedFormats: jsonb("exported_formats"), // string[]: "csv" | "pdf"
  },
  (t) => [
    index("report_runs_exported_idx").on(t.exportedAt, t.createdAt),
    index("report_runs_client_idx").on(t.clientId, t.exportedAt),
  ],
);
```

Check the existing import list at the top of `schema.ts` already includes `boolean`, `date`, `integer`, `doublePrecision`, `index`; add any that is missing.

- [ ] **Step 2: Create `src/server/fns/reports.ts` with the DDL block first**

The repo has no migration files and `db:push` is unsafe, so the convention (`conversations.ts:5-25`) is a hand-written idempotent block run once on the droplet:

```ts
// Idempotent prod migration (run once on the droplet before deploying):
//
//   CREATE TABLE IF NOT EXISTS report_templates (
//     id text PRIMARY KEY,
//     name text NOT NULL,
//     client_id text REFERENCES clients(id) ON DELETE CASCADE,
//     columns jsonb NOT NULL,
//     breakdown text NOT NULL DEFAULT 'none',
//     split_by_day boolean NOT NULL DEFAULT false,
//     markup double precision,
//     range_preset text,
//     campaign_ids jsonb,
//     created_by text REFERENCES users(id) ON DELETE SET NULL,
//     created_at timestamptz NOT NULL DEFAULT now(),
//     updated_at timestamptz NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS report_templates_client_idx ON report_templates (client_id);
//
//   CREATE TABLE IF NOT EXISTS report_runs (
//     id text PRIMARY KEY,
//     template_id text REFERENCES report_templates(id) ON DELETE SET NULL,
//     client_id text NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
//     params jsonb NOT NULL,
//     payload jsonb NOT NULL,
//     since date NOT NULL,
//     until date NOT NULL,
//     row_count integer NOT NULL,
//     ran_by text REFERENCES users(id) ON DELETE SET NULL,
//     created_at timestamptz NOT NULL DEFAULT now(),
//     exported_at timestamptz,
//     exported_formats jsonb
//   );
//   CREATE INDEX IF NOT EXISTS report_runs_exported_idx ON report_runs (exported_at, created_at);
//   CREATE INDEX IF NOT EXISTS report_runs_client_idx ON report_runs (client_id, exported_at);
```

- [ ] **Step 3: Verify** `bun run build` passes (schema is typechecked by consumers). Commit.

```bash
git add src/db/schema.ts src/server/fns/reports.ts
git commit -m "feat(reports): add the template and run-ledger tables"
```

---

### Task 2: Template CRUD + run ledger

**Files:** `src/server/fns/reports.ts`, `src/server/fns/reports.test.ts`, `src/lib/api/reports.ts`

- [ ] **Step 1: Write the failing test** — `src/server/fns/reports.test.ts`

```ts
import { test, expect } from "bun:test";
import { validateTemplate, nextExportFormats } from "./reports";

test("a generic template may not carry campaign ids", () => {
  // Campaign ids belong to exactly one client; on a generic template they would save a filter that
  // can never match whichever client is chosen at run time.
  expect(validateTemplate({ name: "Monthly", columns: ["spend"], campaignIds: ["c1"] })).toEqual({
    ok: false,
    error: "Campaign filters need a client-bound template",
  });
  expect(
    validateTemplate({ name: "Monthly", columns: ["spend"], clientId: "acme", campaignIds: ["c1"] }),
  ).toEqual({ ok: true });
});

test("a template needs a name and at least one known column", () => {
  expect(validateTemplate({ name: "  ", columns: ["spend"] }).ok).toBe(false);
  expect(validateTemplate({ name: "X", columns: [] }).ok).toBe(false);
  expect(validateTemplate({ name: "X", columns: ["not_a_metric"] }).ok).toBe(false);
  expect(validateTemplate({ name: "X", columns: ["spend", "purchases"] }).ok).toBe(true);
});

test("exporting the same run twice appends the format without moving the first stamp", () => {
  expect(nextExportFormats(null, "csv")).toEqual(["csv"]);
  expect(nextExportFormats(["csv"], "pdf")).toEqual(["csv", "pdf"]);
  expect(nextExportFormats(["csv"], "csv")).toEqual(["csv"]); // idempotent
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test src/server/fns/reports.test.ts` → module has no such exports.

- [ ] **Step 3: Implement** in `src/server/fns/reports.ts`. Pure helpers first so they are testable, then the DB functions.

```ts
export interface TemplateInput {
  id?: string | null;
  name: string;
  clientId?: string | null;
  columns: string[];
  breakdown?: string;
  splitByDay?: boolean;
  markup?: number | null;
  rangePreset?: string | null;
  campaignIds?: string[] | null;
}

/** Pure validation, split out so the rules are tested without a database. */
export function validateTemplate(input: TemplateInput): { ok: boolean; error?: string } {
  if (!input.name.trim()) return { ok: false, error: "Name is required" };
  const cols = input.columns.filter((k) => metric(k) !== undefined);
  if (cols.length === 0) return { ok: false, error: "Pick at least one column" };
  if (input.campaignIds?.length && !input.clientId) {
    return { ok: false, error: "Campaign filters need a client-bound template" };
  }
  if (input.rangePreset && !resolvePreset(input.rangePreset, "2026-01-01")) {
    return { ok: false, error: `Unknown date preset: ${input.rangePreset}` };
  }
  return { ok: true };
}

/** Append a format, keeping the array a set and preserving first-export order. */
export function nextExportFormats(current: unknown, format: string): string[] {
  const list = Array.isArray(current) ? current.filter((f): f is string => typeof f === "string") : [];
  return list.includes(format) ? list : [...list, format];
}
```

Then the DB layer — reads throw via `requireAdmin()`, mutations return `{ok,error}`:

```ts
export async function fetchTemplates(): Promise<TemplateView[]>            // requireAdmin, join client name
export async function saveTemplate(input: TemplateInput): Promise<{ ok: boolean; error?: string; id?: string }>
export async function deleteTemplate(input: { id: string }): Promise<{ ok: boolean; error?: string }>
export async function fetchReportRuns(input?: { clientId?: string; limit?: number }): Promise<RunSummary[]>
export async function fetchReportRun(input: { id: string }): Promise<RunDetail | null>
export async function createReportRun(input: ClientReportInput & { templateId?: string | null }):
  Promise<{ ok: true; runId: string; payload: ReportPayload } | { ok: false; error: string }>
export async function markReportExported(input: { runId: string; format: "csv" | "pdf" }):
  Promise<{ ok: boolean; error?: string }>
export async function pruneReportDrafts(): Promise<number>   // exported_at IS NULL older than 7 days
```

`createReportRun` delegates to the existing `reportForClient` (do **not** re-implement report logic),
then inserts. Note the name: `runReport` at `src/server/agent/report.ts:685` is taken by the core
producer used by the LLM path.

`saveTemplate` and `deleteTemplate` call `await audit("report.template.save" | ".delete", id)`.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/fns/reports.test.ts` → 3 pass.

- [ ] **Step 5: Add the wrappers** in `src/lib/api/reports.ts`, one per function, following `src/lib/api/infrastructure.ts:180-204` exactly (`GET` for reads, `POST` for mutations).

- [ ] **Step 6: Wire draft pruning** into `src/sync/worker.ts`'s daily-gated block (the `full` branch around `:155`), logging the count like the other jobs. Commit.

---

### Task 3: Unhide the catalog

**Files:** `src/lib/report-catalog.ts`, `src/lib/report-options.ts`

- [ ] **Step 1: Delete the scaffolding.** Remove `LEGACY_UI_COLUMN_KEYS` from `report-catalog.ts` and its test in `report-catalog.test.ts` ("every legacy UI key exists in the catalog").

- [ ] **Step 2: Make `REPORT_COLUMNS` the whole catalog** in `report-options.ts`:

```ts
/** Every catalog metric, projected for the picker. */
export const REPORT_COLUMNS: ReportColumnDef[] = REPORT_METRICS.map((m) => ({
  key: m.key,
  label: m.label,
  kind: m.kind,
  group: m.group,
}));
```

Add `group: MetricGroup` to `ReportColumnDef` — the picker needs it and the old shape had no grouping field.

- [ ] **Step 3: Verify** the characterization tests still pass. They call `REPORT_COLUMNS.map(c => c.key)`, which now yields 112 keys, so `goldenSpec` will request all of them — **update `src/server/agent/report.test.ts`'s `goldenSpec` to use an explicit list of the original 22 keys** rather than `REPORT_COLUMNS`, so the characterization stays pinned to what it was written to pin. This is the one place the wider catalog changes an existing test's meaning.

- [ ] **Step 4: Run** `bun test src/server/agent/report.test.ts src/lib` → all green. Commit.

---

### Task 4: Column picker dialog

**Files:** Create `src/components/reports/ColumnPickerDialog.tsx`

- [ ] **Step 1: Build the component.** Props:

```ts
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: string[];                 // ordered
  onChange: (keys: string[]) => void; // ordered
  availableKeys: string[] | null;     // null = not yet loaded / no client picked
}
```

Layout — `Dialog` from `@/components/ui/dialog`, `sm:max-w-4xl`:
- Left pane: a search `<input>` filtering on label and key, then the metrics grouped by `GROUP_LABELS` order, each row a raw `<input type="checkbox" className="size-3.5 accent-primary" />` + label. Group headers show `n/total`.
- Right pane: the selected keys **in order**, each with ↑/↓ and a remove ×. Reordering mutates the array, which IS the column order.
- Footer: `{selected.length} selected · {availableCount} of {REPORT_METRICS.length} metrics have data for this client and range` and a `Show all` toggle.
- When `availableKeys` is non-null, hide unavailable metrics unless `Show all` is on. When null, show everything with no count.

Hide-by-default with a visible count and escape hatch is deliberate: greying ~100 of 112 rows is noise, but hiding silently would leave someone hunting for ROAS on a client with no purchase data.

- [ ] **Step 2: Verify in the browser** (see Task 9). No unit test: this is presentational, and the repo has zero component tests.

- [ ] **Step 3: Commit.**

---

### Task 5: Range and breakdown pickers

**Files:** Create `src/components/reports/RangePicker.tsx`, `src/components/reports/BreakdownPicker.tsx`

- [ ] **Step 1: `RangePicker`.** `Popover` + grouped list from `DATE_PRESETS` (`relative` / `calendar` / `all` via the `group` field), plus a Custom option revealing the two `<input type="date">` fields already in `ReportBuilder.tsx:233-245`. Value shape:

```ts
type RangeValue = { preset: string } | { since: string; until: string };
```

The trigger shows the preset label, or `since → until`.

- [ ] **Step 2: `BreakdownPicker`.** `Popover` + `Command` (the `ReportBuilder.tsx:132-174` idiom) over `REPORT_BREAKDOWNS`, grouped:
  - Entity — `campaign`, `adset`, `ad`
  - Audience — `age`, `gender`, `age_gender`, `country`, `region`, `market`
  - Placement — `platform`, `placement`, `device`
  - Time — `hour`, `hour_audience`, `frequency`
  - Assets — the seven `*_asset` dims, each marked **ad level only**
  Keep `none` pinned at the top as "Total (no breakdown)". Keep the `Split by day` checkbox beside it.

- [ ] **Step 3: Commit.**

---

### Task 6: Rebuild the builder around the new controls

**Files:** Modify `src/components/chat/ReportBuilder.tsx`

- [ ] **Step 1** Replace the chip cloud (`:253-259`) with a summary row — `{columns.length} columns selected` + an `Edit columns` button opening `ColumnPickerDialog`.
- [ ] **Step 2** Replace the range chips (`:216-247`) with `RangePicker`, and the native `<select>` (`:265-275`) with `BreakdownPicker`.
- [ ] **Step 3** Fix the forced ordering at `:92`: emit `columns` as the user ordered them, not `REPORT_COLUMNS.filter(...)`.
- [ ] **Step 4** Give the markup field a real `<label>` + helper text instead of using its placeholder as documentation (`:296`).
- [ ] **Step 5** Load availability: when `clientId` and the range are set, call `getReportCatalog` and pass `keys` into the dialog. Debounce on change; tolerate failure by passing `null` (picker then shows everything rather than nothing).
- [ ] **Step 6** `ReportRequest` gains `preset?: string`; keep `days`/`since`/`until` so the LLM chat path is unaffected.
- [ ] **Step 7** Verify in browser. Commit.

---

### Task 7: Preview for wide reports

**Files:** Modify `src/components/chat/ReportBlock.tsx`

Sticky header and footer already exist (`:98-100`, `:131`). Missing: horizontal scroll and a sticky dimension column.

- [ ] **Step 1** Change the table from `w-full` to `min-w-max` and add `whitespace-nowrap` to `th`/`td`, so a 30-column report scrolls horizontally instead of wrapping every header.
- [ ] **Step 2** Make the first column sticky when it is the dimension column: `sticky left-0 z-10 bg-card` on the `th`/`td` at index 0 when `columns[0].key === "_dim"`. Note `tfoot` needs the same treatment or the Total label scrolls away from its row.
- [ ] **Step 3** Above ~12 columns, show an inline warning beside the PDF button: `PDF is unreadable beyond ~12 columns — use CSV`. Keep the button enabled; do not silently emit garbage.
- [ ] **Step 4** **No virtualization.** `MAX_ROWS = 500` (`report.ts:520`) caps output and 500×30 cells is unremarkable. Written down so nobody adds a windowing dependency.
- [ ] **Step 5** Verify in browser with a 30-column report. Commit.

---

### Task 8: Route split, history, templates, frozen run

**Files:** `src/routes/reports.tsx` (rewrite as layout), Create `reports.index.tsx`, `reports.new.tsx`, `reports.$runId.tsx`, `reports.templates.tsx`

- [ ] **Step 1: Layout.** Rewrite `src/routes/reports.tsx` as a layout rendering `<Outlet/>` plus three `Link` tabs (History `/reports`, New `/reports/new`, Templates `/reports/templates`), using `activeOptions={{ exact: to === "/reports" }}` and `activeProps` exactly as `src/portal/components/Shell.tsx:38-54` does. Keep the existing `head`/meta.
- [ ] **Step 2: `reports.new.tsx`** — today's `reports.tsx` body verbatim, plus: read `?template=<id>` and seed the builder; call `createReportRun` instead of `generateClientReport` and keep the returned `runId`; pass `runId` into `ReportBlock` so its export buttons can stamp.
- [ ] **Step 3: `reports.index.tsx`** — history. `loader` calls `listReportRuns`; render a table of Client · Range · Rows · Exported at · Formats · By, newest first, each row linking to `/reports/:runId`. Empty state distinguishes "nothing exported yet" from "no clients mapped".
- [ ] **Step 4: `reports.$runId.tsx`** — `loader` calls `getReportRun`; render the frozen `payload` through `ReportBlock` read-only. The payload carries its own `columns`, so it renders from itself and never re-consults the catalog — that is why the whole payload is stored rather than params plus a key list. If a stored key is no longer in the catalog, still render, and show `n columns in this report are no longer available`.
- [ ] **Step 5: `reports.templates.tsx`** — list + create/edit form + delete. Client select is optional (empty = generic); campaign filter only enabled when a client is chosen. After each mutation `await router.invalidate()`; surface `{ok:false,error}` inline via `useState<string|null>`.
- [ ] **Step 6** Export stamping: in `ReportBlock`, after a successful CSV/PDF download, call `markReportExported({ runId, format })` when a `runId` prop is present. Fire-and-forget with a caught error — a failed stamp must never block a download the user already has.
- [ ] **Step 7** Verify every route in the browser. Commit.

---

### Task 9: Verify and ship

- [ ] **Step 1** `bun test src/lib src/server/agg.test.ts src/server/agent/report.test.ts src/server/fns/report-catalog.test.ts src/server/fns/reports.test.ts` → green apart from the 4 known DB failures.
- [ ] **Step 2** `bun run lint && bun run build`.
- [ ] **Step 3** **Run the DDL on the droplet before deploying** (the tables do not exist yet):

```bash
ssh root@159.65.110.111 "psql \"\$(grep '^DATABASE_URL=' /opt/meta-dashboard/.env | cut -d= -f2-)\" -f -" < ddl.sql
```

Then confirm both tables exist with `\dt report_*`.

- [ ] **Step 4** Browser smoke on the real app: create a template, run it, export CSV, confirm the run appears in History with a format stamp, open the frozen run and confirm identical numbers, and confirm the picker shows 112 metrics with an availability count.
- [ ] **Step 5** Deploy per the standing directive: push `origin`/`droplet`/`madsmonitor`, then on the droplet `git pull && bun run build && systemctl restart meta-web meta-sync`. Verify `curl -H "Accept: text/html"` returns 302 → `/login` and `/login` returns 200 (a bare `curl` returns 401 by design — `gate.ts:271-278`).

---

## Self-Review

**Spec coverage.** Part A: semantics → Task 2 (`createReportRun` + `markReportExported`); schema → Task 1; routes → Task 8; draft pruning → Task 2 Step 6. Part C: layout → Task 8 Step 1; columns dialog → Task 4; range/breakdown → Task 5; builder → Task 6; preview → Task 7; export limits → Task 7 Step 3.

**Corrections to the spec made here.** (1) The spec said the preview "gets sticky header row" — it already has one (`ReportBlock.tsx:98-100`); only horizontal scroll and a sticky first column are missing. (2) The spec's `runReport` was renamed `createReportRun` (collision with `report.ts:685`). (3) The spec named nine metric groups including "Quality & ranking"; Plan 1 removed that group as unpopulatable, so the picker has eight.

**Placeholder scan.** Task 2 Step 3 gives signatures rather than full bodies for the seven DB functions. That is deliberate: each is a five-line Drizzle query whose exact shape is fixed by the quoted `pages.ts` pattern, and the non-obvious parts (validation rules, export-format arithmetic, delegation to `reportForClient`, the `runReport` name collision) are specified precisely. Every behavioural rule has a test in Step 1 or a browser check in Task 9.

**Type consistency.** `TemplateInput` is used in Tasks 2 and 8. `RangeValue` in Tasks 5 and 6. `runId` threads Task 8 Step 2 → `ReportBlock` → Step 6. `availableKeys: string[] | null` is the same shape in Tasks 4 and 6.
