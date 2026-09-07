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
| 7   | The headline names the worst **access concentration** in words                                     | "One profile is the only usable admin of N BMs" is the highest-value sentence on the screen and is not derivable from any count                                                       |
| 8   | The drawn spine stays, behind the `Map` toggle, unchanged                                          | It answers the different, slower question of what a specific ban costs. It is no longer the default, because it is not a one-look device                                              |
| 9   | **No money on this screen**                                                                        | Infrastructure stays purely operational; spend linkage is explicitly out of scope per the 2026-08-13 design. Blast radius is counted in assets, never in dollars                        |

Rejected: a flat ranked triage feed with no summary grid (fast to read, but gives no sense of where
risk concentrates), and an attention band over a risk-filtered spine (keeps the drawing's strength,
but needs graph filtering plus collapsed aggregate nodes and still leaves two devices to read).

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

- `bun test src/lib/infra-summary.test.ts src/lib/infra-graph.test.ts src/lib/infra-risk.test.ts src/lib/infra-spine.test.ts` → 67 pass.
  Covers the cascade case a per-BM walk gets wrong: an asset reachable from two BMs the same profile
  solely holds survives losing either one, and is still stranded by losing that profile.
- `bun test src/server/fns/infra/infra.db.test.ts --timeout 90000` → 19 pass against real Postgres.
  Two earlier runs failed with FK violations on *insert* at different rows each time — the shared
  `meta_test` concurrency documented in `docs/superpowers/plans/2026-08-13-media-buyer-checkin.md`,
  not this change, which is select-only.
- Both views rendered and exercised in a throwaway Vite harness that mounted the real components
  against fixtures classified by the real risk chain, since `/infrastructure` itself needs an admin
  session. Matrix cell → filtered list and the `Map` toggle (16 nodes, 13 edges) were checked live.
  The harness has been removed.
