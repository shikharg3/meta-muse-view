# Automating the Notion `Geo` column — design

**Date:** 2026-08-13
**Status:** approved design, not yet planned or built

## Problem

The campaigns board carries a `Geo's` column. Nothing in this app reads or writes it —
`parseCampaignRow` (`src/notion/parse.ts:133`) does not pick it up, and the seven `setPageValue`
callsites in `syncNotionDailyBudgets` touch only the `🤖` columns.

**It is a brief, not data.** Measured against the live board on 2026-08-13: `rich_text`, 79 of 92
rows filled, and the contents are prose written by whoever set the engagement up.

| Cell                                                                                                                      |                                   |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `1. USA 2. Canada`                                                                                                        | a ranked preference               |
| `Any of the following GEOS. Select where will perform best for FTD's. DE AT CH CA AU NZ IE FR BE ES IT FI NO HU PL PT CZ` | a shortlist plus an instruction   |
| `$4500 US, $500 WW daily budget.`                                                                                         | a budget split                    |
| `Same as before`                                                                                                          | a reference to a conversation     |
| `USA Specific States`, `Canada Only`, `finland , italy`                                                                   | plain lists, inconsistently cased |

No derivation reproduces that, so the column stays human-owned. What is missing is the other half:
**where the money actually goes**, which Meta knows and the board never shows. The gap is not
hypothetical — on live rows today:

| Row                             | `Geo's` (brief)                                                            | delivered, last 30d                  |
| ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `Playw3.com / PlayW3_BeTheBoss` | Canada, Brazil, Turkey, Korea, Japan, Argentina, Switzerland, South Africa | **US 100%**                          |
| `wildcasino.ag (July/August)`   | 1. USA 2. Canada                                                           | **US 100%**                          |
| `fortunegalaxy.io / Palmluck`   | Brazil, Argentina, Saudi Arabia                                            | **AR 100%**                          |
| `OneAgency / Slots.lv`          | _(empty)_                                                                  | US 93% · ZA 2% · GE 2% · IT 1% · +18 |

## Decisions

| #   | Decision                                                                                       | Rationale                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A **new** machine column; `Geo's` is never written                                             | The brief is the only record of what the client contracted, and no code can regenerate it. Mirrors `Destination URL` (human, contracted) beside `🤖 Destination URL` (machine, actual)                                                                                                |
| 2   | Derived from **delivered spend**, not from `ad_sets.targeting`                                 | Measured: targeting carries junk (`AQ`, `HK`) and misses US-by-state entirely — `bspin.io` targets six US states via `geo_locations.regions` and shows no `US` in `countries`, while delivering US 100%                                                                               |
| 3   | Window is the existing `paceWindow()` — 14d trailing, clamped to the row's `Actual Start Date` | Recycled ad accounts. An uncontested account applies no campaign whitelist, so an unclamped window reports the **previous** engagement's geos. `paceWindow` already exists for exactly this hazard, and reusing it puts the geo cell on the same period as the pacing cells beside it |
| 4   | Region drill only when exactly one country delivered                                           | 79 of 93 spending campaigns are single-country, so a country-only cell reads `US 100%` and adds nothing. A percentage threshold instead of a strict test would let a second country's regions contaminate the split                                                                   |

## The column

|                   |                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- |
| `GEO_COLUMN`      | `Geo Delivered 14d`                                                              |
| `AUTO_GEO_COLUMN` | `🤖 Geo Delivered 14d`                                                           |
| Type              | `rich_text`, created by the existing `ensureColumn` (`notion-budget.ts:592-641`) |

The window is in the name, following `🤖 Avg Daily Spend 7d ($)`. Like that column, the name states
the nominal window; the engagement clamp can make the measured one shorter.

**The column cannot be named `Geo's`, and this is a correctness constraint, not taste.**
`resolvePropertyKey` (`parse.ts:41-46`) falls back to `keyShape` (`parse.ts:34`), which lowercases
and strips every non-alphanumeric character including the emoji marker:

```
keyShape("Geo's") === keyShape("🤖 Geo's") === "geos"
```

`ensureColumn` resolves its `plainName` that way and **renames the match** to the marked name
(`:625-638`). Passing `"Geo's"` would therefore find the human column, rename it `🤖 Geo's`, and
begin overwriting the brief — precisely the outcome decision 1 exists to prevent. `Geo Delivered 14d`
shapes to `geodelivered14d`, which collides with nothing on the board.

## Derivation

Per live board row, inside the existing row loop:

| Input        | Source                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Campaigns    | `mine` (`notion-budget.ts:1104`) — the row's **own** attributed campaigns, the same set the destination cell uses                      |
| Window       | `pw = paceWindow({ startDate: row.startDate, until })` (`:1180`), already computed for the row                                         |
| Spend by geo | `insights_breakdown_daily` (`schema.ts:161-187`), `level = 'campaign'`, `breakdown_type in ('country','region')`, over `mine` and `pw` |

One query per live row, alongside the existing per-row `spendOf` calls (`:669`, `:1194-1197`). Both
breakdown types come back in the same round trip; the region rows are discarded when the drill does
not fire. There are 16 rows in `LIVE_STATUSES` today, so the cost is 16 queries per cycle.

**Row grain, not client grain.** Using client-scoped accounts gives OneAgency's `Slots.lv` and
`Lucky Rebel` rows — and omni agency's `Watt2Trade` and `Farside (2)` — identical cells, since both
rows of a client share its account set. `mine` is per-row and already honours manual add/remove and
cross-client attribution.

**Currency is deliberately not a skip reason**, unlike every existing machine column. Percentages
need no FX rate, so a row whose accounts are denominated outside `COLUMN_CURRENCY` still gets a geo
cell where its dollar columns are refused (`:1157-1161`).

### Data coverage, measured 2026-08-13

|                                     |                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `country`, campaign level, last 30d | 845 rows · 99 entities · **93 of 93** spending campaigns covered · fresh to today |
| `region`, campaign level, last 30d  | 15,223 rows · 95 entities · fresh to today                                        |
| Countries per spending campaign     | 79 single · 10 two · 1 seven · 3 twenty                                           |

## Cell format

Pure `geoCell()` in a **new module** `src/lib/geo-cell.ts` with its own tests. It takes already-fetched
`{ type, value, spend }` rows and returns the cell text: no I/O, and it keeps the 1,475-line job from
growing. This follows `src/lib/delivery-status.ts`, added by the `Account Status` work for the same
reason.

Line 1 is the country split, ordered by spend. Line 2 is the region split, present only when the
drill fires. One shared trimming rule for both lines: **drop entries rounding below 1%, keep at most
8, append `+K more`** counting everything dropped.

```
US 100%
California 23% · Georgia 14% · Pennsylvania 12% · Michigan 12% · Washington 8% · West Virginia 8% · Louisiana 6% · Texas 5% · +4 more
```

```
US 93% · ZA 2% · GE 2% · IT 1% · +18 more
```

```
SA 23% · MX 23% · US 16% · AE 11% · KR 10% · QA 9% · KW 8%
```

Multi-line `rich_text` follows `destinationCell` (`:99-112`), which already writes one URL per line.
The same `TEXT_CELL_LIMIT = 2000` guard applies (`:90`), though the trimming rule keeps real cells
two orders of magnitude below it.

**Drill trigger: exactly one country with delivered spend, `unknown` excluded.** Meta returns
`unknown` as a country bucket for undeterminable geo; it is real spend, so it stays in the
denominator and can appear on line 1, but it never suppresses the drill and never appears on line 2.
The strict single-country test is what makes line 2 sound: the region breakdown is not scoped by
country, so under a "top country ≥ 95%" rule the other 5%'s regions would be silently mixed into a
split labelled with one country.

## Write path

Host: `syncNotionDailyBudgets`. It already resolves per-row accounts, client context, campaign
attribution, column lookup, `dryRun` and write pacing.

- **`planGeo()` sits beside `planDestinations()`** (`:535-551`) and returns the existing `TextPlan`
  (`:522-526`). It needs `notLive`, so it lives in the job rather than in `geo-cell.ts`.
- **Value shape:** `setPageValue(pageId, propId, { rich_text: [...] })` — the shape the destination
  write already uses.
- **No-rewrite guard:** skip when the cell already holds the derived text, mirroring
  `planDestinations` (`:549`). Keeps `Last edited time` meaning "a human edited this".
- **Pacing:** at most one extra `setPageValue` per _changed_ row at `WRITE_GAP_MS = 350`. Percentages
  shift as spend lands, so expect roughly one write per live row per day — 16 writes, ~6 seconds.
- **Reporting:** three fields on `NotionBudgetRow` (`:413-459`) — current cell, proposed cell, skip
  reason — surfaced by the `/sync` route like every other column.

### Skip and clear behaviour

| Condition                                                              | Action                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notLive(row.status)`                                                  | Never touched. Its ad accounts get recycled; the recorded value is history                                                                                 |
| No spend at all in the window                                          | **Clear** the cell if non-empty, else skip. A stale geo reads as "we are running here" when nothing is — the reason `planDestinations` clears (`:544-547`) |
| Spend in the window but no `country` rows for it                       | Skip, `"breakdown data not caught up"`. **Never clear** — see the staleness section below                                                                  |
| `pw === null` (fewer than `MIN_PACE_DAYS` complete days)               | Skip, `"engagement too new to measure"`. No claim to make, and no stale value to clear on a new engagement                                                 |
| Campaigns on a shared account could not be split by name (`ambiguous`) | Skip, reusing the existing reason string (`:1151`)                                                                                                         |
| Row has no ad accounts                                                 | Skip (`:1153`)                                                                                                                                             |
| Row's accounts are not visible to the Meta token                       | Skip (`:1155`)                                                                                                                                             |
| Unchanged                                                              | Not rewritten                                                                                                                                              |

### Staleness, and why clearing needs a guard

The two inputs refresh at different rates. `insights_daily` is pulled on the hourly refresh;
**breakdowns are pulled on the daily `full` pass only** (`cycle.ts:155-156` — `if (!full) return`).
So the geo cell can trail delivery by up to 24 hours. That is stated, not fixed: the same ceiling
already applies to the machine `Account Status` push.

The asymmetry matters more than the lag. If the breakdown job stalls, `country` rows stop arriving
while the campaign keeps spending, the window empties, and a naive "no rows → clear" rule would blank
the cell on a row that is delivering perfectly well — reporting a sync fault as a geo fact.

The guard costs nothing: `paceTotal` is **already computed** over exactly this window at
`notion-budget.ts:1196`. Spend over `pw` with no `country` rows for it is a data gap, so the cell is
left alone; zero spend over `pw` is genuine non-delivery, so the cell clears.

## Failure modes

| Failure                                                 | Handling                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureColumn` matches the human `Geo's` and renames it | Prevented by the name choice; a test asserts `keyShape(AUTO_GEO_COLUMN) !== keyShape("Geo's")` so a future rename cannot reintroduce the collision |
| Breakdown sync stalls or lags                           | Distinguished from "not delivering" by the free `paceTotal` guard above, so a lagging breakdown job never blanks a running row's cell              |
| A row's attribution changes                             | Its geo changes with it. Expected, not a bug                                                                                                       |
| Region breakdown missing for a single-country row       | Line 2 is omitted; line 1 still writes                                                                                                             |
| Notion rate limit                                       | One write per changed row, paced at `WRITE_GAP_MS`                                                                                                 |
| Cell exceeds 2000 chars                                 | Trimming rule caps both lines at 8 entries; `TEXT_CELL_LIMIT` remains the backstop                                                                 |

Out of scope, deliberately: writing or parsing the human `Geo's` brief, a structured brief-vs-actual
divergence feed (roadmap idea 11, deferred), geo compliance checks (Track E, on hold), and per-geo
dayparting (H2, approved separately).

## Roadmap position

Not on the §3 approved build list. Added on the operator's request on 2026-08-13, the same way N1
was, and recorded here so the governance in `docs/product-roadmap.md` stays honest. It is small,
touches one job and one new pure module, and depends on nothing in cycle 1.

## Verification

- Unit tests for `geoCell()`: the drill trigger and its exclusion of `unknown`, the sub-1% drop, the
  8-entry cap and `+K more` count, the empty input, and the single-country and multi-country shapes
  taken from the real rows above.
- A test pinning the `keyShape` non-collision between the new column and `Geo's`.
- `planGeo` tests for each row of the skip table. Two carry the design's real weight: a
  foreign-currency row is **not** skipped, and a row with spend but no `country` rows is skipped
  rather than cleared while a row with neither is cleared.
- `bunx tsc --noEmit` and `bun run lint` clean.
- A real `syncNotionDailyBudgets(undefined, { dryRun: true })` against the live board, whose reported
  plan is read and sanity-checked before any write is enabled. The board is shared with the whole
  team, so the first real write happens only after the dry run looks right — and the dry run is also
  what proves the new column is _created_ rather than the brief being renamed.

---

_Board contents, breakdown coverage and the derived previews in this document were measured against
the live `dotaudiences` board and DOT's production Postgres on 2026-08-13. Line references were taken
against `feat/meta-integration` at the parent of the commit adding this document; symbol names are
the reliable anchor._
