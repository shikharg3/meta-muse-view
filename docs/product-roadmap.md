# MetaConsole — Product Roadmap

**Status: decided, 2026-08-13.** Every track and every backlog item was triaged with the operator on
this date. **Section 3 is the approved build list — the only work cleared to start.** Everything else
is deferred, on hold or rejected, each with its reason recorded so it is not re-proposed. Nothing in
this document is an implementation plan; approved items still go design → plan → build individually.

Last updated: 2026-08-13. All counts below were re-measured against production the same day; several
figures carried from 2026-08-03 were wrong and are corrected in §1.

---

## 0. Agency boundary — read this first

**MetaConsole belongs to DOT Agency. DOT and PetalPixel projects MUST NOT be interlinked.**

The discriminator is hosting: DOT Agency runs on the **DigitalOcean droplet**; the Hetzner box hosts
**PetalPixel** projects.

| In scope (DOT)                                            | Notes                                                                                                                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MetaConsole** — DO droplet, `analytics.madsmonitor.com` | this app: Meta sync, attribution, reporting, AI chat                                                                                                                                          |
| **Notion** campaigns board — `dotaudiences` workspace     | commercial layer; already integrated both ways                                                                                                                                                |
| **Asset Library** — `library.dotaudiences.com` (Base44)   | On a DOT domain and DOT's own designer → media-buyer workflow. Integration **rejected 2026-08-13** (see idea 9); listed here only to record that the boundary itself was never the objection. |

Out of scope — **do not integrate, do not read, do not sync**. Listed only as a guardrail so this
boundary is not re-crossed by a future proposal: everything on the Hetzner box, including the
Telegram bot and its Telethon session, the Meta Ads Uploader, fbtools, n8n, WatchTower, the VA task
manager and the finance app.

**Building a capability natively is not the same as integrating.** Recorded 2026-08-13 so the
distinction is not lost: the boundary forbids reading, writing or syncing another agency's systems. It
does not forbid MetaConsole from having a feature that a PetalPixel project happens to also have. The
infrastructure registry (§4, Track N) is the first case — it re-implements WatchTower's _functionality_ in DOT's
own Postgres with no network path to Hetzner, no Firebase, and no records copied. Track G below remains
dropped: that track was reconciliation _against WatchTower's data_, which is still forbidden.

Consequences that shape every track below:

- DOT infrastructure is **one 3 GB droplet** (116 GB disk, 108 GB free) with no redundancy and no
  large-memory box to fall back on. Anything media-heavy or client-facing has to be paid for.
- Any Telegram ingestion needs **DOT's own Telegram account, session and worker**. There is no
  session to reuse.
- Any automated push of creatives to Meta needs **DOT's own publishing leg**. There is no uploader to
  hand off to.
- Cross-agency duplication of Meta data is **not a defect**. Separate businesses, separate tokens.

---

## 1. What we already own

Verified against DOT's production Postgres on **2026-08-13**.

| Asset                                        | Volume                                                                                                                                                                          | Notes                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Daily insights                               | ad 705,771 · adset 85,544 · campaign 59,546 · account 19,581                                                                                                                    | ad level spans 2025-09-20 → 2026-08-13                                                                  |
| Delivering ad-days                           | 10,944 in the last 30 days (of 168,981 ad-day rows)                                                                                                                             | ≈365 delivering ads/day; the rest are zero-spend rows Meta still returns                                |
| Ad creatives                                 | 25,703 — 14,231 with thumbnails, 21,452 with `asset_feed_spec`, 13,769 body, 11,964 title                                                                                       |                                                                                                         |
| Ads                                          | 7,925 — 4,296 with `preview_shareable_link`                                                                                                                                     |                                                                                                         |
| Asset breakdowns (ad level, from 2026-06-25) | `image_asset` 15,255 · `body_asset` 13,167 · `title_asset` 12,864 · **`description_asset` 9,837** · `link_url_asset` 9,025 · `call_to_action_asset` 9,003 · `video_asset` 1,258 | 7 dimensions, not 6 — `description_asset` was missing from the previous table                           |
| Hourly breakdowns                            | 99,603 rows across 4 framings (audience TZ: campaign 33,929 + account 17,333; advertiser TZ: campaign 32,220 + account 16,121)                                                  | from 2026-04-20; **unused today**                                                                       |
| Frequency breakdown                          | 16,531 (`frequency_value`: campaign 10,471 + account 6,060)                                                                                                                     | from 2026-04-20; **unused today**                                                                       |
| Geo / demo / placement                       | region 81,302 · placement triple 77,205 · `age\|gender` 39,852 · age 24,340 · country 13,859 · device_platform 12,101 · publisher_platform 11,284 · gender 11,937               | age/gender/country/device/publisher from 2025-11-12; region/placement from 2026-04-20                   |
| Meta asset library                           | 5,378 `ad_image` + 2,667 `ad_video`                                                                                                                                             | `meta_objects` — what actually exists per account                                                       |
| Pixels / audiences / rules                   | 56 pixels · 60 custom audiences (37 carrying a `rule`) · **91** automated rules                                                                                                 | `meta_objects` stores only the CURRENT snapshot per object — there is no version history to reconstruct |
| Change history                               | 42,964 activities with actor names                                                                                                                                              | `meta_activities`                                                                                       |
| Clients / users                              | 75 client rows, **55 live** · 8 users (1 superadmin, 4 admin, 3 member) · 8 campaign overrides                                                                                  |                                                                                                         |
| Breakdown freshness                          | every group current to 2026-08-13                                                                                                                                               | the sync is healthy; "unused" means unused by the app, not stale                                        |

### Claims corrected on 2026-08-13

Recorded explicitly because two of them had already been used to justify backlog items:

1. **Quality signals do not exist.** `quality_ranking` and `estimated_ad_recall_rate` are populated
   on **0** ad-day rows in the last 30 days. Both are requested and neither is blocklisted — Meta
   simply does not return them for this book. `engagement_rate_ranking` / `conversion_rate_ranking`
   reach only 3,320 of 10,944 delivering ad-days (30%). Only `frequency` is universal (11,022 ≈
   100%). Any fatigue work must rest on **frequency + CTR decay**.
2. **`actions_by_window` is real but shallow.** It lands in its own column (not `raw`), 11,059 ad
   rows, but only from **2026-05-21** and on 60% of delivering ad-days. It cannot support a
   re-derived historical attribution window.
3. **Conversion _values_ are effectively absent.** `action_values` / `action_values_by_window` appear
   on **162 of 10,944** delivering ad-days (1.5%). The values are not being sent upstream; no query
   or sync change fixes that. This killed idea 15.
4. **Audience overlap is not obtainable.** `configurable_audience_overlap_reach` sits in the
   ad-level field blocklist — Meta rejected it. We hold 60 audience metadata rows (37 with a `rule`),
   which supports same-source _inference_ only, never measured overlap. This killed idea 16.
5. **Client identity got simpler.** The previous "43 single-row / 12 multi-row" analysis
   (betonline.ag May/June/July, acrpoker.eu ×3, fortunegalaxy.io ×2) is no longer visible: `clients`
   now holds **one row per brand**, with the engagement expressed as `start_date`/`end_date`.
   Multi-_account_ is the norm (OneAgency 22, Playw3.com 15, bspin.io 11, betonline.ag 11,
   fortunegalaxy.io 11); multi-_brand_ is rare. Two genuine duplicate pairs remain —
   `luckywhale`/`luckywhalecasino.com` and `play quack`/`playquack.com`.

Standard breakdowns still sync at **account + campaign only**, so `age × creative` remains
impossible without a fieldset change plus backfill. The earlier finding stands: the gap is level,
not dimension.

Already built and reusable: report engine with CSV/PDF + commission markup (`/reports`), AI chat
agent with 7 read-only tools + persisted history + per-user cost tracking, spend-drop and
account alerts delivered to DOT's own Telegram bot, Notion two-way sync (daily budget, budget
remaining, ad-account funds, the machine-derived `Account Status`, and the delivered-geo split),
cross-client attribution engine, audiences and
activity views, admin/superadmin/member auth with an approval flow, and the pacing forecast
(`forecastBudgetEnd` / `paceWindow`) shared by the dashboard and the Notion write-back.

**Shipped 2026-08-13 — `🤖 Geo Delivered 14d`.** Added on the operator's request outside the §3 list,
the way N1 was. Derived from the `country`/`region` breakdowns over each board row's own attributed
campaigns and the engagement-clamped `paceWindow()`; 12 of 16 live rows carry a cell. The human
`Geo's` column is a _brief_ (prose, ranked preferences, budget splits) and is never written — the two
sit side by side so divergence is readable, which it immediately was: one engagement briefed for
eight countries is delivering `US 100%`. Design and plan under `docs/superpowers/`.

The same dry run surfaced that `Funds Remaining ($)` had been renamed on the board and the job had
silently stopped resolving it, so it was maintaining nothing and would have grown a duplicate column
on the next write. Fixed, and every auto-column name is now pinned by a test.

Deliberately stubbed: `/creatives` is a 32-line "being rebuilt" placeholder. **It stays that way** —
Track B is on hold (§2).

---

## 2. Decisions (2026-08-13)

| Track                                                        | Decision                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Client-facing portal**                                 | **In, and it leads the next build cycle.** Full portal with client logins. Scope model decided: **explicit scope grants** (login → set of client ids), not a 1:1 binding to `clients.id`.                                                                                           |
| **B — Creative intelligence**                                | **On hold.** No item approved. `/creatives` stays stubbed. Everything downstream of B (ideas 1, 2, 6, 7, 18, 22 and the ad-level breakdown ingestion) is parked with it.                                                                                                            |
| **C/D — Market creative intelligence → briefs → generation** | **Rejected.** Needed three purchases DOT does not have (its own Telegram account + session, object storage, a similarity index) and delivered nothing until all three landed.                                                                                                       |
| **E — Account survival + QA**                                | **Partially in:** idea 29 (blocked-spend signal) approved. The rest stays on hold.                                                                                                                                                                                                  |
| **F — Money + margin / client P&L**                          | **Rejected** (unchanged).                                                                                                                                                                                                                                                           |
| **G — WatchTower reconciliation**                            | **Dropped — boundary violation** (unchanged).                                                                                                                                                                                                                                       |
| **H — Data already synced and never used**                   | **Partially in:** ideas 12 (dayparting) and 13 (audience saturation) approved. Ideas 14, 17 deferred; 15, 16 rejected on measured evidence.                                                                                                                                         |
| **I — Creative localisation**                                | **Rejected.**                                                                                                                                                                                                                                                                       |
| **J — Policy linter + rejection archive**                    | **Rejected.**                                                                                                                                                                                                                                                                       |
| **K — Interface direction (fork)**                           | **Resolved: dashboard-first.** Telegram stays exception-driven alerts only. Idea 8 (buyer digest) **rejected** — no scheduled message. Idea 20 (agent write actions) **rejected** — writes against live ad accounts with no undo, on top of a deliberately fuzzy `resolveClient()`. |
| **L — Breadth vs depth (fork)**                              | **Resolved: depth on Meta.** Idea 28 (Google/TikTok/Kwai) rejected.                                                                                                                                                                                                                 |
| **M — Productisation**                                       | **Rejected** as premature; depends on A's multi-tenancy and on B, which is on hold.                                                                                                                                                                                                 |
| **N — Infrastructure registry**                              | **In, added 2026-08-13** after the §3 triage, on the operator's request. Native registry of profiles → BMs → ad accounts, plus pixels and pages, with a redundancy risk map. Operator-owned, no sync writes, admin-only. Not a revival of G — see §0 and §4 N.                      |

Two client-facing policies were also settled:

- **Numbers are live; issued reports are immutable.** Portal views always show current figures with
  an "as of" stamp. Every generated PDF/CSV is snapshotted at issue time and never recomputed, so
  the copy a client received can always be reproduced. This is the narrowed form of idea 26 —
  accounting periods are _not_ frozen.
- **Scope is an explicit grant.** A login maps to a set of client ids through a join table. This
  handles the two duplicate brand pairs, the agency rows (OneAgency, omni agency) and any future
  "one brand under an agency" case with the same mechanism.

---

## 3. Approved build list

Nine items, in build order. Nothing else is cleared to start. Sizes are relative, not estimates in
days; each still needs its own design → plan cycle.

**Amended 2026-08-13:** item **N1** was added after the triage on the operator's request. It is
independent of Track A — different tables, different routes, different sidebar group — so it runs
alongside cycle 1 on its own branch rather than displacing anything.

### Cycle 1 — Track A foundation

| #      | Item                                                              | Why it is actionable                                                                                                                                                                                                                                                                                                                                                                            | Size |
| ------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **A0** | **Scope grants + `client` role**                                  | Prerequisite for everything below. A join table binding a login to a set of client ids, plus a resolved scope object (allowed account ids + `ownedCampaignIds`) that client-facing server fns **require as an argument**, so an unscoped query cannot be written by accident. `clients.id` is a guessable slug (`wildcasino-ag`), so no route may key off an id without an authorisation check. | L    |
| **A1** | **Presentation alias layer** (idea 25)                            | Non-negotiable before any client logs in. Raw names expose the rented-account supply chain (`DOT-GO-GMT-8-7`, `Amber Media-（UTC-4）-5`), and Notion statuses like `Full Budget Finished` are operations language. Aliases for accounts and campaigns, applied everywhere including exports and the agent.                                                                                      | M    |
| **A2** | **Immutable issued reports + "as of" stamps** (idea 26, narrowed) | The report engine already produces CSV/PDF with markup; this snapshots the artifact at issue time and stamps every client-facing view. Also the answer to "why did last month change" without freezing periods.                                                                                                                                                                                 | M    |
| **A3** | **Admin view-as-client** (idea 27)                                | Near-free once scope is an argument, and it is what makes "my numbers look wrong" debuggable. Must never be able to leak the markup.                                                                                                                                                                                                                                                            | S    |
| **A4** | **Client pacing view** (idea 24)                                  | `forecastBudgetEnd()` + `paceWindow()` (14-day trailing, ≥3 complete days, engagement-clamped) already compute contracted budget vs projected burn-out for the dashboard and the Notion write-back. This is scoping plus presentation.                                                                                                                                                          | S    |

**Blocking rule for all of A:** clients must never see raw spend where markup is billed, real account
or campaign names, or internal Notion vocabulary — including in CSV exports and anything the chat
agent can reach.

**Pre-work inside A0:** resolve the two duplicate client rows
(`luckywhale`/`luckywhalecasino.com`, `play quack`/`playquack.com`) before granting either brand a
login, or the login shows half its spend.

### Cycle 2 — signals on data already synced

| #      | Item                                     | Why it is actionable                                                                                                                                                                                                                              | Size |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **H1** | **Blocked-spend signal** (idea 29)       | Configured vs deliverable budget per client: how much intended daily spend is stopped by disabled or unfunded accounts. `canDeliver()` already computes the input; `deriveStatus()` already classifies the account states.                        | S    |
| **H2** | **Dayparting** (idea 12)                 | 99,603 hourly rows across both timezone framings, fresh to today. Per-geo hour-of-day view and "budget burns out before the peak hour". **Account + campaign level only** — per-ad dayparting would need an ingestion change and is not in scope. | M    |
| **H3** | **Audience saturation curves** (idea 13) | 16,531 `frequency_value` rows + reach, fresh to today. Answers "refresh the _audience_" versus "refresh the creative" — a different question from creative fatigue, and the only half of that pair still available while B is on hold.            | M    |

### Parallel — Track N

| #      | Item                                  | Why it is actionable                                                                                                                                                                                                                                                                                                                                                                                                             | Size |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **N1** | **Infrastructure registry** (Track N) | 84 of 175 ad accounts are already policy-disabled and nothing records what access each ban cost. The graph cannot be synced — the live token lacks `business_management`, so every business-level Graph edge 403s — so an operator-owned registry is the only shape available. Ad-account status is the one synced field, joined read-only. Design written: `docs/superpowers/specs/2026-08-13-infrastructure-monitor-design.md` | L    |

---

## 4. Tracks

### A. Client-facing portal (replaces AgencyAnalytics) — _leading_

The reporting engine already exists, so the work is overwhelmingly access control, presentation and
the trust surface — not analytics.

- **Exists:** report engine with CSV/PDF + markup, per-client data model, attribution engine,
  approval-based auth with `superadmin|admin|member`, pacing forecast.
- **Missing:** the `client` role, the scope-grant join table, and a scope boundary. Every server fn
  queries agency-wide today.
- **Shipped 2026-08-13 — the UI, on mock data.** Five pages at
  [`/portal`](https://analytics.madsmonitor.com/portal): overview, campaigns (with audiences),
  creative approval, self-serve CSV/PDF export, and a client sign-in screen. Everything renders from
  `src/portal/mock.ts` — deterministic generated figures, no server fn, no database — so the look
  can be agreed while the decisions below are still open, and a leak is structurally impossible. The
  route group is exempt from the auth gate for exactly that reason; that exemption comes out the day
  it reads real data. Two invariants are already built into the UI because they shape it: spend is
  always the client-facing figure (no raw-spend formatter exists) and every name is a presentation
  alias in client language. `deploy/portal.madsmonitor.com.conf` serves it on its own hostname and
  bounces internal paths back to `/portal`; it needs a `portal.madsmonitor.com` A record plus
  `certbot --nginx` to go live.

**Identity: explicit scope grants.** Decided 2026-08-13 in preference to one login per `clients.id`.
Measured shape as of that date: 55 live clients, one row per brand, multi-account normal (up to 22
accounts on OneAgency), multi-brand rare, plus two duplicate brand pairs. A grant table covers all
four cases — single brand, agency with many brands, duplicated brand, and a single brand carved out
of an agency — with one mechanism, and keeps scope resolution in **one function**.

**Secure by construction, not by inspection.** Sprinkling `if (isClient)` across existing fns will
leak eventually. Resolve an explicit scope object and have client-facing fns _require_ it.

**Numbers that move.** `actions_by_window` means yesterday's conversions keep changing for up to 28
days. Policy: live dashboards with "as of" stamps, immutable issued reports. Periods are not frozen.

**Deferred out of cycle 1** (decided, revisit after A ships): idea 21 client-scoped AI chat, idea 23
self-serve scoped report builder, idea 11 divergence feed. Idea 22 (client creative approval loop)
is parked with Track B. Push notification of any kind is out of scope — see fork K.

### B. Creative intelligence — _on hold_

Highest defensibility and no external dependency, but no item was approved on 2026-08-13. Parked in
full: the `/creatives` rebuild, fatigue curves, winner/loser detection, cross-client benchmarks
(idea 7), ad-level breakdown ingestion, angle taxonomy (idea 1), pre-flight scoring (idea 2).

Two measurements to carry forward whenever it is picked up:

- **Fatigue must be built on `frequency` + CTR decay.** Ranking signals are unusable (see §1
  corrections): `quality_ranking` 0%, `engagement_rate_ranking` 30%.
- **Scale is ~365 delivering ad-days/day**, which is ample for book-wide asset ranking and thin for
  per-creative curves.

**Audience-analysis ceiling — measured 2026-08-05, still valid.** All 89 breakdowns Meta accepts on
this token were probed against live accounts. **There is almost nothing new worth syncing.** Depth
comes from using what is stored, not from more API calls.

- **Already synced, already deep:** age, gender, age×gender, country, region, device_platform, the
  publisher_platform × platform_position × impression_device triple, both hourly framings, frequency
  buckets, and 7 creative-asset dimensions at ad level. The breakdown sync requests `actions` +
  `action_values` and stores the whole response in `raw`, so **the full conversion funnel is already
  available per dimension** (40+ action types on `age|gender` alone) — the app aggregates one picked
  action type and discards the rest at query time.
- **The real gap is level, not dimension.** Fix would be ad-level `age|gender` + `device_platform` +
  `country` ONLY — region (908 values) and hourly at ad level would explode cardinality.
- **OS does not exist** as a Meta breakdown. OS _family_ is derivable from `impression_device`:
  Android $318,805 vs iOS $160,407 vs desktop $11,213 over the sampled window.
- **Offer is not a dimension** anywhere in Meta; it can only be derived from creative text/landing
  pages.
- **Blocked by Meta's combination rule:** `platform_position` alone, every `sot_*`,
  `standard_event_content_type`, all `media_*`, `mdsa_landing_destination`, `instagram_ads_*`,
  `existing_post_id`, `breakdown_ad_objective`. Meta always applies a default `action_type`
  breakdown and rejects `(action_type, <dim>)` regardless of fields, level or date range.
- **Accepted but zero rows:** `is_conversion_id_modeled`, `fidelity_type`, `overlap_segment`,
  `creative_automation_asset_id`, `app_id`, `skan_conversion_id`, `comscore_market`, `product_id`.
- **Rejected outright:** `zip`, `dma`, `rta_ugc_topic`, `pa_creator_ig_handle`,
  `impression_view_time_advertiser_hour_v2`, `product_brand_breakdown`, `mmm`,
  `configurable_audience_overlap_reach`.
- **Returns one null bucket only:** `signal_source_bucket`, `conversion_destination`,
  `landing_destination`, `place_page_id`, `user_persona_id`, `user_persona_name`, `rule_set_name`.
- **Genuinely new but single-valued:** `ad_format_asset`, `gen_ai_asset_type`,
  `creative_relaxation_asset_type`, `flexible_format_asset_type`, `reels_trending_topic` — revisit
  only if Advantage+ creative, AI variations or Reels placements start being used.

### C/D. Market creative intelligence → briefs → generation — _rejected_

Rejected 2026-08-13. The analysis is retained so the shape is not re-derived from scratch if the
decision is ever revisited.

Everything would have had to be built inside DOT: its own Telegram account and session, its own
ingestion worker, its own object storage, and either a manual hand-off of generated creatives or its
own Meta publishing leg. Three hard prerequisites, none owned:

- **Object storage.** At an operator estimate of 400–500 assets/day and an assumed 80/20 image/video
  mix, raw media ≈ 380 MB/day ≈ 11 GB/month ≈ 138 GB/year, which exceeds the droplet's 108 GB free
  space inside a year.
- **A similarity index.** `pgvector` is not available on this Postgres 16.14 (only `pg_trgm` and
  `pgcrypto`), and perceptual-hash dedupe before analysis was the main cost lever — reposting in
  those groups is heavy (40–70% duplicates assumed).
- **A DOT Telegram account + session + worker**, built from scratch, competing with the web app and
  hourly sync on a 3 GB box.

Design constraints that would still apply: dedupe before you spend; extract the _offer_, not just
the image; scraped data is a commodity until joined with our own results (so B must precede it);
derive, never copy, keeping provenance per asset.

### E. Account survival + QA — _mostly on hold_

Idea 29 (blocked-spend signal) is approved and sits in §3. The rest stays on hold: ban-risk scoring
from pre-ban patterns, nightly QA sweep (destination URL vs contracted, pixel firing, geo
compliance, naming lint, duplicate audiences), rejection/policy tracking.

Idea 30 (burn-rate-relative prepaid top-up alert) is **deferred, not rejected** — worth recording
why it was proposed: the existing low-funds alert uses an absolute `ALERT_LOW_FUNDS_USD = 100`
threshold, so the documented Slots.lv shape (19 of 20 campaigns blocked, ~$7.5k/day recent spend
against ~$1.6k of remaining capacity) would never have fired.

### F. Money + margin — _rejected_

### G. WatchTower reconciliation — _dropped, boundary violation_

WatchTower is a PetalPixel project. Retained here only so the idea is not re-proposed.

**Clarified 2026-08-13:** what is dropped is _reading or reconciling against WatchTower's data_. The
separate decision to build an infrastructure registry natively inside MetaConsole (§4, Track N) does not
revive this track and does not touch the boundary — see §0.

### N. Infrastructure registry — _approved 2026-08-13, in build_

A native registry of the asset graph the book runs on: Facebook profiles → Business Managers → ad
accounts, plus pixels and pages, with a risk map built on the redundancy rule (an asset with fewer than
two independent access paths is a single ban away from being unreachable).

Design: `docs/superpowers/specs/2026-08-13-infrastructure-monitor-design.md`. Branch `feat/infra-monitor`.

**Why it is actionable now.** Measured 2026-08-13: 84 of 175 ad accounts are already `DISABLED` with
`disable_reason = 1` (policy), and the app cannot say what access each ban cost. Only 14 of 175 accounts
expose their owning BM, and the live system-user token lacks `business_management`, so every
business-level Graph edge (`owned_ad_accounts`, `owned_pages`, `adspixels` at BM level, `owned_domains`,
`business_users`) returns a permission error. The graph is therefore unobtainable from Meta and must be
operator-maintained — which is what makes this a registry rather than a sync.

**Decided shape.** Operator-owned throughout: no sync job writes any `infra_` table. Ad-account status is
the one exception to manual entry — it is joined read-only from `accounts`, which already syncs it
hourly, so no operator types a status Meta already knows. Admin + superadmin only. Real foreign keys, and
status history with old → new values and the acting user.

**Deliberately not in it:** no token or scope change, no secrets, no alert rows or Telegram, no client or
spend linkage, no CSV import. Recorded because each was considered and declined, not overlooked.

---

## 5. Candidate tracks

### H. Data already synced and never used

Ideas 12 and 13 approved (§3). Remainder:

- **Attribution-window intelligence** (idea 14) — _deferred_. `actions_by_window` exists only from
  2026-05-21 on 60% of delivering ad-days, and its main consumer (frozen periods) was narrowed to
  immutable report artifacts, which need no window re-derivation.
- **Depositor value / early LTV** (idea 15) — _rejected_. `action_values` on 1.5% of delivering
  ad-days; the data is not being sent upstream.
- **Audience overlap across accounts** (idea 16) — _rejected_. Meta blocklisted
  `configurable_audience_overlap_reach`; only same-source inference from 37 audience rules is
  possible, which is not the question anyone asked.
- **Automated-rule management** (idea 17) — _deferred_. 91 rules synced, but `meta_objects` keeps
  only the current snapshot, so version history can only accumulate from build time forward and
  misfire detection has no historical basis.

### I. Creative localisation engine — _rejected_

Per-geo variant sets from proven winners (USA, Canada, Germany, Brazil, Romania). Rejected
2026-08-13; also had Track B as a hard input.

### J. Policy and rejection archive — _rejected_

A pre-submission linter plus an archive of what actually got rejected. Rejected 2026-08-13. Noted
for the record: the archive half was startable without any purchase, since ad `effective_status`
`DISAPPROVED` is already synced and consumed by `deriveStatus()`.

### K. Interface direction — _resolved: dashboard-first_

Telegram remains exception-driven alerts only (`alerts.ts`: spend collapse ≥95% vs trailing-7-day
baseline, prepaid funds under $100 on an in-use account, unassigned spend). No scheduled digest
(idea 8 rejected). No agent write actions (idea 20 rejected) — the agent's 7 tools stay read-only.

### L. Breadth vs depth — _resolved: depth on Meta_

Google / TikTok / Kwai (idea 28) rejected. Every table and fieldset is Meta-specific; breadth would
multiply surface area on a single 3 GB droplet.

### M. Productisation — _rejected_

Benchmark index, CPA underwriting, white-label to other agencies, prompt library with lineage. All
depend on Track A multi-tenancy plus Track B, which is on hold.

---

## 6. Cross-cutting prerequisites

Only the first two are live concerns after the 2026-08-13 triage.

| Prerequisite                                          | Gates          | Status                                                                                                                                                                                    |
| ----------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-tenant identity + row-level scoping             | A (leading), M | **Critical path, decided.** Explicit scope grants, `client` role, invite-only client users (never self-signup), view-as-client, presentation aliases, no markup leakage. This is item A0. |
| Hosting review                                        | A              | **Open.** A public client portal on a single 3 GB instance with no redundancy turns uptime into an SLA conversation. Open question 4 below.                                               |
| Data-trust surface                                    | A              | Folded into A2: "as of" stamps plus immutable issued reports, sourced from existing sync health + `mappingSyncedAt`.                                                                      |
| Object storage + CDN                                  | C/D            | **Moot** — C/D rejected.                                                                                                                                                                  |
| DOT Telegram account + session + worker               | C/D            | **Moot** — C/D rejected.                                                                                                                                                                  |
| Base44 read integration                               | idea 9         | **Moot** — rejected.                                                                                                                                                                      |
| DOT publishing leg (Meta Ad Creative API)             | C/D            | **Moot** — C/D rejected.                                                                                                                                                                  |
| Similarity index (`pgvector` unavailable on PG 16.14) | B, C/D         | **Dormant** — revisit only if B is taken off hold.                                                                                                                                        |
| LLM/vision cost guardrails                            | B, agent work  | **Dormant** — the `finance.tsx` per-user cost-tracking pattern is the model when needed.                                                                                                  |

---

## 7. Idea backlog — decided

| #   | Idea                                                                       | Track | Status (2026-08-13)                                                                           |
| --- | -------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| 1   | Angle taxonomy spanning own creatives                                      | B     | On hold with B                                                                                |
| 2   | Creative pre-flight scoring                                                | B     | On hold with B                                                                                |
| 3   | Trend velocity radar                                                       | C/D   | **Rejected**                                                                                  |
| 4   | Brand watch                                                                | C/D   | **Rejected**                                                                                  |
| 5   | Landing-page intelligence                                                  | C/D   | **Rejected**                                                                                  |
| 6   | Client-facing creative showcase                                            | A     | On hold with B                                                                                |
| 7   | Vertical benchmarks from our own book                                      | A/M   | On hold with B                                                                                |
| 8   | Buyer digest via DOT's Telegram bot                                        | K     | **Rejected** — fork K resolved dashboard-first                                                |
| 9   | Asset reconciliation (designed but never run)                              | C/D   | **Rejected**                                                                                  |
| 10  | Prompt library with lineage                                                | M     | **Rejected**                                                                                  |
| 11  | Divergence feed (Notion vs Meta)                                           | A     | Deferred — not in cycle 1                                                                     |
| 12  | Dayparting recommendations                                                 | H     | **APPROVED** — §3 H2                                                                          |
| 13  | Audience saturation curves                                                 | H     | **APPROVED** — §3 H3                                                                          |
| 14  | Attribution-window intelligence                                            | H     | Deferred — data only from 2026-05-21, 60% coverage                                            |
| 15  | Depositor-value / early-LTV proxies                                        | H     | **Rejected** — `action_values` on 1.5% of rows                                                |
| 16  | Cross-account audience overlap                                             | H     | **Rejected** — metric blocklisted by Meta                                                     |
| 17  | Central automated-rule management                                          | H     | Deferred — no reconstructable version history                                                 |
| 18  | Creative localisation engine                                               | I     | **Rejected**                                                                                  |
| 19  | Policy linter + rejection archive                                          | J     | **Rejected**                                                                                  |
| 20  | Agent write-actions behind approval                                        | K     | **Rejected** — live accounts, no undo, fuzzy client resolution                                |
| 21  | Client-scoped AI chat                                                      | A     | Deferred — revisit after A ships                                                              |
| 22  | Client creative approve/reject loop                                        | A     | On hold with B                                                                                |
| 23  | Self-serve scoped report builder                                           | A     | Deferred — revisit after A ships                                                              |
| 24  | Client pacing view                                                         | A     | **APPROVED** — §3 A4                                                                          |
| 25  | Presentation alias layer                                                   | A     | **APPROVED** — §3 A1                                                                          |
| 26  | Finalised/frozen reporting periods                                         | A     | **APPROVED, narrowed** — §3 A2: immutable issued reports, live dashboards, periods not frozen |
| 27  | Admin "view as client" mode                                                | A     | **APPROVED** — §3 A3                                                                          |
| 28  | Multi-platform ingestion (Google/TikTok/Kwai)                              | L     | **Rejected** — fork L resolved depth-on-Meta                                                  |
| 29  | Blocked-spend signal                                                       | E/H   | **APPROVED** — §3 H1                                                                          |
| 30  | Prepaid top-up alert (burn-rate relative)                                  | E     | Deferred — existing alert is an absolute $100 threshold and would have missed Slots.lv        |
| —   | Scope grants + `client` role                                               | A     | **APPROVED** — §3 A0, prerequisite for all of A                                               |
| —   | Ad-level breakdown ingestion (`age\|gender`, `device_platform`, `country`) | B     | On hold with B                                                                                |

Withdrawn earlier as PetalPixel-dependent, retained so they are not re-proposed: WatchTower
status/budget reconciliation, provider survival scorecard, account survival analysis, warm-up
playbooks, spare-pool forecasting, field-ownership registry across systems, ad-comment sentiment.

---

## 8. Open questions

Resolved on 2026-08-13: client-facing attribution policy (live numbers, immutable issued reports,
no frozen periods), interface direction (dashboard-first), breadth vs depth (depth on Meta). Base44
integration shape, Telegram group volume and C/D publishing are **withdrawn** with the C/D and idea-9
rejections.

Still open:

1. **Client login provisioning** — invite-only is decided, but who issues invites, and does a client
   user reset their own password? Gates A0.
2. **Duplicate client rows** — merge `luckywhale`/`luckywhalecasino.com` and `play
quack`/`playquack.com`, or grant one login both ids? A0 needs one or the other.
3. **Agency logins** — do OneAgency (22 accounts) and omni agency (9) get one login across their
   brands, or one per brand? Scope grants support both; the commercial answer is not ours.
4. **Hosting** — does a public client portal justify moving off a single 3 GB droplet with no
   redundancy?
