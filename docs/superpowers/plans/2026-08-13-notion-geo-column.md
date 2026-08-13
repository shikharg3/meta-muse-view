# Notion `Geo` Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a machine-owned `🤖 Geo Delivered 14d` column to the Notion campaigns board showing where each live engagement's spend actually landed, without touching the human `Geo's` brief beside it.

**Architecture:** A pure formatter turns already-fetched country/region breakdown rows into cell text. The existing `syncNotionDailyBudgets` job derives it per board row from the row's own attributed campaigns over the engagement-clamped `paceWindow()`, and writes it through the same `ensureColumn` + `setPageValue` path the destination column already uses. Nothing reads or writes `Geo's`.

**Tech Stack:** TypeScript, Bun test, Drizzle ORM + Postgres, Notion API `2025-09-03`, TanStack Start.

**Design spec:** `docs/superpowers/specs/2026-08-13-notion-geo-column-design.md`

**Status: SHIPPED 2026-08-13**, merged to trunk as `0eae2aa` and deployed. `🤖 Geo Delivered 14d`
exists on the board with 12 cells; `Geo's` still holds all 79 of its briefs. Task 1's shipped code
differs from this plan after three review rounds — see the deviation table in that task before
editing `src/lib/geo-cell.ts`. Task 5 also absorbed a fix the plan did not anticipate: the board's
`Funds Remaining ($)` column had been renamed, so the job had silently stopped resolving it and the
first real write would have created a duplicate. Caught by the Task 6 dry run, which is the reason
that step exists.

---

## Before you start

**Branch.** Trunk is `feat/meta-integration`. At the time of writing it is checked out in a second
worktree (`I:/Coding/DOTMeta/mmv-checkin`) and the other operator is working on `feat/infra-monitor`
in the main checkout. Do your work on trunk, in whichever worktree has it. Do not commit this feature
onto `feat/infra-monitor`.

**Confirm the files you are about to touch are clean:**

```bash
git status --short src/sync/jobs/notion-budget.ts src/sync/jobs/notion-budget.test.ts src/lib/
```

Expected: no output. If either `notion-budget` file comes back modified, stop and ask — do not stash,
commit, or `git add -p` around someone else's work.

**No schema change.** This feature adds no table and no column to Postgres. Do not run
`drizzle-kit push`.

**The database is production.** `DATABASE_URL` points at prod through an SSH tunnel. Every query you
run locally hits real data. Only `bun test` is redirected, to `TEST_DATABASE_URL`.

---

## Files

| File                                           | Responsibility                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/lib/geo-cell.ts` (create)                 | Pure: breakdown rows → cell text. No I/O, no imports from `sync/`, `db/`, `server/`.    |
| `src/lib/geo-cell.test.ts` (create)            | Formatter behaviour: the drill trigger, `unknown`, trimming.                            |
| `src/sync/jobs/notion-budget.ts` (modify)      | Column constants, `geoSkipReason`, `planGeo`, the `geoOf` query, row wiring, the write. |
| `src/sync/jobs/notion-budget.test.ts` (modify) | `planGeo`, `geoSkipReason`, and the column-name collision guard.                        |

The formatter lives in `src/lib/` rather than in the job for the reason `src/lib/delivery-status.ts`
does: `notion-budget.ts` is already 1,475 lines, and a pure function with no I/O is the part most
worth testing in isolation. The decision functions (`planGeo`, `geoSkipReason`) stay in the job
because they depend on `notLive` and on the job's own skip vocabulary.

---

### Task 1: The pure cell formatter

**Files:**

- Create: `src/lib/geo-cell.ts`
- Test: `src/lib/geo-cell.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/geo-cell.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { geoCell, UNKNOWN_GEO, type GeoSpend } from "./geo-cell";

const country = (value: string, spend: number): GeoSpend => ({ type: "country", value, spend });
const region = (value: string, spend: number): GeoSpend => ({ type: "region", value, spend });

test("a single delivering country drills into its regions", () => {
  // 79 of 93 spending campaigns deliver to one country, so without this the cell reads "US 100%"
  // on most rows and says nothing the brief did not already say.
  expect(
    geoCell([
      country("US", 1000),
      region("California", 500),
      region("Texas", 300),
      region("Florida", 200),
    ]),
  ).toBe("US 100%\nCalifornia 50% · Texas 30% · Florida 20%");
});

test("a single country with no region rows writes one line", () => {
  expect(geoCell([country("AR", 2075)])).toBe("AR 100%");
});

test("several delivering countries stay at country level and the tail is counted", () => {
  // OneAgency / Slots.lv shape: 22 countries, 18 of them rounding to nothing. The region row is
  // present and must be ignored — regions are only meaningful under a single country.
  const rows = [
    country("US", 930),
    country("ZA", 20),
    country("GE", 20),
    country("IT", 10),
    ...Array.from({ length: 18 }, (_, i) => country(`X${i}`, 1)),
    region("California", 500),
  ];
  expect(geoCell(rows)).toBe("US 93% · ZA 2% · GE 2% · IT 1% · +18 more");
});

test("more than eight material countries collapse into a count", () => {
  const rows = Array.from({ length: 12 }, (_, i) => country(`C${i}`, 100 - i));
  const cell = geoCell(rows);
  expect(cell.split(" · ")).toHaveLength(9);
  expect(cell.endsWith("+4 more")).toBe(true);
});

test("`unknown` counts toward the split but never blocks or enters the drill", () => {
  // Meta's bucket for spend it could not place. It is real money, so it belongs in the denominator,
  // but it is not a country and must not stop the drill from firing on the one that is.
  expect(
    geoCell([
      country("US", 996),
      country(UNKNOWN_GEO, 4),
      region("California", 600),
      region("Texas", 400),
    ]),
  ).toBe("US 100% · +1 more\nCalifornia 60% · Texas 40%");
});

test("two identified countries suppress the drill even when one is negligible", () => {
  // The region breakdown is not scoped by country, so CA's regions would be mixed into a line
  // labelled US. Silence beats a plausible lie.
  expect(geoCell([country("US", 996), country("CA", 4), region("California", 600)])).toBe(
    "US 100% · +1 more",
  );
});

test("no delivered spend produces no cell", () => {
  expect(geoCell([])).toBe("");
  expect(geoCell([country("US", 0)])).toBe("");
  // Regions with no country behind them are not a cell either.
  expect(geoCell([region("California", 500)])).toBe("");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/lib/geo-cell.test.ts`

Expected: FAIL — `Cannot find module './geo-cell'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/geo-cell.ts`:

```typescript
/**
 * Formats the Notion board's `🤖 Geo Delivered 14d` cell from Meta's country and region breakdowns.
 *
 * Pure by design: the caller passes already-fetched rows, so this module imports nothing from
 * `sync/`, `db/` or `server/`. Which window they were measured over is the caller's business — this
 * only turns spend into shares.
 *
 * The cell answers "where did the money actually land". That is a DIFFERENT question from the human
 * `Geo's` column beside it, which records what was agreed (prose, ranked preferences, budget splits).
 * Never merge the two, and never write `Geo's`.
 */

/** Meta's bucket for spend it could not place. Real money, so it counts toward the total, but it is
 *  not a country: it must never trigger the region drill nor appear inside one. */
export const UNKNOWN_GEO = "unknown";

/** Shares below this round to nothing useful and only crowd the cell. */
const MIN_SHARE = 0.01;

/** Entries kept on a line before the remainder collapses into "+K more". */
const MAX_ENTRIES = 8;

/** One breakdown bucket's spend over the measured window. */
export interface GeoSpend {
  type: "country" | "region";
  value: string;
  spend: number;
}

/**
 * One line of shares, ordered by spend: `US 93% · ZA 2% · IT 1% · +18 more`. Entries under
 * `MIN_SHARE`, and any beyond `MAX_ENTRIES`, are counted rather than shown — the count is what tells
 * the reader a long tail exists.
 */
function shareLine(entries: GeoSpend[], total: number): string {
  const ranked = [...entries].sort((a, b) => b.spend - a.spend);
  const kept = ranked.filter((e) => e.spend / total >= MIN_SHARE).slice(0, MAX_ENTRIES);
  const parts = kept.map((e) => `${e.value} ${Math.round((e.spend / total) * 100)}%`);
  const dropped = ranked.length - kept.length;
  if (dropped > 0) parts.push(`+${dropped} more`);
  return parts.join(" · ");
}

/**
 * The cell text. Line 1 is the country split. Line 2 is the region split, present only when exactly
 * one identified country delivered: the region breakdown is not scoped by country, so mixing two
 * countries' regions under a single-country heading would be a quiet lie.
 *
 * Returns "" when nothing delivered. The caller decides whether that means "clear the cell" or "the
 * breakdown data has not caught up" — this function cannot tell those apart, and guessing wrong
 * blanks a delivering row.
 *
 * Length is bounded by construction (two lines, ≤8 entries each), so there is no truncation branch.
 */
export function geoCell(rows: GeoSpend[]): string {
  const countries = rows.filter((r) => r.type === "country" && r.spend > 0);
  const total = countries.reduce((n, r) => n + r.spend, 0);
  if (total <= 0) return "";

  const lines = [shareLine(countries, total)];
  const identified = countries.filter((r) => r.value !== UNKNOWN_GEO);
  if (identified.length === 1) {
    const regions = rows.filter((r) => r.type === "region" && r.spend > 0);
    const regionTotal = regions.reduce((n, r) => n + r.spend, 0);
    if (regionTotal > 0) lines.push(shareLine(regions, regionTotal));
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/lib/geo-cell.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/geo-cell.ts src/lib/geo-cell.test.ts
git commit -m "feat(notion): pure formatter for the delivered-geo cell"
```

**Executed 2026-08-13 as `6d9a369`. The shipped code differs from the listing above** — three rounds
of code review found real defects in it, and the fixes are deliberate. Do not "restore" this task's
original code.

| Change                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Region line suppressed when nothing but Meta's `unknown` bucket would be **named on it**     | Measured: 123 campaigns carry a positive `unknown` **region** bucket over 60 days (535 rows, $116), against 38 country rows at $0. Without this, `[US 1000, region unknown 1000]` rendered `US 100%` / `unknown 100%` — a second line repeating the first and naming no place. `unknown` deliberately stays in the region _denominator_: removing it would make the placed shares sum to 100% and hide the unplaced spend                    |
| Selection extracted into a private `keptEntries`, which both `shareLine` and that guard call | Round 2 caught the first version of the guard testing the RAW rows while the rendered line is filtered by `MIN_SHARE` — so `[US 1000, California 5, unknown 995]` still produced `unknown 100% · +1 more`, the exact output the guard existed to prevent. A share-threshold guard would instead have suppressed the legitimate leader-exception case. Asking "what will the line actually name" is the only formulation that gets both right |
| Ties broken on `value`, not left to input order                                              | `sort` is stable, and the upstream SQL has no `ORDER BY`, so equal-spend buckets could reorder between syncs on unchanged data. Writes are gated on the cell text having changed, so a tie flip would fire a write and reset `Last edited time` — the signal that gating exists to protect                                                                                                                                                   |
| Leader kept when every share is under `MIN_SHARE`                                            | Spend spread across 100+ buckets rendered a bare `+101 more`: a cell with no content, worse than the `""` the module returns elsewhere                                                                                                                                                                                                                                                                                                       |
| `GeoSpend` doc states the pre-aggregation precondition                                       | `insights_breakdown_daily` is keyed per day, so an unaggregated window query repeats each value once per date. Task 5's `geoOf` does `GROUP BY`, so this is a contract to state, not a bug to defend against                                                                                                                                                                                                                                 |
| 7 tests became 14                                                                            | Added the exactly-`MAX_ENTRIES` boundary (`+0 more` was otherwise untested), negative spend, the exactly-`MIN_SHARE` boundary, and one per new behaviour above                                                                                                                                                                                                                                                                               |

Two consequences worth knowing before touching this file again:

- The tie-break changed one existing expectation: `ZA`/`GE` both at spend 20 now render `GE` first.
  The fixture was not touched.
- **Four separate doc comments in this file were caught asserting behaviour the code did not have**,
  each time after a fix changed the code and not the comment. If you edit `geo-cell.ts`, re-read
  every comment in it before committing.

---

### Task 2: Column constants and the collision guard

**Files:**

- Modify: `src/sync/jobs/notion-budget.ts` (constants block, after `AUTO_ACCOUNT_STATUS_COLUMN`)
- Test: `src/sync/jobs/notion-budget.test.ts`

This task exists on its own because the column _name_ is the single thing that can destroy data here,
and the guard against it is a one-line test that must not be buried in a larger commit.

- [ ] **Step 1: Write the failing test**

Add to the imports at the top of `src/sync/jobs/notion-budget.test.ts`:

```typescript
import { resolvePropertyKey } from "@/notion/parse";
```

and add `GEO_COLUMN` and `AUTO_GEO_COLUMN` to the existing `from "./notion-budget"` import list.

Append this test:

```typescript
test("the geo column cannot collide with the human `Geo's` brief", () => {
  // ensureColumn resolves by keyShape and RENAMES what it finds. keyShape strips punctuation and the
  // emoji, so keyShape("Geo's") === keyShape("🤖 Geo's") — passing "Geo's" would rename the team's
  // brief column and begin overwriting 79 rows of prose that no code can regenerate.
  expect(resolvePropertyKey(["Geo's", "Campaign"], GEO_COLUMN)).toBeNull();
  expect(resolvePropertyKey(["Geo's", "Campaign"], AUTO_GEO_COLUMN)).toBeNull();
  // It must still find its own column once the marker has been stamped on it.
  expect(resolvePropertyKey([AUTO_GEO_COLUMN], GEO_COLUMN)).toBe(AUTO_GEO_COLUMN);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/sync/jobs/notion-budget.test.ts -t "cannot collide"`

Expected: FAIL — `GEO_COLUMN` is not exported.

- [ ] **Step 3: Add the constants**

In `src/sync/jobs/notion-budget.ts`, immediately after the `AUTO_ACCOUNT_STATUS_COLUMN` declaration:

```typescript
/**
 * Where delivered spend actually landed. A SEPARATE column from the board's `Geo's`, which records
 * the brief — prose, ranked preferences, even budget splits — and stays human-owned forever.
 *
 * The name is load-bearing. `ensureColumn` resolves by `keyShape`, which strips punctuation and the
 * emoji marker, and it RENAMES whatever it matches. `keyShape("Geo's") === keyShape("🤖 Geo's")`, so
 * naming this column after the brief would rename the brief and start overwriting it. The window is
 * in the name for the same reason it is in `Avg Daily Spend 7d ($)`: a percentage split is
 * meaningless without one.
 */
export const GEO_COLUMN = "Geo Delivered 14d";
export const AUTO_GEO_COLUMN = `${AUTO_MARKER} ${GEO_COLUMN}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/sync/jobs/notion-budget.test.ts -t "cannot collide"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/jobs/notion-budget.ts src/sync/jobs/notion-budget.test.ts
git commit -m "feat(notion): geo column constants, with a collision guard on the brief"
```

---

### Task 3: `geoSkipReason` — what geo refuses to derive

**Files:**

- Modify: `src/sync/jobs/notion-budget.ts` (after `planDestinations`)
- Test: `src/sync/jobs/notion-budget.test.ts`

- [ ] **Step 1: Write the failing test**

Add `geoSkipReason` to the `from "./notion-budget"` import list, then append:

```typescript
test("geo skips what it cannot attribute, but never for currency", () => {
  const ok = { ambiguous: false, accountIds: ["act_1"], syncedAccountIds: ["act_1"] };
  expect(geoSkipReason(ok)).toBeNull();
  expect(geoSkipReason({ ...ok, ambiguous: true })).toBe(
    "campaigns on a shared account could not be split by name",
  );
  expect(geoSkipReason({ ambiguous: false, accountIds: [], syncedAccountIds: [] })).toBe(
    "no ad accounts on this row",
  );
  expect(geoSkipReason({ ...ok, syncedAccountIds: [] })).toBe(
    "row's ad accounts are not visible to the Meta token",
  );
  // The dollar columns refuse a non-USD row because they sum money across accounts. This cascade
  // takes no currency argument at all: a share needs no FX rate, so a EUR row still gets a geo cell.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/sync/jobs/notion-budget.test.ts -t "geo skips"`

Expected: FAIL — `geoSkipReason` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/sync/jobs/notion-budget.ts`, after `planDestinations`:

```typescript
/**
 * Why a row's geo cannot be derived, or null when it can.
 *
 * Deliberately NOT the cascade the dollar columns use. That one also refuses a foreign account
 * currency (`COLUMN_CURRENCY`), because summing money across currencies needs an FX rate. A
 * percentage split does not, so a row whose accounts are denominated elsewhere still gets a cell —
 * and currency is therefore absent from this signature rather than merely unused in it.
 */
export function geoSkipReason(input: {
  ambiguous: boolean;
  accountIds: string[];
  syncedAccountIds: string[];
}): string | null {
  const { ambiguous, accountIds, syncedAccountIds } = input;
  if (ambiguous) return "campaigns on a shared account could not be split by name";
  if (accountIds.length === 0) return "no ad accounts on this row";
  if (syncedAccountIds.length === 0) return "row's ad accounts are not visible to the Meta token";
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/sync/jobs/notion-budget.test.ts -t "geo skips"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/jobs/notion-budget.ts src/sync/jobs/notion-budget.test.ts
git commit -m "feat(notion): geo skip cascade, deliberately currency-blind"
```

---

### Task 4: `planGeo` — write, clear, or leave alone

**Files:**

- Modify: `src/sync/jobs/notion-budget.ts` (after `geoSkipReason`)
- Test: `src/sync/jobs/notion-budget.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `planGeo` to the `from "./notion-budget"` import list and add
`import type { GeoSpend } from "@/lib/geo-cell";` to the test file. Append:

```typescript
const usOnly: GeoSpend[] = [{ type: "country", value: "US", spend: 1000 }];

test("the geo cell is written for live rows and cleared when nothing delivered", () => {
  expect(
    planGeo({ status: "Live", current: "", rows: usOnly, windowSpend: 1000, skip: null }),
  ).toEqual({
    text: "US 100%",
    skip: null,
  });
  expect(
    planGeo({ status: "Live", current: "US 100%", rows: usOnly, windowSpend: 1000, skip: null }),
  ).toEqual({ text: null, skip: "unchanged" });
  // Live, nothing delivered, a stale value on the board: clear it. A leftover geo reads as "we are
  // running here" when nothing is.
  expect(
    planGeo({ status: "Live", current: "AR 100%", rows: [], windowSpend: 0, skip: null }),
  ).toEqual({
    text: "",
    skip: null,
  });
  // Nothing delivered and nothing recorded: leave it alone.
  expect(planGeo({ status: "Live", current: "", rows: [], windowSpend: 0, skip: null })).toEqual({
    text: null,
    skip: "nothing delivered in the window",
  });
});

test("spend with no breakdown rows behind it is a data gap, and must never blank the cell", () => {
  // Breakdowns refresh on the daily `full` pass (`sync/cycle.ts`); insights_daily refreshes hourly.
  // A row that spent but has no country rows yet is mid-lag, not geo-less. Clearing here would
  // report a sync fault as a geo fact on a row delivering perfectly well.
  expect(
    planGeo({ status: "Live", current: "US 100%", rows: [], windowSpend: 420, skip: null }),
  ).toEqual({ text: null, skip: "breakdown data not caught up" });
});

test("a row too new for a pace window is skipped, not cleared", () => {
  expect(
    planGeo({ status: "Live", current: "US 100%", rows: [], windowSpend: null, skip: null }),
  ).toEqual({ text: null, skip: "engagement too new to measure" });
});

test("liveness outranks every other geo skip reason", () => {
  const caller = "no ad accounts on this row";
  expect(
    planGeo({ status: "Live", current: "", rows: usOnly, windowSpend: 1000, skip: caller }),
  ).toEqual({ text: null, skip: caller });
  for (const status of ["Full Budget Finished", "Not started", null])
    expect(
      planGeo({ status, current: "AR 100%", rows: usOnly, windowSpend: 1000, skip: caller }),
    ).toEqual({ text: null, skip: "not a live engagement" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/sync/jobs/notion-budget.test.ts -t "geo cell"`

Expected: FAIL — `planGeo` is not exported.

- [ ] **Step 3: Write the implementation**

Add the import at the top of `src/sync/jobs/notion-budget.ts`:

```typescript
import { geoCell, type GeoSpend } from "@/lib/geo-cell";
```

and, after `geoSkipReason`:

```typescript
/**
 * The geo cell for one row: where its delivered spend actually landed.
 *
 * Non-live rows are never written, like every other machine column — their accounts get recycled and
 * the recorded value is history. A live row with nothing delivered has its cell cleared, for the
 * reason `planDestinations` clears.
 *
 * The case that must NOT clear is spend in the window with no breakdown rows behind it. Breakdowns
 * refresh on the daily `full` pass only (`sync/cycle.ts`) while `insights_daily` refreshes hourly, so
 * blanking there reports a sync lag as a geo fact on a row that is delivering fine. `windowSpend` is
 * what separates the two, and it is null when there is no window to measure over at all.
 */
export function planGeo(input: {
  status: string | null;
  current: string;
  rows: GeoSpend[];
  /** Spend over the same window and the same campaigns, from `insights_daily`. Null = no window. */
  windowSpend: number | null;
  /** Why the row cannot be derived, from `geoSkipReason`; null when it can. */
  skip: string | null;
}): TextPlan {
  const { status, current, rows, windowSpend, skip } = input;
  if (notLive(status)) return { text: null, skip: "not a live engagement" };
  if (skip) return { text: null, skip };
  if (windowSpend === null) return { text: null, skip: "engagement too new to measure" };
  const text = geoCell(rows);
  if (!text) {
    if (windowSpend > 0) return { text: null, skip: "breakdown data not caught up" };
    return current.trim()
      ? { text: "", skip: null }
      : { text: null, skip: "nothing delivered in the window" };
  }
  if (text === current.trim()) return { text: null, skip: "unchanged" };
  return { text, skip: null };
}
```

- [ ] **Step 4: Run the whole job test file**

Run: `bun test src/sync/jobs/notion-budget.test.ts`

Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/jobs/notion-budget.ts src/sync/jobs/notion-budget.test.ts
git commit -m "feat(notion): planGeo, with a data-gap guard against blanking live rows"
```

---

### Task 5: Wire the derivation into the sync job

**Files:**

- Modify: `src/sync/jobs/notion-budget.ts`

No new unit tests here — every decision is already covered by Tasks 1–4, and what remains is
plumbing whose proof is the dry run in Task 6. The task ends when the file typechecks and the
existing suite still passes.

- [ ] **Step 1: Add the reporting fields to `NotionBudgetRow`**

In the `NotionBudgetRow` interface, after the `destSkip` field:

```typescript
/** Geo cell as it stood, what was derived, what was written (null = untouched), and why skipped.
 *  `geoProposed` exists for the same reason `endProposed` does: on a dry run the column has not
 *  been created yet, so there is no id to write against and `geoWritten` stays null. */
geoCurrent: string;
geoProposed: string | null;
geoWritten: string | null;
geoSkip: string | null;
```

- [ ] **Step 2: Add `geoCurrent` to `BoardRow`**

In the `BoardRow` interface, after `destCurrent: string;`:

```typescript
geoCurrent: string;
```

- [ ] **Step 3: Add the `geoOf` query helper**

In `syncNotionDailyBudgets`, immediately after the `spendOf` helper:

```typescript
/**
 * Country and region spend for a set of campaigns over a closed window. Campaign is the finest
 * grain these breakdowns are synced at, which is exactly board-row grain once the caller has
 * narrowed to the row's own attributed campaigns.
 */
const geoOf = async (campaignIds: string[], from: string, to: string): Promise<GeoSpend[]> => {
  if (campaignIds.length === 0) return [];
  const rows = await db
    .select({
      type: schema.insightsBreakdownDaily.breakdownType,
      value: schema.insightsBreakdownDaily.breakdownValue,
      spend: sql<number>`coalesce(sum(${schema.insightsBreakdownDaily.spend}), 0)`,
    })
    .from(schema.insightsBreakdownDaily)
    .where(
      and(
        eq(schema.insightsBreakdownDaily.level, "campaign"),
        inArray(schema.insightsBreakdownDaily.breakdownType, ["country", "region"]),
        inArray(schema.insightsBreakdownDaily.entityId, campaignIds),
        gte(schema.insightsBreakdownDaily.date, from),
        lte(schema.insightsBreakdownDaily.date, to),
      ),
    )
    .groupBy(
      schema.insightsBreakdownDaily.breakdownType,
      schema.insightsBreakdownDaily.breakdownValue,
    );
  return rows.map((r) => ({
    type: r.type === "region" ? "region" : "country",
    value: r.value,
    spend: Number(r.spend),
  }));
};
```

- [ ] **Step 4: Resolve the column**

In the data-source loop, immediately after the `destCol` block and its `if (destCol?.error)` line:

```typescript
const geoCol = await ensureColumn(
  notion,
  dsId,
  props,
  GEO_COLUMN,
  AUTO_GEO_COLUMN,
  "rich_text",
  result.columnsTouched,
  opts.dryRun ?? false,
);
if (geoCol?.error) result.warning = geoCol.error;
```

- [ ] **Step 5: Read the current cell**

In the page loop where the `BoardRow` literal is built, after the `destCurrent:` line:

```typescript
        geoCurrent: geoCol ? textCell(page, geoCol.column.id) : "",
```

- [ ] **Step 6: Add `geo` to `RowWork` and to the two early pushes**

In the `RowWork` interface, after `dest: TextPlan;`:

```typescript
geo: TextPlan;
```

In the orphans loop's `work.push({ ... })`, after the `dest:` line:

```typescript
        geo: { text: null, skip: noMapping },
```

In the non-live `work.push({ ... })`, after the `dest:` line:

```typescript
            geo: { text: null, skip: "not a live engagement" },
```

- [ ] **Step 7: Derive geo for live rows**

In the live-row body, immediately after the `if (!skip) { ... }` block that sets `spentSinceStart`
and `dailyPace`, and before `const remaining = budgetRemaining(...)`:

```typescript
// Geo comes from the row's OWN attributed campaigns over the same engagement-clamped window
// as the pace figures, so the two can never describe different periods. Its skip cascade is
// deliberately not `skip`: that one refuses a foreign account currency, which cannot block a
// percentage — and `paceTotal` above is unusable here for exactly that reason, since it is
// computed inside `if (!skip)` and over a broader, account-derived id set than `mine`.
const geoReason = geoSkipReason({
  ambiguous: ambiguous.has(row.pageId),
  accountIds: row.accountIds,
  syncedAccountIds: synced,
});
let geoRows: GeoSpend[] = [];
let geoWindowSpend: number | null = null;
if (!geoReason && pw) {
  const mineIds = mine.map((c) => c.id);
  [geoRows, geoWindowSpend] = await Promise.all([
    geoOf(mineIds, pw.from, until),
    spendOf(mineIds, pw.from, until),
  ]);
}
const geo = planGeo({
  status: row.status,
  current: row.geoCurrent,
  rows: geoRows,
  windowSpend: geoWindowSpend,
  skip: geoReason,
});
```

- [ ] **Step 8: Pass `geo` through both live pushes**

There are two `work.push({ ... })` calls in the live path — one inside the projection branch (just
after `end = planEndDate({ ... })`) and one at the end of the loop body. Add this line after the
`dest,` line in **both**:

```typescript
          geo,
```

- [ ] **Step 9: Report it**

In the write loop, add `geo` to the destructure:

```typescript
const { row, sum, budget, spend, funds, end, dest, geo, status, remainingPlan } = w;
```

and to the `detail` literal, after the `destSkip:` line:

```typescript
        geoCurrent: row.geoCurrent,
        geoProposed: geo.text,
        geoWritten: null,
        geoSkip: geo.skip,
```

- [ ] **Step 10: Write the cell**

Immediately after the destination write block (the one ending
`} else if (dest.skip === "unchanged") result.unchanged += 1; else result.skipped += 1;`):

```typescript
if (geo.text !== null && geoCol) {
  if (!opts.dryRun) {
    await notion.setPageValue(row.pageId, geoCol.column.id, {
      rich_text: geo.text ? [{ type: "text", text: { content: geo.text } }] : [],
    });
    await sleep(WRITE_GAP_MS);
  }
  detail.geoWritten = geo.text;
  result.updated += 1;
} else if (geo.skip === "unchanged") result.unchanged += 1;
else result.skipped += 1;
```

- [ ] **Step 11: Typecheck and lint**

Run: `bunx tsc --noEmit && bun run lint`

Expected: both clean, no output beyond the lint summary.

- [ ] **Step 12: Run the job's tests**

Run: `bun test src/sync/jobs/notion-budget.test.ts src/lib/geo-cell.test.ts`

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/sync/jobs/notion-budget.ts
git commit -m "feat(notion): derive and write the delivered-geo cell per board row"
```

---

### Task 6: Dry run against the live board

The board is shared with the whole team and this run is the only thing standing between a naming
mistake and 79 overwritten briefs. **Do not skip it, and do not deploy before it passes.**

- [ ] **Step 1: Open the tunnel to production Postgres**

```bash
ssh -N -L 127.0.0.1:5432:127.0.0.1:5432 <droplet>
```

Leave it running in its own terminal. Notion credentials live encrypted in that database, so the job
cannot resolve the board without it.

- [ ] **Step 2: Write the runner**

Create `.tmp-geo-dryrun.ts` (scratch — **not** gitignored, deleted in Step 5):

```typescript
import { syncNotionDailyBudgets } from "@/sync/jobs/notion-budget";

const r = await syncNotionDailyBudgets(undefined, { dryRun: true });
if (!r) throw new Error("Notion is not configured — check the tunnel and the stored credentials");

console.log("columnsTouched:", r.columnsTouched);
console.log("warning:", r.warning);
for (const d of r.details) {
  if (d.geoSkip === "not a live engagement") continue;
  console.log(`\n${d.title} · ${d.status}`);
  console.log(`  current : ${JSON.stringify(d.geoCurrent)}`);
  console.log(`  proposed: ${JSON.stringify(d.geoProposed)}`);
  console.log(`  skip    : ${d.geoSkip}`);
}
process.exit(0);
```

- [ ] **Step 3: Run it**

Run: `bun run .tmp-geo-dryrun.ts`

- [ ] **Step 4: Read the output against these four checks**

1. `columnsTouched` contains `would create "🤖 Geo Delivered 14d"`.
2. `columnsTouched` contains **no** rename mentioning `Geo's`. If it does, stop — the name collides
   and Task 2's guard has been defeated. Do not deploy.
3. Roughly 16 rows appear (the `LIVE_STATUSES` count as of 2026-08-13). Spot-check that these look
   right, from the measured 30-day figures in the design spec — the numbers will differ because the
   window is 14 days and engagement-clamped, but the shape should not:
   - `betonline.ag (July/August 2026)` → `US 100%` plus a US state line
   - `5bet.com (Launch)` → `CA 100%`
   - `OneAgency / Slots.lv` → a multi-country line, no state line
   - `OneAgency / Lucky Rebel` → **different** from `Slots.lv`. Identical cells mean the derivation
     fell back to client grain instead of `mine`, which is the specific defect Task 5 Step 7 avoids.
4. No row shows `proposed: ""` (a clear) while also having spent — that combination is the data-gap
   bug `planGeo` exists to prevent, and it would mean `windowSpend` is not reaching it.

- [ ] **Step 5: Delete the runner**

```bash
rm .tmp-geo-dryrun.ts
```

Scratch `.tmp-*.ts` files are **not** gitignored in this repo. Leaving it risks committing it.

---

### Task 7: Deploy and verify on the board

- [ ] **Step 1: Push to both remotes**

`origin` is what the other operator pulls; `droplet` is the only path code takes onto the server.
Neither substitutes for the other.

```bash
git pull --rebase origin feat/meta-integration
git push origin feat/meta-integration && git push droplet feat/meta-integration
```

- [ ] **Step 2: Deploy**

```bash
ssh <droplet> "EXPECT=$(git rev-parse HEAD) bash /opt/meta-dashboard/deploy/deploy.sh"
```

`meta-sync` must restart — it is long-lived and only picks up new job code on restart. The deploy
script handles both services and fails loudly if health does not come back.

- [ ] **Step 3: Trigger the first real run**

Click **Sync Notion** in the top bar (admin only), or wait for the next cycle. This run creates
`🤖 Geo Delivered 14d` and writes the live rows.

- [ ] **Step 4: Verify on the board**

Open the campaigns board and confirm all four:

1. A new `🤖 Geo Delivered 14d` column exists.
2. `Geo's` still exists, still has its 79 filled cells, and still reads as prose —
   `1. USA 2. Canada`, `Same as before`, `$4500 US, $500 WW daily budget.`
3. Live rows carry a geo cell; `Full Budget Finished` rows do not.
4. `Playw3.com / PlayW3_BeTheBoss` shows the divergence that motivated the feature: a brief naming
   eight countries beside a machine cell dominated by the US.

- [ ] **Step 5: Confirm the service is healthy**

```bash
ssh <droplet> "systemctl is-active meta-web meta-sync"
curl -s -o /dev/null -w "%{http_code}\n" https://analytics.madsmonitor.com/
```

Expected: `active` twice, and a 200 or 3xx.
