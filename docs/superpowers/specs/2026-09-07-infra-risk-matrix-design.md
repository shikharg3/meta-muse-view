# Risk map: matrix-first triage screen — design

**Date:** 2026-09-07
**Status:** implemented
**Branch:** `feat/daily-performance-report`, deployed as `feat/meta-integration` (the ref
`deploy/deploy.sh` pulls on the droplet)

## Problem

`/infrastructure` was built to answer "what is one ban from unreachable". Measured against the
shipped code before this change, it spent its most valuable space answering something else:

| Symptom                                                                                                                                                  | Evidence (pre-change)                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| The top of the screen was five **inventory** tiles — counts of things owned, carrying no risk signal                                                      | `infrastructure.index.tsx:150-166`             |
| The only risk number was **prose in the page subtitle**                                                                                                  | `infrastructure.index.tsx:133-137`             |
| The default view drew the **whole estate at equal weight** in a 72vh canvas, fit at `minZoom: 0.4`, so it had to be zoomed out to be whole and in to read | `InfraSpineCanvas.tsx:209, 352, 356`           |
| The table view listed **safe rows too**, four columns each, per entity type                                                                              | `RiskSection`, `infrastructure.index.tsx:76-97` |
| Each row carried **four parallel encodings** — status pill, risk badge, detail text, overdue note                                                        | same                                           |
| Nothing said **what would break**, although the traversal already existed for the agent tool                                                             | `server/agent/tools/infra.ts:147-174`          |

Root cause: both views tried to be complete. Completeness is an audit requirement, not a glance
requirement — and a safe asset is the *absence* of information, so it should cost one number, not one
row.

## Decisions

| #   | Decision                                                                                          | Rationale                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **A 5×3 matrix is the summary**: entity type down, severity across, `Registered` as a fifth column | One saccade says where risk concentrates. It also absorbs the five count tiles instead of competing with them, and each `Registered` number still deep-links to that entity's page      |
| 2   | The matrix **is the filter** for one findings list below it                                        | Two devices, one of which explains the other. Selection lives in search params (`?type=&level=`) so a finding is linkable and survives a reload                                        |
| 3   | Default list = **every non-safe asset, worst first**, types mixed                                 | Severity order is the useful order on a triage screen; type is a chip, not a section heading                                                                                            |
| 4   | Profiles are a **separate line below the totals**, never inside them                              | A profile is a means of access, not an asset to protect — the contract `profileRisk` already documents. Counting a blocked profile as a finding would double-count the BM it strands   |
| 5   | One severity encoding per row: a **coloured rail**; the verdict is a word                          | Replaces pill + badge + tone. Status is printed only when it is *not* one of that kind's normal values, because the four status vocabularies disagree on the word for "fine"           |
| 6   | Each BM row states what it is the **last live path to**                                            | The number the screen never had. Read from the same graph the map draws                                                                                                                 |
| 7   | The headline names the worst **access concentration**, in either of its two forms                  | Live: the only usable admin of N BMs, so one ban takes all of them. Blocked: already unusable, and N BMs it admins now have no usable admin — the cascade has happened. On the live registry **only the blocked form occurs**, so a live-only rule left the headline empty on the one screen that needed it |
| 8   | The drawn spine stays, behind the `Map` toggle, unchanged                                          | It answers the different, slower question of what a specific ban costs. It is no longer the default, because it is not a one-look device                                              |
| 9   | **No money on this screen**                                                                        | Infrastructure stays purely operational; spend linkage is explicitly out of scope per the 2026-08-13 design. Blast radius is counted in assets, never in dollars                        |

Rejected: a flat ranked triage feed with no summary grid (fast to read, but gives no sense of where
risk concentrates), and an attention band over a risk-filtered spine (keeps the drawing's strength,
but needs graph filtering plus collapsed aggregate nodes and still leaves two devices to read).

## Addendum, 2026-09-07 — main BMs and profiles

The operator asked to mark the BMs and profiles that matter, so the map leads with them while the
rest stay visible. This **reverses decision 6 of the 2026-08-13 design** ("flat access list; no
'primary BM' concept"), but not its reasoning: that decision existed so ban impact would be phrased
as paths lost rather than as a primary to re-point to, and `is_main` changes nothing about impact.

| #   | Decision                                                                             | Rationale                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | `is_main` is **display priority only**, on `infra_profiles` and `infra_business_managers` | It is never passed to `redundancy`, `pixelRisk`, `pageRisk` or `profileRisk`. A star that could improve a verdict would turn the risk map into a wish list            |
| 11  | Severity outranks the star                                                            | Starred rows lead **within** a severity band, never across one. Burying a critical unstarred asset under a warning on a starred one would be a lie told by sort order  |
| 12  | One URL flag, `?main=1`, drives both views                                            | The lens is linkable and survives a reload, and the findings list and the canvas cannot disagree about what "main" means                                              |
| 13  | Recession is **relative**: with nothing starred, nothing dims                          | A canvas that dims itself before the operator has expressed a preference is just a darker canvas                                                                       |
| 14  | `focusMain` is **one hop**, not a closure                                             | Two hops from a starred BM reaches its admin, then every other BM that admin holds, and the "main view" is the whole estate again                                     |
| 15  | `setBmMain`/`setProfileMain` are their own actions, `audit()`-logged only              | The row `type` select re-sends every field through `saveBm`, so a marker riding along there would be flipped by unrelated edits. The event trail is for status changes |

The column was applied to `meta` and `meta_test` as explicit additive DDL
(`add column if not exists`), not `bun run db:push`, which is documented as unsafe unattended on
this repo. The live schema now matches `src/db/schema.ts`, so the next push sees no diff.

Verified: 75 pure tests (7 new, covering `focusMain`'s one-hop rule and that starring leaves
`atRisk`, the tally and every verdict identical), 20 DB-backed tests against real Postgres (1 new,
asserting the same invariant through `buildRiskMap`), and both views driven in a harness over a dump
of the live registry — 101 nodes, and the lens narrowing the canvas from 21 drawn nodes to 8.

## Shape

| File                                          | Role                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/infra-graph.ts`                      | Gains `reachedFrom(graph, nodeId)` — the one blast-radius traversal, now shared by the screen and `preview_bm_ban`                |
| `src/lib/infra-summary.ts`                    | New, pure: `buildRiskSummary(graph, registered)` → `atRisk`, the matrix `tally`, and the worst `concentration`                     |
| `src/server/fns/infra/risk.ts`                | Returns `tally`, `concentration`, `profiles`, and `strands` on BM rows. Still one read; still the only place risk is computed      |
| `src/components/infra/kinds.ts`               | New: one home for each kind's label, icon, route and normal statuses                                                             |
| `src/components/infra/RiskVerdict.tsx`        | Severity at display scale, severity bar, concentration sentence                                                                   |
| `src/components/infra/RiskMatrix.tsx`         | The grid, and the selection callback                                                                                              |
| `src/components/infra/FindingRow.tsx`         | One finding, one line, one encoding                                                                                               |
| `src/routes/infrastructure.index.tsx`         | Matrix view (default) or map view; `RiskSection` deleted                                                                          |

`atRisk` is unchanged in meaning: non-safe assets, profiles excluded. `buildRiskSummary` is now the
single place that says so, and a DB test asserts the matrix's asset columns sum to exactly that
number, so the grid can never become a second count.

`tally.registered` may exceed `tally.scored` — retired ad accounts are registered but deliberately
unscored. The matrix prints the difference (`6 (2 retired)`) rather than quietly showing 4 of 6.

## Verification

- `bun test src/lib/*.test.ts` (infra suites) → 68 pass. Covers the cascade case a per-BM walk gets
  wrong: an asset reachable from two BMs the same profile solely holds survives losing either one,
  and is still stranded by losing that profile. Also covers a realised loss outranking a
  hypothetical one.
- Run against the **live registry** before shipping (`buildRiskMap()` over the ssh tunnel,
  select-only): `atRisk` 31 with the matrix asset columns summing to exactly 31; BMs 4 critical /
  4 warning / 2 safe, pages 0 / 23 / 31, profiles 3 / 15 / 19, against 37 · 10 · 0 · 0 · 54
  registered. This is what caught decision 7's first version — `concentration` came back `null`
  while the map plainly showed one suspended profile admining three "No backup" BMs.
- `assets` on a blocked concentration counts what **sits behind** those BMs, not what is provably
  unreachable: `usableBm` reads a BM's own status, so an admin-less but active BM still counts as a
  live path for the risk rules. Claiming otherwise here would be a second, disagreeing rule.
- `bun test src/server/fns/infra/infra.db.test.ts --timeout 90000` → 19 pass against real Postgres.
  Two earlier runs failed with FK violations on *insert* at different rows each time — the shared
  `meta_test` concurrency documented in `docs/superpowers/plans/2026-08-13-media-buyer-checkin.md`,
  not this change, which is select-only.
- Both views rendered and exercised in a throwaway Vite harness that mounted the real components
  against fixtures classified by the real risk chain, since `/infrastructure` itself needs an admin
  session. Matrix cell → filtered list and the `Map` toggle (16 nodes, 13 edges) were checked live.
  The harness has been removed.
- Production build proven from an isolated worktree at the shipping commit (`vite build`, 19.5s),
  then deployed with `deploy/deploy.sh` and its `EXPECT` guard.
