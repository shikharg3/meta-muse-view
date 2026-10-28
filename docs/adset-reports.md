# Daily ad-set reports to Telegram

Every morning the worker sends each configured client's previous day as a CSV, one row per ad set,
to a Telegram chat. Schedules are managed at `https://159.65.110.111/adset-reports`.

## Where it is reachable

Same rules as the CSV import (`docs/csv-import.md`): only on the hosts in `IMPORT_HOSTS` (the
droplet's bare IP), a 404 before auth anywhere else (`IP_ONLY_PATHS` in `src/server.ts`), every
server fn re-checks the host and requires an admin (`src/server/fns/adset-reports.ts`), and the
nginx vhost `deploy/159.65.110.111.conf` lets only the IP-only pages through. The fns are server fns,
not ops, on purpose: ops are also served on `/api/v1`, which would put them on the domains.

## What the CSV contains

`Date, Account, Campaign, Ad set, Ad set ID, Spend, Impressions, Clicks, CPC, CPM, CTR,
Registrations, Purchases`, sorted by spend, plus a `Total` row. UTF-8 with a BOM so Excel reads
non-ASCII names. The caption repeats the totals.

- Rows come from `insights_daily` at ad-set level for the client's effective accounts, scoped to its
  own campaigns on shared accounts (`ownedCampaignIds`), exactly like the Report Builder.
- Metrics resolve through the report catalog (`buildReport`), so they match the Report Builder:
  CPC = spend / clicks (all), CPM = spend / impressions × 1000, CTR = clicks / impressions as a
  percentage, Registrations and Purchases are the de-duplicated event families.
- Rows are keyed by **ad set ID**, not name. The Report Builder's "Ad set" breakdown groups by name,
  which would merge OneAgency's many ad sets called e.g. "Georgia - Static".
- Ad sets with no delivery that day are left out. A day with no delivery at all sends a one-line
  message instead of an empty file.
- Spend is in each account's currency; the caption formats it as USD like the rest of the app.

## When it sends

`src/sync/jobs/adset-reports.ts`, from the worker's 30s notification loop. A schedule reports the
Berlin day before the send and is due from its Berlin time (default 10:00 — insight dates are each
ad account's own day, and 10:00 is the earliest time a US west-coast day has closed). A worker that
was down at the mark sends when it comes back.

The reported day is claimed in `adset_report_schedules` (`run_date`) before the send. A failure
keeps `sent_at` null and is retried by the next ticks up to `MAX_ATTEMPTS` (5), after which the day
is given up and the page shows the error. A crash after Telegram accepted the file but before
`sent_at` was written re-sends it once. Nothing is claimed while the bot token is missing.

"Send …" on the page sends the latest day immediately without touching the claim.

## Telegram

Uses the alert bot (`TELEGRAM_BOT_TOKEN`). The target chat must have sent `/start` to the bot, or
the bot must be in the group; saving a schedule checks this with `getChat`. Chats that have messaged
the bot appear in the page's dropdown (`telegram_chats`); any id can be typed in.

## Schema

`deploy/ddl/2026-10-28-adset-reports.sql` (applied by hand): `adset_report_schedules`, one row per
client → chat schedule.
