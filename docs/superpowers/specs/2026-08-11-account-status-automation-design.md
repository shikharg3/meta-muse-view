# Automating the Notion `Account Status` column — design

**Date:** 2026-08-11
**Status:** approved design, not yet planned or built

## Problem

`Account Status` on the Notion campaigns board is written entirely by hand. Code only reads it:
`parseCampaignRow` picks it up at `src/notion/parse.ts:104` and it lands on `clients.status` via
`src/sync/jobs/clients.ts:60`. The only write-back path in the app is `runNotionBudget`, whose three
`setPageValue` callsites (`src/sync/jobs/notion-budget.ts:988`, `:1002`, `:1010`) touch only the four
`🤖` numeric/date columns.

That manual field is load-bearing twice over:

1. **It gates the write-back.** `LIVE_STATUSES` (`parse.ts:133`) feeds `notLive()`
   (`notion-budget.ts:211-212`), and non-live rows are skipped entirely (`:729`, `:767`). A stale
   status silently suppresses machine output, or pushes values onto a row the team considers closed.
2. **It decides attribution.** The highest-priority status wins (`STATUS_PRIORITY`,
   `parse.ts:123-130`), and the winning rows' `Active Account ID` becomes the client's
   `activeAccountIds`. A wrong status selects the wrong active-account set.

Meanwhile Meta already knows the delivery half of the answer, and nothing surfaces it on the board.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | The machine never overwrites a human-owned status value | Those rows are where the `CLAUDE.md` invariant already says machine writes must stop, because their ad accounts get recycled onto the next client |
| 2 | A machine-only value covers "account active but cannot deliver" | Keeps machine and human value sets disjoint, so the value itself carries provenance and no bookkeeping is needed |
| 3 | Strict all-or-nothing rungs; no partial thresholds | A status field holds a label, not a degree. Under-spend is already visible from `🤖 Avg Daily Spend 7d ($)` against `🤖 Daily Budget ($)` |
| 4 | Manual override lives in Postgres with a dashboard UI | Follows the existing `campaignClientOverrides` convention, and gives `setBy` / `createdAt` provenance |

## The ownership model

`Account Status` conflates two unrelated facts. This design splits them and gives each an owner:

| Owner | Values | Meaning |
|---|---|---|
| Machine | `Live`, `Paused`, `Ad Account Disabled`, `Ad Account Blocked`, `All ads rejected` | Delivery state, derived from Meta each cycle |
| Human | `On Boarding`, `Not started`, `Full Budget Finished`, `Budget Finished - Top Up` | Commercial lifecycle, unknowable from Meta |

The sets are **disjoint**, and that is the load-bearing property: the value alone says who owns it.
No timestamps to compare, no provenance column, no last-writer tracking.

`Ad Account Blocked` covers both an `ACTIVE` account whose prepaid `spend_cap` is exhausted and an
account in any `PENDING` state. Meta cannot distinguish *contract over* (`Full Budget Finished`) from
*awaiting a top-up* (`Budget Finished - Top Up`) when a cap is spent — that is a commercial fact, so
both stay human-owned and the machine states its own observation instead.

## Derivation ladder

Evaluated top-down, per campaign row, over the accounts on that row (`BoardRow.accountIds`, which
already honours manual add/remove at `notion-budget.ts:753-756`) and the campaigns attributed to it.

| # | Condition | Result |
|---|---|---|
| 0 | Row has no accounts, no attributed campaigns, or its accounts are absent from `accounts` | write nothing |
| 1 | Every account is `DISABLED` per `accountStatus()` | `Ad Account Disabled` |
| 2 | No account passes `canDeliver()` | `Ad Account Blocked` |
| 3 | No attributed campaign is `ACTIVE`, or campaigns are `ACTIVE` but at least one ad set exists under them and none is `ACTIVE` | `Paused` |
| 3b | Campaigns are `ACTIVE` but no ad set or no ad has synced under them | write nothing |
| 4 | At least one ad exists under the active ad sets and every one is `DISAPPROVED` | `All ads rejected` |
| 5 | Otherwise | `Live` |

Rung 1 precedes rung 2 because an all-disabled row also fails `canDeliver()`; the more specific
reason wins. Account-level rungs precede campaign-level ones because Meta stops delivery at the
account level while campaigns keep reporting `ACTIVE` — the invariant that `canDeliver()` exists for.

### Guards that are not optional

- **Rung 0 exists because the defaults are optimistic.** `accountStatus(null)` returns `"ACTIVE"`
  (`src/server/agg.ts:55`) and `canDeliver` treats a null or zero `spendCap` as uncapped. Without
  rung 0, a row whose accounts have not synced derives `Live`.
- **Rungs 1, 3 and 4 need non-empty checks.** `every()` and "none is active" over an empty set are
  both vacuously true, so a row with no accounts would derive `Ad Account Disabled`, a campaign whose
  ad sets have not synced would derive `Paused`, and one whose ads have not synced would derive
  `All ads rejected`. Rung 3b makes the missing-children case explicit: an `ACTIVE` campaign with no
  synced ad sets or ads is a sync gap, not a delivery state, and must produce silence.
- **Rung 4 is scoped to ads under `ACTIVE` ad sets**, not all ads under active campaigns. An ad
  sitting under a paused ad set is not rejected, it is simply not running, and counting it would let
  ordinary ad-set pausing masquerade as a policy problem.
- **Rung 4 keys on `DISAPPROVED` only.** `WITH_ISSUES` and `PENDING_REVIEW` are different states.
  `ad_review_feedback` is already requested (`src/meta/fieldsets.ts:238`) and stored in `raw`, so the
  rejection reason is available later without an ingestion change.
- **Rung 3 covers ad-set pausing.** Campaigns can be `ACTIVE` while every ad set under them is
  paused, in which case nothing delivers. `ARCHIVED` and `DELETED` campaigns also land here and read
  as `Paused`; a separate value for them is not worth a board option.

## Breaking the feedback loop

Writing `Account Status` feeds the code that reads it. `notion-budget.ts:727` builds `isLive` from
`notLive(row.status)`, and that map both skips rows and drives **account→row assignment**. The
comment at `:800-803` explains the stake: an account listed by several rows of one client belongs to
whichever row is *currently live*, because successive engagements of one brand are indistinguishable
by name. So a machine-written `Live → Paused` would reassign accounts to a sibling engagement,
shifting spend attribution, which changes the derived status again.

**Resolution:** all five machine values join `LIVE_STATUSES`, whose meaning changes from "delivering"
to **"engagement is current, keep maintaining this row"**. Machine transitions then never move
`isLive`, and the loop is closed by construction.

`LIVE_STATUSES` becomes:

```
Live · Paused · Ad Account Disabled · Ad Account Blocked · All ads rejected
Budget Finished - Top Up · On Boarding
```

`On Boarding` and `Budget Finished - Top Up` are in it today and **must stay** — dropping them while
adding the machine values would silently stop budget maintenance for onboarding and top-up rows.
Excluded, exactly as today: `Full Budget Finished`, `Not started`.

**Deliberate behaviour change:** `Paused` rows now have their `🤖` budget columns maintained, where
today they are skipped. A paused engagement is still current, and pacing figures are wanted on a row
that is about to restart.

### `STATUS_PRIORITY`, and the sequencing that must not be got wrong

An option present on the board but absent from `STATUS_PRIORITY` scores 0, loses to `Not started`,
and takes the client's `activeAccountIds` from the wrong row — stated outright at `parse.ts:120-122`.
That makes rollout order a correctness requirement, not hygiene:

1. Ship the code — new options in `STATUS_PRIORITY` and `LIVE_STATUSES`, with tests. Harmless while
   no row carries them.
2. Create the options on the board, after verifying a `dryRun`.
3. Only then enable writes.

Reversing steps 1 and 2 misattributes campaigns between engagements, corrupting spend figures rather
than merely looking wrong.

New order, highest first. The question the map answers is "which of a client's rows is the current
engagement", and every machine value describes a current engagement that happens to be broken:

| Priority | Status |
|---|---|
| 9 | `Live` |
| 8 | `All ads rejected` |
| 7 | `Ad Account Blocked` |
| 6 | `Ad Account Disabled` |
| 5 | `Paused` |
| 4 | `Budget Finished - Top Up` |
| 3 | `On Boarding` |
| 2 | `Full Budget Finished` |
| 1 | `Not started` |

This moves `Paused` above `Budget Finished - Top Up` and `On Boarding`, where it sits below both
today. For a client with one row on each, that changes which row's `Active Account ID` wins. A test
pins the order so the change is deliberate and cannot drift.

## Write path

Host: `runNotionBudget` (`src/sync/jobs/notion-budget.ts`). It already resolves per-row accounts,
client context, campaign attribution, column lookup, `dryRun`, and write pacing. A separate job would
duplicate all of it.

The ladder lives in a **new pure module** taking already-fetched rows and returning a status per
page — no I/O, unit-testable in the style of the existing `canDeliver` tests, and it keeps the
1,100-line job from growing much.

- **One new batched query:** ads joined to ad sets (`adSets.id = ads.adSetId`) filtered to the
  attributed campaign ids, selecting `effectiveStatus` at both levels. Ads carry no `campaignId`, so
  the join goes through `ad_sets`. One query per cycle for all rows, never per row.
- **Column resolution:** `Account Status` is found by name with `resolvePropertyKey`, which already
  tolerates case, spacing and emoji drift. It is deliberately **not** passed through `ensureColumn`,
  so it is never renamed to a `🤖` name — that marker means "machine-written, do not hand-edit",
  which is false for a column humans still own values in.
- **Option bootstrap:** one new `NotionClient` method. Read the property's current `status.options`,
  append only the missing ones, PATCH the data source. `group` is omitted so existing options keep
  their group. Append-only; the existing array is never replaced. Status options are writable at API
  version `2025-09-03`, which the client already pins (`src/notion/client.ts:5`). Groups themselves
  are UI-only, and option `color` cannot be set through the page write.
- **Value shape:** `setPageValue(pageId, propId, { status: { name } })` — the existing method with a
  value shape it has not carried before, since all three current callsites send `{ number }` or
  `{ date }`.
- **No-rewrite guard:** mirror `same()` — skip when the cell already holds the derived value. Keeps
  `Last edited time` meaning "a human edited this" (`:214`), and steady-state write volume near zero.
- **Its own gate, not `isLive`.** `notLive(null)` is true, so an empty `Account Status` behind the
  existing gate would never be populated. The four numeric columns keep the `isLive` gate; the status
  write gets its own: **write only if the current cell is empty or holds a machine-owned value.**
- **Pacing:** at most one extra `setPageValue` per *changed* row, at the existing `WRITE_GAP_MS = 350`
  for Notion's ~3 requests/second.
- **Reporting:** extend the job result with per-row derived status and counts. The `/sync` route
  already surfaces this job's health and warnings.

## Manual override

New table, mirroring `campaignClientOverrides` (`src/db/schema.ts:409-414`):

| Column | Type | Notes |
|---|---|---|
| `page_id` | text, PK | The Notion page. Sturdier than a client id, which the sync re-keys |
| `status` | text, not null | Must be one of the five machine-owned values |
| `set_by` | text | Session user |
| `created_at` | timestamptz, not null, default now | |

**No foreign key**, for the reason the existing table documents: the Notion sync re-keys ids, and a
cascade would silently erase an operator's correction. A row pointing at a page that no longer exists
is ignored.

- **Pin, not freeze.** The machine writes the override value, so the board converges on operator
  intent even after a hand edit. One place to act.
- **Only machine-owned values are pinnable.** Pinning a human-owned value is just editing Notion, and
  permitting it would break the disjoint-set invariant that makes provenance readable.
- **Precedence, in one rule:** a human-owned value on the board beats everything, including an
  override. The machine never overwrites a human-owned value. An override shadowed this way is
  displayed as inert rather than silently doing nothing.
- **UI:** admin-only control on the client detail view listing that client's rows with derived status,
  current board value, and an override selector. Deleting the override hands control back.

## Failure modes

| Failure | Handling |
|---|---|
| Board option missing → write 400s | Bootstrap plus dry-run-first sequencing |
| Unsynced accounts/ads → false `Live` or vacuous truth | Rung 0 and the two non-empty guards |
| Status lags reality | The worker is an hourly loop (`src/sync/worker.ts:24`) with a daily full refresh, so the column can trail a pause by up to an hour. Stated, not fixed |
| Attribution churn changes a row's accounts | Derived status changes with it. Expected, not a bug |
| Notion rate limit | One write per changed row, paced at `WRITE_GAP_MS` |

Out of scope, deliberately: the blocked-spend quantity (roadmap idea 29), Notion↔Meta divergence
(idea 11), `Launch Status` automation, and dataset-level staleness detection.

## Verification

- Ladder unit tests covering every rung, both vacuous-truth cases, and rung 0.
- A test pinning `STATUS_PRIORITY` order, and a `LIVE_STATUSES` membership test asserting
  `On Boarding` and `Budget Finished - Top Up` are retained.
- `bunx tsc --noEmit` and `bun run lint` clean.
- A real `runNotionBudget({ dryRun: true })` against the live board, whose reported plan is read and
  sanity-checked before any write is enabled — the board is shared with the whole team, so the first
  real write happens only after the dry run looks right.
