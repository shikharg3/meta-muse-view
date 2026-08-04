# MetaConsole — Product Roadmap

**Status: ideation.** Nothing here is approved for build. This is a living backlog: what we
already own, what we decided, what we rejected, and the ideas worth keeping. Each track becomes its
own design → plan → build cycle when it is picked up.

Last updated: 2026-08-03

---

## 0. Agency boundary — read this first

**MetaConsole belongs to DOT Agency. DOT and PetalPixel projects MUST NOT be interlinked.**

The discriminator is hosting: DOT Agency runs on the **DigitalOcean droplet**; the Hetzner box hosts
**PetalPixel** projects.

| In scope (DOT) | Notes |
| --- | --- |
| **MetaConsole** — DO droplet, `analytics.madsmonitor.com` | this app: Meta sync, attribution, reporting, AI chat |
| **Notion** campaigns board — `dotaudiences` workspace | commercial layer; already integrated both ways |
| **Asset Library** — `library.dotaudiences.com` (Base44) | **In scope, read-only.** SaaS on a DOT domain, and DOT's own designer → media-buyer workflow, so treated like Notion. MetaConsole reads asset metadata and writes nothing: Base44 stays the designers' source of truth. |

Out of scope — **do not integrate, do not read, do not sync**. Listed only as a guardrail so this
boundary is not re-crossed by a future proposal: everything on the Hetzner box, including the
Telegram bot and its Telethon session, the Meta Ads Uploader, fbtools, n8n, WatchTower, the VA task
manager and the finance app.

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

The roadmap is credible only because most of it is a query/UI problem on data already flowing.
Verified counts from DOT's production Postgres:

| Asset | Volume | Notes |
| --- | --- | --- |
| Ad-level daily insights | 654,101 rows | `insights_daily`, level=`ad` |
| Ad creatives | 25,495 (14,231 with thumbnails) | `ad_creatives`: title, body, CTA, link, `asset_feed_spec` |
| Ads | 7,613 | incl. `preview_shareable_link` |
| Asset-level breakdowns | `image_asset` 15,027 · `body_asset` 12,792 · `title_asset` 12,465 · `link_url_asset` 8,862 · `call_to_action_asset` 8,840 · `video_asset` 1,189 | since 2026-06-25 — per-hook/headline/image performance |
| Hourly breakdowns | 46,993 + 44,228 rows | audience-timezone and advertiser-timezone; **unused today** |
| Frequency breakdown | 15,220 rows | `frequency_value`; **unused today** |
| Geo / demo / placement | `region` 76,591 · `age\|gender` 36,581 · `country` 13,581 · placement triple 71,879 | back to 2025-11-12 for the older groups |
| Meta asset library | 5,202 `ad_image` + 2,530 `ad_video` | `meta_objects` — what actually exists per account |
| Pixels / audiences / rules | 54 pixels · 60 custom audiences · 45 automated rules | `meta_objects` |
| Change history | 40,172 activities with actor names | `meta_activities` |
| Quality signals | per ad/day | `frequency`, `qualityRanking`, `engagementRateRanking`, `conversionRateRanking`, `estimatedAdRecallRate` |
| Conversion detail | per ad/day | `actions`, `action_values`, and `actions_by_window` (1d/7d/28d view+click) |
| History depth | 37 months insights / 13 months breakdowns | Meta's retention ceilings; resumable backfill |

Already built and reusable: report engine with CSV/PDF + commission markup (`/reports`), AI chat
agent with tools + persisted history + per-user cost tracking, spend-drop alerts with delivery to
DOT's own Telegram bot, Notion two-way sync (including the auto-updated daily-budget column),
cross-client attribution engine (account reuse, brand splitting, manual overrides), audiences and
activity views, admin/superadmin/member auth with an approval flow.

Deliberately stubbed: `/creatives` renders a "being rebuilt" placeholder while all the data above
sits in Postgres.

---

## 2. Decisions

| Track | Decision |
| --- | --- |
| A — Client-facing portal | **In — full client portal with logins.** Real client accounts with row-level scoping, not share links. Makes multi-tenant identity critical-path and the foundation for any later white-labelling (Track M). |
| B — Creative intelligence | **In.** Runs entirely on DOT's own Postgres — no external dependency of any kind. |
| C/D — Market creative intelligence → briefs → generation | **In, reframed**: ingest and analyse market creatives from Telegram groups, then derive briefs/prompts. Scope revised upward once the agency boundary was clarified — see the track. |
| E — Account survival + QA | **On hold.** |
| F — Money + margin / client P&L | **Rejected.** |
| G — WatchTower reconciliation | **Dropped — boundary violation.** WatchTower is a PetalPixel project. Approved before the DOT/PetalPixel split was known; withdrawn. |

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
(betonline.ag May/June/July 2026; acrpoker.eu Poker/Money Maker/Welcome Bonus; fortunegalaxy.io
Palmluck ×2), which a client should see merged. Only ~3 are genuinely multi-brand: **OneAgency**
(CafeCasino / Lucky Rebel / Slots.lv), **omni agency** (8 rows), and **bspin.io** (which also carries
casincity.io). Those need a **brand filter inside their own dashboard** — a UI affordance over the
per-row scope attribution already resolves — not separate logins.

Known limit, accepted: a single brand under an agency cannot be given a login that hides its
siblings. If that is ever required, the model becomes explicit scope grants. Keeping scope resolution
in **one function** makes that upgrade additive rather than a rewrite — the same discipline that makes
view-as-client nearly free.

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

**Support surface.** An admin "view as client" mode is near-free if scope is an argument and painful
if it is implicit in the session — and it is what makes "my numbers look wrong" calls debuggable.

**Only possible once clients log in:**

- **Client-scoped AI chat** — "why did my CPA rise last week?". The agent, tools, history and
  per-user cost tracking already exist; needs scope injected into every tool and a per-client cost
  cap. No competitor in this space has this.
- **Creative showcase + approval loop** — clients approve/reject creatives, which feeds Track C/D.
  Turns the portal from read-only reporting into workflow.
- **Self-serve report builder** — a scoped `/reports`, which removes the request-a-report loop.
- **Shared pacing view** — contracted budget vs projected burn-out (already computed in
  `ClientDetailView`), which pre-empts "are we on track" emails.

Push notification still matters after logins: email or Telegram digests that deep-link into the
portal, using DOT's own bot.

### B. Creative intelligence

The strongest track: highest defensibility, no external dependency, and mostly a query/UI problem on
data already synced to DOT's Postgres.

- **Exists:** everything in the asset-breakdown and quality-signal rows above.
- **Build:** rank hooks / headlines / CTAs / images **across the whole book of business**, not per
  account; creative fatigue curves (frequency + CTR decay + ranking signals); winner/loser detection
  with spend-weighted confidence; cross-client benchmarks by geo/placement/vertical; "this hook is
  dying on account X but still fresh on Y".
- **Feeds:** Track A (client-facing creative showcase), Track C/D (the join that turns scraped market
  data into a moat), Track I (localisation source material).

### C/D. Market creative intelligence → briefs → generation

```
Telegram groups ─┐
(DOT's own       ├─► ingest + perceptual-hash dedupe ─► vision/OCR analysis ─► searchable library
 account +       │                                      (offer, angle, format,   + trend velocity
 session)        │                                       geo, brand, layout)            │
Meta Ad Library ─┘                                                                      ▼
                        own creative + asset performance (Track B) ──► JOIN ──► briefs + prompts
                                                                                        │
                                                                                        ▼
                                                            generation ──► hand-off or DOT's own
                                                                           publishing leg ──► results
```

**Everything here must be built inside DOT.** The earlier plan assumed reuse of a Telethon session,
an orchestration engine and a publisher — all three are PetalPixel projects and are unavailable. DOT
needs its own Telegram account and session, its own ingestion worker (the existing `sync/worker.ts`
scheduler is the natural pattern to follow), its own object storage, and either a manual hand-off of
generated creatives or its own Meta publishing leg via the Ad Creative API.

**Asset Library integration (read-only).** Base44 auto-generates REST endpoints matching each app's
data model, and `@base44/sdk` exposes an `entities` module keyed by `appId` + an account-level API
key. The constraint that shapes the design: the **service role is only available inside
Base44-hosted backend functions — an external backend gets user-level permissions only.** So rather
than handing MetaConsole a broad account key, add a purpose-built **backend function inside the Asset
Library** that returns exactly the asset metadata needed. One explicit contract, no broad
credential, and writes are impossible by construction rather than by policy. (The app id appears to
be `69eb3537ab5f6a418b76c014`, inferred from the public `media.base44.com` asset URL — to be
confirmed in Base44's settings.)

What that unlocks: matching designed assets against the 5,202 `ad_image` + 2,530 `ad_video` objects
already synced here — i.e. which creatives were designed but never run (wasted design hours), which
ran and how they performed, and closing the creative loop at the design end.

**Volume math** (operator estimate: 400–500 assets/day; file sizes and vision pricing below are my
estimates, to be replaced by measurement once group links are shared):

- ~450/day ≈ 13.5k/month ≈ 164k/year.
- At an assumed 80/20 image/video mix (~300 KB and ~3 MB), raw media ≈ **380 MB/day ≈ 11 GB/month ≈
  138 GB/year** — which exceeds the droplet's 108 GB free space inside a year. Object storage is a
  real purchase, or thumbnails hot with originals in cold storage.
- Reposting in these groups is heavy; if 40–70% are duplicates, unique assets are ~150–270/day.
  Perceptual-hash dedupe **before** analysis is the main cost lever, and OCR can run locally
  (tesseract) to keep text extraction off the vision bill entirely.
- Analysing only unique assets is cheap at this scale — roughly single-digit dollars per day on
  current vision pricing. The cost risk is re-analysing reposts, not the volume itself.
- The 3 GB droplet is the real constraint: media download, hashing and any local OCR compete with the
  web app and the hourly sync worker. Expect a separate DOT worker instance.

**Four design constraints:**

1. **Dedupe before you spend.** Those groups repost the same asset endlessly; perceptual-hash first,
   analyse once, or vision cost scales with reposts instead of information.
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
firing, geo compliance, naming lint, duplicate audiences); rejection/policy tracking. All of it runs
on DOT's own Meta data, so the boundary does not affect it — only priority does.

### F. Money + margin — *rejected*

### G. WatchTower reconciliation — *dropped, boundary violation*

WatchTower is a PetalPixel project. Retained here only so the idea is not re-proposed.

---

## 4. Candidate tracks

### H. Data already synced and never used

All DOT-internal. Each is small and independently shippable.

- **Dayparting** — 91k hourly rows across both timezone framings. Per-geo hour-of-day
  recommendations, and "your budget burns out before the peak hour" alerts.
- **Frequency / saturation curves** — 15,220 `frequency_value` rows + reach. When to refresh the
  *audience* rather than the creative — a different question from creative fatigue.
- **Attribution-window intelligence** — `actions_by_window` splits every conversion 1d/7d/28d
  view+click. Almost nobody looks at it; it reveals which creatives win on view-through versus click,
  and how much of a "win" is attribution artefact. Also a direct input to Track A's frozen-period
  policy.
- **Depositor value, not registrations** — `action_values` + `purchase_roas` + windows give
  depositor-value curves and early proxies for LTV. For iGaming, registrations are cheap and
  depositors are the business.
- **Audience overlap across accounts** — 60 custom audiences; detect our own accounts cannibalising
  each other. Meta's overlap tool does not work across many accounts.
- **Automated-rule management** — 45 `ad_rule` objects already synced. Central rule templates,
  version history, misfire detection.

### I. Creative localisation engine

DOT runs USA, Canada, Germany, Brazil, Romania and more. Take a proven creative and localise it —
language, currency, payment methods, local hooks/holidays — into a per-geo variant set. A far more
valuable generator use-case than "make me an ad", and it consumes Track B's winners directly.

### J. Policy and rejection archive

iGaming rejections are constant. A pre-submission linter (text-in-image ratio, prohibited claims,
age-gating, geo restrictions) plus an archive of what actually got rejected, so rejection history
becomes training data rather than lost tribal knowledge.

### K. Interface direction (a fork, not a feature)

- **Agent-first** — the chat agent already has tools, history and cost tracking. Give it write
  actions behind approval and it becomes the primary surface; dashboards become a fallback.
- **Telegram-first for buyers** — the team lives in Telegram, and MetaConsole already has its own bot
  token and delivery path in `alerts.ts`. A daily buyer digest (rotate these, scale those, three
  trending archetypes) may beat a web dashboard for the daily loop.
- **Dashboard-first** — the status quo.

### L. Breadth vs depth (a fork)

Google / TikTok / Kwai are the obvious next channels for this vertical. The ingestion shape
(structure + insights + breakdowns + attribution) generalises, but every current table and fieldset
is Meta-specific. Breadth multiplies surface area; depth (Tracks B, C/D) compounds on data nobody
else has. Not a decision to drift into.

### M. Productisation (speculative)

- **Benchmark index** — 37 months of iGaming Meta performance across many accounts, published as
  aggregate-only benchmarks (CPM/CTR/CPA by geo/month). Aggregate-only keeps client confidentiality
  defensible.
- **CPA underwriting** — knowing real CPA per geo lets you price on outcome instead of media-buying
  fees. A business-model change, not a feature.
- **White-label to other agencies** — creative intelligence is what peers would pay for. Needs the
  same multi-tenancy as Track A.
- **Prompt library with lineage** — every generated prompt linked back to the archetype that inspired
  it and forward to the performance it produced. The compounding record, and the only part of C/D
  that is genuinely hard to copy.

---

## 5. Cross-cutting prerequisites

| Prerequisite | Gates | Notes |
| --- | --- | --- |
| Multi-tenant identity + row-level scoping | A (decided), M | **Critical path.** Scope-as-argument, `client` role, invite-only client users (never self-signup), view-as-client, presentation aliases, no markup leakage. |
| Object storage + CDN | C/D | A real purchase (e.g. DO Spaces). The droplet has 108 GB free but only **3 GB RAM**, and there is no large-memory DOT box to offload to. |
| DOT Telegram account + session + worker | C/D | Must be built from scratch; no session may be reused. |
| Base44 read integration | C/D idea 9 | A backend function inside the Asset Library exposing asset metadata; external clients cannot use the service role. Needs Base44 edit access + the app id. |
| DOT publishing leg (Meta Ad Creative API) | C/D, if generated creatives are to reach Meta without manual steps | Otherwise the hand-off is manual via the Asset Library. |
| Similarity index | B (near-duplicate creatives), C/D | `pgvector` is **not available** on this Postgres 16.14 — only `pg_trgm` and `pgcrypto`. Needs `postgresql-16-pgvector` or another approach. |
| LLM/vision cost guardrails | C/D, agent work | The `finance.tsx` per-user cost tracking pattern already exists; hundreds of assets/day × vision calls is real money. |
| Data-trust surface | A | Freshness/completeness badge per client-facing report, from existing sync health + `mappingSyncedAt`. Prevents "your numbers don't match Meta". |
| Hosting review | A | A public client portal on a single 3 GB instance with no redundancy turns uptime into an SLA conversation. |

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
| 8 | Buyer digest via DOT's Telegram bot | K | B |
| 9 | Asset reconciliation (designed but never run) | C/D | `meta_objects` + Asset Library access |
| 10 | Prompt library with lineage | M | C/D |
| 11 | Divergence feed — Notion values that disagree with Meta (status, contracted geo vs delivery, contracted URL vs live ad) | A | — |
| 12 | Dayparting recommendations + pre-peak burnout alert | H | — |
| 13 | Audience saturation curves | H | — |
| 14 | Attribution-window intelligence | H | — |
| 15 | Depositor-value / early-LTV proxies | H | — |
| 16 | Cross-account audience overlap | H | — |
| 17 | Central automated-rule management | H | — |
| 18 | Creative localisation engine | I | B |
| 19 | Policy linter + rejection archive | J | — |
| 20 | Agent write-actions behind approval | K | — |
| 21 | Client-scoped AI chat | A | scope boundary + per-client cost cap |
| 22 | Client creative approve/reject loop | A | B, scope boundary |
| 23 | Self-serve scoped report builder | A | scope boundary |
| 24 | Client pacing view (contracted budget vs projected burn-out) | A | scope boundary |
| 25 | Presentation alias layer for accounts/campaigns | A | scope boundary |
| 26 | Finalised/frozen reporting periods + fixed client attribution window | A | — |
| 27 | Admin "view as client" mode | A | scope-as-argument |
| 28 | Multi-platform ingestion (Google/TikTok/Kwai) | L | strategic decision |
| 29 | **Blocked-spend signal** — configured vs deliverable budget per client: how much intended daily spend is stopped by disabled or unfunded accounts. `canDeliver()` already computes the input | E/H | — |
| 30 | **Prepaid top-up alert** — fire when a client's deliverable budget collapses while recent spend stays high (Slots.lv: 19 of 20 campaigns blocked, $7.5k/day recent spend against $1.6k of remaining capacity) | E | idea 29 |

Withdrawn: WatchTower status/budget reconciliation, provider survival scorecard, account survival
analysis, warm-up playbooks, spare-pool forecasting, field-ownership registry across systems, and
ad-comment sentiment as a Track B input — all required PetalPixel projects.

---

## 7. Open questions

1. **Base44 integration shape:** confirm DOT can add a backend function to the Asset Library app (it
   is DOT's own app, so this should be available) and confirm the app id in account settings.
2. **Track A:** which attribution window do client-facing numbers use, and are periods frozen once
   reported? `actions_by_window` means an unfrozen figure keeps moving for 28 days.
3. **Telegram group links** — pending, so real volume, repost rate, format and language mix can
   replace the 400–500/day estimate.
4. **C/D publishing:** manual hand-off of generated creatives, or build DOT's own Meta publishing
   leg?
5. **Interface direction** (Track K): does the daily buyer loop live in Telegram or the web app?
6. **Breadth vs depth** (Track L): more channels, or deeper on Meta?
7. **Hosting:** does a public client portal justify moving off a single 3 GB droplet?
