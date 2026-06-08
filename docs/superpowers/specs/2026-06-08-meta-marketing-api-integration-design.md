# Meta Marketing API Integration — Design Spec

**Date:** 2026-06-08
**Status:** Proposed (awaiting user review)
**Repo:** `meta-muse-view` (TanStack Start dashboard, currently UI-only with mock data)

---

## 1. Goal

Turn the existing MetaConsole dashboard (UI + seeded mock data) into a real internal
analytics tool that reports live Meta Ads performance for **1 Business Manager and 50+ ad
accounts**, read-only, authenticated by a **system user token**, with data served fast from a
local Postgres database that a scheduled worker keeps in sync with the Meta Marketing API.

## 2. Context

- Frontend is built and working: TanStack Start (SSR via Nitro) + React 19 + Vite + Bun +
  Tailwind v4 + shadcn/ui + TanStack Query + recharts. Seven routes: Overview, Accounts,
  Account detail, Campaigns explorer, Creatives, Audiences, Settings.
- All screens read from `src/lib/mock-data.ts`, which exports deterministic seeded data and is
  marked with a "SWAP POINT" comment for real API integration.
- Two known defects in the current UI, both fixed as part of this work (they block the detail page):
  - `/accounts/$id` never renders its component — `accounts.tsx` is the parent layout of
    `accounts.$id.tsx` (see `routeTree.gen.ts`) but has no `<Outlet/>`. Fix: rename
    `accounts.tsx` → `accounts.index.tsx` so list and detail are sibling leaves.
  - `accounts.$id.tsx:36` — `Route.useLoaderData()` types as `undefined` (resolves once the
    route nesting above is corrected).

## 3. Goals / Non-goals

**Goals**
- Server-side sync of Meta structure + insights into Postgres, rate-limit aware.
- Dashboard reads exclusively from Postgres (never calls Meta on a page load).
- Credential management on the Settings page (enter/update Meta app id/secret, system user token, BM id, account ids) plus token-health; secrets encrypted at rest.
- nginx HTTP Basic Auth in front of the deployed app.
- Match the data shapes the components already consume so the UI barely changes.

**Non-goals (YAGNI)**
- No ad management / writes (read-only: `ads_read` + `business_management`).
- No multi-BM support (1 BM).
- No per-user accounts/RBAC in the app (single shared Basic Auth credential).
- No real-time streaming; scheduled batch sync is sufficient (Meta insights are not real-time).
- No data warehouse / external analytics stack; single Postgres on the droplet.

## 4. Architecture

```
                 hourly / nightly cron (node-cron)
                              │
   Meta Marketing API ◀───────┤  src/sync/worker.ts  (standalone `bun run sync`, systemd/pm2)
   (graph.facebook.com/v25.0) │   - structure refresh
                              └──▶ Postgres  (structure + insights facts)
                                      ▲
                                      │ read-only
        Browser ──▶ nginx (Basic Auth) ──▶ TanStack Start (SSR) ──▶ src/server/fns/* ──▶ Postgres
```

- **Sync worker** is a separate long-running process from the web server: decoupled failure
  domains, independent restarts, no contention with SSR. It owns all Meta API calls.
- **Web app** reads Postgres via `createServerFn` handlers and hosts the Settings page that writes credentials (encrypted) to Postgres. Secrets stay server-only and are never returned to the browser; the worker reads credentials from Postgres.

## 5. Tech choices & rationale

| Decision | Choice | Why |
|---|---|---|
| Datastore | **Postgres 16** (native apt, on the droplet) | Relational facts + JSONB for nested `actions`; concurrent worker-write / app-read; strong aggregation. |
| DB access | **Drizzle ORM** | TS-native, SQL-first, type-safe, first-class Bun + Postgres, real migrations. Lighter than Prisma. |
| Meta client | **Thin typed `fetch` wrapper** (not `facebook-nodejs-business-sdk`) | SDK is heavy, lags versions, and hides the rate-limit headers we must read. ~200 LOC: version pin, `appsecret_proof`, header parsing, backoff, async-job polling, cursor pagination. |
| Scheduler | **node-cron inside the standalone worker** | One process to manage under systemd/pm2; no external queue needed at this scale. |
| Dashboard auth | **nginx HTTP Basic Auth** | Real protection, zero app code; standard nginx + Let's Encrypt on the droplet. |
| Secrets at rest | **AES-256-GCM in Postgres**, key in `APP_ENCRYPTION_KEY` (env) | Credentials entered via the Settings UI; a DB dump alone can't leak the token. |
| API version | **`v25.0`**, pinned | Current (Feb 2026). Meta auto-upgrades versions after ~2 years; pin to avoid surprise breaks. |

## 6. Meta Marketing API reference (grounded against v25.0 docs)

So the implementer does not need to re-research:

### 6.1 Auth & access (Phase 0 — human setup)
- Create a Meta **App** (type: Business) at developers.facebook.com.
- In Business Manager → Business Settings → Users → **System Users**, create an Admin system
  user; generate a token against the app with scopes **`ads_read`** + **`business_management`**
  (add `read_insights`). `ads_management` only if we ever write (we don't).
- **Assign assets:** grant the system user access to each ad account (or all of the BM's).
- **Token lifetime:** system user tokens **never expire by time**, but are invalidated by the
  admin's FB password change, app-secret reset, or app deauthorization → monitor health.
- **Access tier:** the 9,000-point rate limit requires **Standard Access to "Ads Management
  Standard Access," which requires App Review.** Dev tier = 60 points/300s (insufficient for 50
  accounts). Phase 0 must complete App Review (or operate degraded until it clears).
- Use `appsecret_proof` (HMAC-SHA256 of token with app secret) on all server calls.

### 6.2 Entity hierarchy / structure endpoints
`Business → Ad Accounts → Campaigns → Ad Sets → Ads → Ad Creatives`
- `GET /{business_id}/owned_ad_accounts` (+ `client_ad_accounts`) — enumerate accounts.
- `GET /act_{id}/campaigns | /adsets | /ads | /adcreatives`.
- Structure fields: `id, name, status, effective_status, objective, daily_budget,
  lifetime_budget, bid_strategy, created_time, updated_time`; creative: `thumbnail_url,
  object_story_spec, image_url, video_id`.

### 6.3 Insights API (the stats) — `GET /{object}/insights`
- `object` = `act_{id}` | campaign | adset | ad; `level` param = `account|campaign|adset|ad`.
- Field families (70+ total):
  - Delivery: `impressions, reach, frequency, spend`
  - Clicks: `clicks, inline_link_clicks, unique_clicks, ctr, inline_link_click_ctr, cpc`
  - Cost: `cpm, cpp, cost_per_action_type`
  - Conversions/ROAS: `actions, action_values, conversions, conversion_values, purchase_roas,
    website_purchase_roas` — **arrays of `{action_type, value}`; must be flattened.**
  - Video: `video_play_actions, video_p25/50/75/100_watched_actions, video_thruplay_watched_actions`
  - Quality: `quality_ranking, engagement_rate_ranking, conversion_rate_ranking`
  - IDs: `account_id/name, campaign_id/name, adset_id/name, ad_id/name, objective, date_start, date_stop`

### 6.4 Time & attribution
- `date_preset` (`last_7d, last_14d, last_28d, last_30d, last_90d, this_month, maximum`, …) **or**
  `time_range={since,until}` (YYYY-MM-DD).
- `time_increment=1` → daily rows (drives trend charts / sparklines).
- `use_unified_attribution_setting` (default `7d_click` + `1d_view`; **`7d_view`/`28d_view`
  removed Jan 12 2026**).

### 6.5 Breakdowns (segmentation)
- Standard: `age, gender, country, region, dma, publisher_platform, platform_position,
  impression_device, device_platform, product_id, hourly_stats_aggregated_by_advertiser_time_zone`.
- `action_breakdowns`: `action_type` (default), `action_device, action_destination,
  action_reaction, action_canvas_component_name, action_carousel_card_id/name`.
- **Combining rules (gotcha):** only a limited valid matrix (e.g. `publisher_platform +
  platform_position + impression_device` ✅; `age + gender` ✅). Hourly cannot combine with
  `reach`/`frequency`/`unique_*`. `reach` with age/gender/country limited to last **13 months**.
  `impression_device` + hourly have **Aug 6 2026 availability notices** (may need async jobs).
  Unsupported combos return a generic error → validate against the known-good set.

### 6.6 Filters & controls
- `filtering`: `[{field, operator, value}]` — `EQUAL, NOT_EQUAL, GREATER_THAN, IN, CONTAIN`, …
- Cursor pagination (`after`); **batch** (≤50 sub-requests); **async report jobs**
  (`POST` → poll `report_run.async_status` → fetch) for heavy/historical pulls (up to ~1h).

### 6.7 Rate limits (shape the sync)
- Business-Use-Case, **per ad account per use-case**; read = 1pt, write = 3pt; dev 60 / standard 9,000.
- Headers to read every response: `X-Business-Use-Case-Usage` (throttle as `total_time` /
  `total_cputime` → 100), `X-FB-Ads-Insights-Throttle` (`app_id_util_pct`, `acc_id_util_pct`,
  `ads_api_access_tier`), `x-ad-account-usage`. Exceed → HTTP 429.
- → pace sequentially per account, back off on header pressure, async-job heavy pulls, never
  fan out all 50 simultaneously.

## 7. Data model (Postgres / Drizzle)

Structure tables (latest snapshot, upserted):
- `accounts(id PK, name, currency, status, effective_status, raw jsonb, synced_at)`
- `campaigns(id PK, account_id FK, name, status, effective_status, objective, daily_budget, raw, synced_at)`
- `ad_sets(id PK, campaign_id FK, name, status, effective_status, audience, raw, synced_at)`
- `ads(id PK, ad_set_id FK, name, status, effective_status, creative_id FK, raw, synced_at)`
- `ad_creatives(id PK, name, thumbnail_url, format, object_story_spec jsonb, synced_at)`

Fact tables (daily, idempotent upsert on the composite key):
- `insights_daily(level, entity_id, date, account_id, spend, impressions, reach, frequency,
  clicks, inline_link_clicks, ctr, cpc, cpm, conversions, conversion_values, purchase_roas,
  actions jsonb, action_values jsonb, synced_at, PK(level, entity_id, date))`
- `insights_breakdown_daily(entity_id, level, date, breakdown_type, breakdown_value, spend,
  impressions, clicks, conversions, conversion_values, synced_at,
  PK(level, entity_id, date, breakdown_type, breakdown_value))`

Operational tables:
- `sync_state(account_id PK, last_structure_sync, last_insights_sync, cursor, status, last_error)`
- `meta_credentials(id PK='singleton', app_id, app_secret_enc, system_user_token_enc, business_id, account_ids text[], api_version, updated_at)` — secrets AES-256-GCM encrypted; managed via the Settings page.
- `token_health(id PK='singleton', checked_at, is_valid, scopes jsonb, note)`

Rationale: raw `actions`/`action_values` JSONB preserved so new conversion metrics can be derived
later without re-fetching; daily grain supports trends + arbitrary date-range aggregation in SQL.

## 8. Sync strategy

Standalone worker (`bun run sync`) with node-cron:
- **Hourly:** structure refresh (cheap) + `time_increment=1` insights for **trailing 3 days** at
  account → campaign → adset → ad. Idempotent upsert (re-pulling trailing days captures
  attribution backfill).
- **Nightly:** breakdowns (age, gender, publisher_platform, device_platform/impression_device,
  country) for trailing 7 days; deeper backfill window for history.
- **First run / backfill:** async report jobs over `maximum` or a bounded window per account,
  sequentially.
- **Rate-limit handling:** sequential per-account with pacing; parse usage headers; exponential
  backoff + jitter on throttle/429; switch to async jobs when synchronous pulls are too heavy.
- **Idempotency:** all writes are upserts keyed on the composite PKs above; a re-run of any
  window is safe.

## 9. Meta client design (`src/meta/`)

- `client.ts` — `metaGet(path, params)` / `metaPost`; injects version, token, `appsecret_proof`;
  parses rate-limit headers into a typed `Usage`; cursor auto-pagination; backoff/retry.
- `insights.ts` — typed insights query builder + **action-array flattening** helpers
  (`actions[]` → named metric columns, e.g. `omni_purchase`, `offsite_conversion.fb_pixel_purchase`).
- `rate-limit.ts` — header parsing + a pacing/backoff governor.
- `types.ts` — request/response types mirroring §6 fields.

## 10. Frontend wiring (`src/server/fns/`)

- Server functions return the **exact shapes components already consume** (`AdAccount`,
  `Campaign`, breakdown arrays). UI components change minimally.
- Route loaders call server fns via TanStack Query; aggregation (Overview KPIs, account ROAS)
  done in SQL / server fn, mirroring `aggregate()` in `mock-data.ts`.
- Delete `src/lib/mock-data.ts` at the end (the SWAP POINT).
- Fix `/accounts/$id` routing (rename to `accounts.index.tsx`) and the `useLoaderData` type error.
- Settings page **manages credentials** (form to enter/update app id/secret, system user token, BM id, account ids — secrets write-only & masked) with a "Test connection" action (`debug_token`), and shows token health + sync cadence.

## 11. Ops / deploy (DigitalOcean droplet)

- Postgres 16 native (apt) on the droplet, localhost-only; reached in dev via SSH tunnel.
- Web: `bun run build` → Node/Nitro server under systemd/pm2.
- Worker: `bun run sync` under systemd/pm2 (separate unit).
- nginx subdomain + Let's Encrypt on the droplet, with **HTTP Basic Auth**
  (`auth_basic` + htpasswd).
- Only `DATABASE_URL` + `APP_ENCRYPTION_KEY` live in env / systemd `EnvironmentFile`. Meta credentials are stored encrypted in Postgres (managed via Settings), with optional env bootstrap. Secrets never reach the client.

## 12. Testing strategy

- **Meta client (unit):** recorded-fixture tests for header parsing, action-array flattening,
  cursor pagination, backoff decisions. No live calls.
- **Sync jobs (integration):** throwaway Postgres; assert upsert idempotency and that re-pulling
  a trailing window does not duplicate or drift.
- **Server fns (integration):** seed DB rows, assert aggregation math (e.g. account
  `roas = Σrevenue / Σspend`, `ctr = Σclicks / Σimpressions`).
- **End-to-end smoke:** run real sync against **one** account before enabling all 50; verify the
  dashboard renders DB-backed data with no console errors (browser check, as in setup).

## 13. Decomposition into implementation plans

- **Plan A — Ingestion pipeline:** Drizzle schema + migrations, Meta client, sync worker, run
  against one live account. Ships independently testable.
- **Plan B — Frontend wiring:** server fns, route loaders, routing/type-error fix, Settings token
  health, delete mock-data, deploy (Postgres + worker + nginx Basic Auth). Depends on A.

Phase 0 (Meta app + system user + App Review + env) is a prerequisites checklist preceding Plan A.

## 14. Open questions / risks

- **App Review latency:** Standard Access approval is not instant; until it clears we run on dev
  tier (60 pts) — sync must degrade gracefully (fewer accounts/cycle, async jobs).
- **Breakdown combination matrix** is under-documented; we validate against the known-good set in §6.5
  and treat generic errors as "unsupported combo," skipping rather than failing the cycle.
- **Conversion metric mapping:** which `action_type` is "the" conversion/revenue varies per
  account/objective; we store raw JSONB and pick a sensible default (e.g. `omni_purchase` /
  `purchase_roas`), revisable without re-fetch.
