# MetaConsole — Product Roadmap

**Status: ideation.** Nothing here is approved for build. This is a living backlog: what we
already own, what we decided, what we rejected, and the ideas worth keeping. Each track becomes its
own design → plan → build cycle when it is picked up.

Last updated: 2026-08-03

---

## 1. What we already own

The roadmap is credible only because most of it is a query/UI problem on data that is already
flowing. Verified counts from production Postgres:

| Asset | Volume | Notes |
| --- | --- | --- |
| Ad-level daily insights | 654,101 rows | `insights_daily`, level=`ad` |
| Ad creatives | 25,495 (14,231 with thumbnails) | `ad_creatives`: title, body, CTA, link, `asset_feed_spec` |
| Ads | 7,613 | incl. `preview_shareable_link` |
| Asset-level breakdowns | `image_asset` 15,027 · `body_asset` 12,792 · `title_asset` 12,465 · `link_url_asset` 8,862 · `call_to_action_asset` 8,840 · `video_asset` 1,189 | since 2026-06-25 — per-hook/headline/image performance |
| Hourly breakdowns | 46,993 + 44,228 rows | audience-timezone and advertiser-timezone; **unused today** |
| Frequency breakdown | 15,220 rows | `frequency_value`; **unused today** |
| Geo / demo / placement | `region` 76,591 · `age|gender` 36,581 · `country` 13,581 · placement triple 71,879 | back to 2025-11-12 for the older groups |
| Meta asset library | 5,202 `ad_image` + 2,530 `ad_video` | `meta_objects` — what actually exists per account |
| Pixels / audiences / rules | 54 pixels · 60 custom audiences · 45 automated rules | `meta_objects` |
| Change history | 40,172 activities with actor names | `meta_activities` |
| Quality signals | per ad/day | `frequency`, `qualityRanking`, `engagementRateRanking`, `conversionRateRanking`, `estimatedAdRecallRate` |
| Conversion detail | per ad/day | `actions`, `action_values`, and `actions_by_window` (1d/7d/28d view+click) |
| History depth | 37 months insights / 13 months breakdowns | Meta's retention ceilings; resumable backfill |

Already built and reusable: report engine with CSV/PDF + commission markup (`/reports`), AI chat
agent with tools + persisted history + per-user cost tracking, spend-drop alerts with Telegram
delivery, Notion two-way sync, cross-client attribution engine (account reuse, brand splitting,
manual overrides), audiences and activity views, admin/superadmin/member auth with approval flow.

Deliberately stubbed: `/creatives` renders a "being rebuilt" placeholder while all the data above
sits in Postgres.

### Adjacent systems we already run

| System | Owns | Join key |
| --- | --- | --- |
| **MetaConsole** (this app) | performance truth, polled hourly from Meta | `accounts.id` |
| **WatchTower** (`watch.madsmonitor.com`) | infrastructure supply chain: Profile → BusinessManager → AdAccount → Pixel/Page with `banned`/`restricted`/`in_review` statuses, agency contacts, `warmingThresholdDays`, `sparePoolMinCount` — hand-maintained in Firestore | `AdAccount.metaAccountId` |
| **Notion** campaigns board | commercial layer: engagements, budgets, statuses, Supplier Payment Log | `Active Account ID` |
| **TG Bot** (`tg.madsmonitor.com`) | live Telethon **user** session, reads joined groups, LLM summarisation | — |

Consequences worth acting on: `dailyBudget` is manually duplicated in Notion **and** WatchTower
while Meta holds the truth; WatchTower's statuses are typed by hand while this app already polls
them hourly; and no system joins *which provider supplied an account* to *how long it survived and
what it spent*.

---

## 2. Decisions

| Track | Decision |
| --- | --- |
| A — Client-facing dashboard | **In — full client portal with logins.** Real client accounts with row-level scoping, not share links. Makes multi-tenant identity critical-path and the foundation for any later white-labelling (Track M). |
| B — Creative intelligence | **In** |
| C/D — Creative library + generator | **In, reframed**: ingest and analyse market creatives scraped from Telegram groups, then derive briefs/prompts — not an internal designer↔buyer file pipeline |
| E — Account survival + QA | **On hold** |
| F — Money + margin / client P&L | **Rejected** |
| G — Infrastructure procurement economics | **Narrowed to reconciliation only**: kill WatchTower's hand-typed statuses and its stale duplicate of daily budget. The survival/procurement analytics (provider scorecard, survival analysis, warm-up evidence, spare-pool forecasting) are parked with E. |

---

## 3. Tracks

### A. Client-facing portal (replaces AgencyAnalytics)

**Decided: full portal with client logins.** The reporting engine already exists, so the work is
overwhelmingly access control, presentation and the trust surface — not analytics.

- **Exists:** report engine with CSV/PDF + markup, per-client data model, attribution engine,
  approval-based auth with `superadmin|admin|member`.
- **Missing:** a `client` role bound to a `clients.id`, and a scope boundary. Every server fn queries
  agency-wide today.

**Identity grain: one login per `clients.id`.** Checked against production: of 55 live clients, 43
are single-row and 12 multi-row — but most multi-row cases are *successive engagements of one brand*
(betonline.ag May/June/July 2026; acrpoker.eu Poker/Money Maker/Welcome Bonus;
fortunegalaxy.io Palmluck ×2), which a client should see merged. Only ~3 are genuinely multi-brand:
**OneAgency** (CafeCasino / Lucky Rebel / Slots.lv), **omni agency** (8 rows), and **bspin.io**
(which also carries casincity.io). Those need a **brand filter inside their own dashboard** — a UI
affordance over the per-row scope attribution already resolves — not separate logins.

Known limit, accepted: a single brand under an agency cannot be given a login that hides its
siblings. If that is ever required, the model becomes explicit scope grants. Keeping scope
resolution in **one function** makes that upgrade additive rather than a rewrite — the same
discipline that makes view-as-client nearly free.

**Secure by construction, not by inspection.** Sprinkling `if (isClient)` across existing fns will
leak eventually. Resolve an explicit scope object (allowed account ids + owned campaign ids, via the
existing `ownedCampaignIds` attribution) and have client-facing fns *require* it as an argument, so
an unscoped query cannot be written by accident. Note `clients.id` is a guessable slug
(`wildcasino-ag`), so no route may key off an id without an authorisation check.

**What clients must never see** — the non-obvious part:

- **The markup.** Reports already take a commission `markup`; if you bill on it, raw spend cannot
  appear anywhere in the portal, including CSV exports and the chat agent.
- **Your infrastructure.** Account names expose the rented-account supply chain
  (`DOT-GO-GMT-8-7`, `Amber Media-（UTC-4）-5`) and imply providers. The portal needs a presentation
  alias layer over accounts and campaigns.
- **Internal vocabulary.** Notion statuses like `Full Budget Finished` / `Budget Finished - Top Up`
  are operations language, not client language.

**Numbers that move.** `actions_by_window` means yesterday's conversions keep changing for up to 28
days. A client who screenshots Monday's figure will notice. Needs an explicit policy: "as of"
timestamps, a fixed attribution window for client-facing views, and finalised/frozen periods.

**Support surface.** An admin "view as client" mode is near-free if scope is an argument and
painful if it is implicit in the session — and it is what makes "my numbers look wrong" calls
debuggable.

**Only possible once clients log in:**

- **Client-scoped AI chat** — "why did my CPA rise last week?". The agent, tools, history and
  per-user cost tracking already exist; needs scope injected into every tool and a per-client cost
  cap. No competitor in this space has this.
- **Creative showcase + approval loop** — clients approve/reject creatives, which feeds Track C/D
  production. Turns the portal from read-only reporting into workflow.
- **Self-serve report builder** — a scoped `/reports`, which removes the request-a-report loop.
- **Shared pacing view** — contracted budget vs projected burn-out (already computed in
  `ClientDetailView`), which pre-empts "are we on track" emails.

Push notification still matters after logins: email/Telegram digests that deep-link into the portal.

### B. Creative intelligence

The real moat, and mostly a query/UI problem on data already synced.

- **Exists:** everything in the asset-breakdown and quality-signal rows above.
- **Build:** rank hooks / headlines / CTAs / images **across the whole book of business**, not per
  account; creative fatigue curves (frequency + CTR decay + ranking signals); winner/loser detection
  with spend-weighted confidence; cross-client benchmarks by geo/placement/vertical; "this hook is
  dying on account X but still fresh on Y".
- **Feeds:** Track A (showcase), Track C/D (the join that turns scraped data into a moat).

### C/D. Market creative intelligence → briefs → generation

Reframed from an internal pipeline into a market-signal pipeline.

```
Telegram groups ─┐
                 ├─► ingest + perceptual-hash dedupe ─► vision/OCR analysis ─► searchable library
Meta Ad Library ─┘                                      (offer, angle, format,   + trend velocity
                                                         geo, brand, layout)            │
                                                                                        ▼
                        own creative + asset performance (Track B) ──► JOIN ──► briefs + prompts
                                                                                        │
                                                                                        ▼
                                                              generation ──► push to Meta ──► results
```

- **Exists:** the hard part. The TG bot already runs a Telethon **user** session (can read any
  joined group; a bot account cannot), already listens on `events.NewMessage` and backfills via
  `iter_messages`. It does **not** yet call `download_media` — that is the addition.
- **Missing:** object storage + CDN, media dedupe, vision/OCR analysis, similarity index.
- **Four design constraints:**
  1. **Dedupe before you spend.** Those groups repost the same asset endlessly; perceptual-hash
     first, analyse once, or vision cost scales with reposts instead of information.
  2. **Extract the offer, not just the image.** In iGaming the offer ("100% up to $500 + 50 free
     spins", wagering terms) is the lever and the most benchmarkable field on a creative.
     Offer × geo × brand is likely worth more than visual analysis.
  3. **Scraped data alone is a commodity.** It becomes defensible only at the join with our own
     results — which is why B must precede D.
  4. **Derive, don't copy.** Keep provenance per asset; ship archetypes, angles, offers and prompts,
     never recomposited pixels. Add the official **Meta Ad Library API** as a parallel source
     (structured, EU spend/impression ranges, covers advertisers absent from those groups).

### E. Account survival + QA — *on hold*

Ban-risk scoring from pre-ban patterns; nightly QA sweep (destination URL vs contracted, pixel
firing, geo compliance, naming lint, duplicate audiences); rejection/policy tracking.

### F. Money + margin — *rejected*

---

## 4. New tracks under consideration

### G. WatchTower reconciliation — *live, narrow*

The only part in scope: WatchTower maintains account/BM/pixel/page statuses by hand in Firestore,
and carries `AdAccount.dailyBudget` as a third manual copy of a number Meta already reports. This
app polls the truth hourly. Reconcile, and flag divergence instead of retyping it.

A design fork to settle when it is picked up, because it decides which box and which repo the work
lands in:

1. **Push** — this app writes reconciled status/budget into Firestore (mirrors the Notion write-back
   pattern already proven in `sync/jobs/notion-budget.ts`).
2. **Pull** — WatchTower reads a small read-only endpoint here and reconciles client-side.
3. **Shared entity service** — extract the `act_` id graph once and let both consume it. Most
   correct, most work; only worth it if the parked analytics below ever revive.

Parked with E (same data, procurement framing rather than firefighting): provider scorecard —
which supplier's accounts survive longest per dollar (`Ads Platform` / `Provider Name` + WatchTower
agency contacts + our `disabledSince`); survival analysis by provider/geo/spend-ramp; evidence-based
warm-up curves to replace WatchTower's guessed `warmingThresholdDays`; spare-pool burn forecasting
against its static `sparePoolMinCount`.

### H. Data already synced and never used

Each is small and independently shippable.

- **Dayparting** — 91k hourly rows across both timezone framings. Per-geo hour-of-day
  recommendations, and "your budget burns out before the peak hour" alerts.
- **Frequency / saturation curves** — 15,220 `frequency_value` rows + reach. When to refresh the
  *audience* rather than the creative — a different question from creative fatigue.
- **Attribution-window intelligence** — `actions_by_window` splits every conversion 1d/7d/28d
  view+click. Almost nobody looks at it; it reveals which creatives win on view-through versus
  click, and how much of a "win" is attribution artefact.
- **Depositor value, not registrations** — `action_values` + `purchase_roas` + windows give
  depositor-value curves and early proxies for LTV. For iGaming, registrations are cheap and
  depositors are the business.
- **Audience overlap across accounts** — 60 custom audiences; detect our own accounts
  cannibalising each other. Meta's overlap tool does not work across many accounts.
- **Automated-rule management** — 45 `ad_rule` objects already synced. Central rule templates,
  version history, misfire detection.

### I. Creative localisation engine

They run USA, Canada, Germany, Brazil, Romania and more. Take a proven creative and localise it —
language, currency, payment methods, local hooks/holidays — into a per-geo variant set. A far more
valuable generator use-case than "make me an ad", and it consumes Track B's winners directly.

### J. Policy and rejection archive

iGaming rejections are constant. A pre-submission linter (text-in-image ratio, prohibited claims,
age-gating, geo restrictions) plus an archive of what actually got rejected, so the rejection
history becomes training data rather than lost tribal knowledge.

### K. Interface direction (a fork, not a feature)

- **Agent-first** — the chat agent already has tools, history and cost tracking. Give it write
  actions behind approval and it becomes the primary surface; dashboards become a fallback.
- **Telegram-first for buyers** — the team lives in Telegram, and the delivery path already exists
  in `alerts.ts`. A daily buyer digest (rotate these, scale those, three trending archetypes) and a
  mini-app for the approve/pause loop may beat a web dashboard for the daily workflow.
- **Dashboard-first** — the status quo.

### L. Breadth vs depth (a fork)

Google / TikTok / Kwai are the obvious next channels for this vertical. The ingestion shape
(structure + insights + breakdowns + attribution) generalises, but every current table and
fieldset is Meta-specific. Breadth multiplies surface area; depth (Tracks B, C/D, G) compounds on
data nobody else has. Not a decision to drift into.

### M. Productisation (speculative)

- **Benchmark index** — 37 months of iGaming Meta performance across many accounts, published as
  aggregate-only benchmarks (CPM/CTR/CPA by geo/month). Aggregate-only keeps client confidentiality
  defensible.
- **CPA underwriting** — knowing real CPA per geo lets you price on outcome instead of media-buying
  fees. A business-model change, not a feature.
- **White-label to other agencies** — account survival + creative intelligence is what peers would
  pay for. Needs the same multi-tenancy as Track A.
- **Prompt library with lineage** — every generated prompt linked back to the archetype that
  inspired it and forward to the performance it produced. The compounding record, and the only part
  of C/D that is genuinely hard to copy.

---

## 5. Cross-cutting prerequisites

| Prerequisite | Gates | Notes |
| --- | --- | --- |
| Multi-tenant identity + row-level scoping | A (decided), M | **Critical path.** Scope-as-argument, `client` role, invite-only client users (never self-signup), view-as-client, presentation aliases, no markup leakage. |
| Object storage + CDN | C/D, and the upload half of any creative library | Droplet has 108 GB free but only **3 GB RAM**; media work belongs on the Hetzner box (8 CPU / 16 GB) which already holds the TG session. |
| Similarity index | B (near-duplicate creatives), C/D | `pgvector` is **not available** on this Postgres 16.14 — only `pg_trgm` and `pgcrypto`. Needs `postgresql-16-pgvector` or another approach. |
| Entity graph across the four systems | G, and any cross-system reporting | `act_` id is the join key present in all of them. |
| LLM/vision cost guardrails | C/D, agent work | The `finance.tsx` per-user cost tracking pattern already exists; thousands of assets/day × vision calls is real money. |
| Data-trust surface | A | Freshness/completeness badge per client-facing report, from existing sync health + `mappingSyncedAt`. Prevents "your numbers don't match Meta". |

---

## 6. Idea backlog

| # | Idea | Track | Depends on |
| --- | --- | --- | --- |
| 1 | Angle taxonomy spanning own + scraped creatives | B/C-D | — |
| 2 | Creative pre-flight scoring (predicted CTR/CPA band) | B | asset history |
| 3 | Trend velocity radar (volume × recency, saturation decay) | C/D | ingestion |
| 4 | Brand watch ("what Stake ran in DE this week") | C/D | ingestion + brand detection |
| 5 | Landing-page intelligence + own-LP QA | C/D | `link_url_asset`, screenshotting |
| 6 | Client-facing creative showcase | A | B |
| 7 | Vertical benchmarks from our own book | A/M | — |
| 8 | Buyer digest into Telegram | K | B |
| 9 | Asset reconciliation (designed but never run) | C/D | `meta_objects` + designer library |
| 10 | Prompt library with lineage | M | C/D |
| 11 | WatchTower status + budget reconciliation | G | `act_` id join, push/pull decision |
| 12 | Provider survival scorecard | parked (E) | entity graph |
| 13 | Account survival analysis | parked (E) | entity graph |
| 14 | Warm-up playbooks from evidence | parked (E) | entity graph |
| 15 | Spare-pool burn forecasting | parked (E) | entity graph |
| 16 | Dayparting recommendations + pre-peak burnout alert | H | — |
| 17 | Audience saturation curves | H | — |
| 18 | Attribution-window intelligence | H | — |
| 19 | Depositor-value / early-LTV proxies | H | — |
| 20 | Cross-account audience overlap | H | — |
| 21 | Central automated-rule management | H | — |
| 22 | Creative localisation engine | I | B |
| 23 | Policy linter + rejection archive | J | — |
| 24 | Agent write-actions behind approval | K | — |
| 25 | Multi-platform ingestion (Google/TikTok/Kwai) | L | strategic decision |
| 26 | Divergence feed — every human-typed value that disagrees with Meta (Notion status, WatchTower status, budget copies, contracted geo vs delivery, contracted URL vs live ad) | G/A | — |
| 27 | Field ownership registry — declare per field which system owns it and which mirrors it | G | — |
| 28 | Client-scoped AI chat ("why did my CPA rise?") | A | scope boundary + per-client cost cap |
| 29 | Client creative showcase + approve/reject loop | A | B, scope boundary |
| 30 | Self-serve scoped report builder | A | scope boundary |
| 31 | Client pacing view (contracted budget vs projected burn-out) | A | scope boundary |
| 32 | Presentation alias layer for accounts/campaigns (hide infrastructure) | A | scope boundary |
| 33 | Finalised/frozen reporting periods + fixed client attribution window | A | — |
| 34 | Admin "view as client" mode | A | scope-as-argument |

---

## 7. Open questions

1. Track G: push into Firestore, pull from an endpoint here, or extract a shared entity service?
2. Track A: which attribution window do client-facing numbers use, and are periods frozen once
   reported? `actions_by_window` means an unfrozen figure keeps moving for 28 days.
3. Where do designer creatives live today (Drive / Dropbox / Notion `Creative Files`)? Decides
   whether Track C/D can reconcile our own library or only the Meta-side one.
4. How many Telegram groups, and roughly what daily volume? Sizes storage, dedupe and vision cost.
5. Interface direction (Track K): does the daily buyer loop live in Telegram or the web app?
6. Breadth vs depth (Track L): more channels, or deeper on Meta?
7. Does the portal being public change hosting? The droplet is a single 3 GB instance with no
   redundancy; client logins turn uptime into an SLA conversation.
