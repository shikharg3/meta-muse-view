# Scheduled reports to Telegram

Build a report the way the Report Builder does — client or brands, campaigns, date range, columns,
breakdown, granularity, markup — preview it, and have it sent to a Telegram chat as a CSV on a
schedule. Managed at `https://159.65.110.111/scheduled-reports`.

## Where it is reachable

Same rules as the CSV import (`docs/csv-import.md`): only on the hosts in `IMPORT_HOSTS` (the
droplet's bare IP), a 404 before auth anywhere else (`IP_ONLY_PATHS` in `src/server.ts`), every
server fn re-checks the host and requires an admin (`src/server/fns/scheduled-reports.ts`), and the
nginx vhost `deploy/159.65.110.111.conf` lets only the IP-only pages through. The fns are server fns,
not ops, on purpose: ops are also served on `/api/v1`, which would put them on the domains.

## The builder

| Control       | Notes                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Template      | Seeds the builder from a Report Builder template (`report_templates`).                                                                |
| Client        | Any client on the Notion board.                                                                                                       |
| Brands        | The client's board-row titles. None picked = the whole client.                                                                        |
| Campaigns     | Campaigns in the client/brand scope, searchable, each labelled with its brand. None picked = all.                                     |
| Date range    | The Report Builder's 19 presets, or custom dates (preview and "Send once" only).                                                      |
| Columns       | The full report catalog via the Report Builder's column picker; order is column order. Metrics with no data in the window are dimmed. |
| Breakdown     | All 24 Report Builder dimensions.                                                                                                     |
| Granularity   | Whole range, daily, weekly, 4-weekly, monthly.                                                                                        |
| Markup        | Inflates spend and cost metrics, as in the Report Builder.                                                                            |
| Data modeling | Replaces interrupted days with an estimate of uninterrupted delivery — see [Modeled reports](#modeled-reports).                       |

The preview is the CSV: sortable columns, totals row, CSV and PDF downloads in the on-screen order.
"Send once now" sends the current builder to the chosen chat without saving it.

Delivery: schedule name, Telegram chat (chats that messaged the bot, or any id), repeat (every day,
weekdays, weekly on a weekday, monthly on day 1–28) and Berlin time. Choosing a repeat offers its
natural range (daily → Yesterday, weekly → Last week, monthly → Last month). A schedule must use a
relative range: it is resolved against the Berlin date of each send.

## What the CSV contains

Metrics resolve through the report engine (`buildReport`), so figures match the Report Builder. Two
differences, both because the result is a file worked with in a spreadsheet:

- **Campaign, ad set and ad breakdowns are keyed by ID, not name**, with Account / Campaign /
  Ad set context columns and the ID. The Report Builder groups these by name, which folds
  OneAgency's 31 ad sets called "Georgia - Static" into one row. Rows run in date order, biggest
  spend first.
- **A client with several brands gets a Brand column** on those breakdowns, unless one brand is
  picked.

UTF-8 with a BOM so Excel reads non-ASCII names. Up to 20,000 rows (`FILE_MAX_ROWS`); a cut is stated
in the report's note. A window with no delivery sends a one-line message instead of an empty file.

## Brands

A brand is a Notion board-row title under the client (`src/server/report-scope.ts`). Rows with the same
title are one brand — successive engagements re-list it — and its accounts are the union of theirs,
minus accounts removed from the client. Accounts added by hand that no row lists form "Other
accounts (no board row)".

A campaign belongs to a brand when only that brand lists its account. On an account several brands
list, the campaign name decides (`attributeCampaign`, the rule the Notion budget job applies per row);
a name matching none or several is in no brand, so it appears in a whole-client report but in no
brand report, rather than in two. Client-level ownership (`ownedCampaignIds`) applies first.

## When it sends

`src/sync/jobs/telegram-reports.ts`, from the worker's 30s notification loop. A schedule is due on
its days from its Berlin time (default 10:00 — insight dates are each ad account's own day, and 10:00
is the earliest a US west-coast "yesterday" has closed). A worker that was down at the mark sends
when it comes back.

The Berlin send date is claimed in `telegram_report_schedules.run_date` before the run. A failure
keeps `sent_at` null and is retried by the next ticks up to `MAX_ATTEMPTS` (5), after which the day is
given up and the page shows the error. A crash after Telegram accepted the file but before `sent_at`
was written re-sends it once. Nothing is claimed while the bot token is missing. "Send now" on a
schedule sends immediately without touching the claim.

Meta-dimension breakdowns (country, placement, age, …) refresh on the daily full sync, so a 10:00
send for yesterday can find no rows yet; the message says so.

## Telegram

Uses the alert bot (`TELEGRAM_BOT_TOKEN`). The target chat must have sent `/start` to the bot, or the
bot must be in the group; saving and "Send once" check this with `getChat`.

## Modeled reports

For estimating how a campaign would have performed had delivery not been interrupted. Actual
figures reach clients through DOT Analytics; a modeled report is an estimate and is labelled as
one: "(modeled)" in the title and file name, a note — also in the Telegram caption — listing every
modeled day with its actual spend and the median it was judged against, and on daily rows a
Modeled column (`yes` on modeled days).

Rules (`src/server/modeling.ts`, defaults in `MODELING_DEFAULTS`):

- A day is judged on the whole report scope's spend (client, brands and campaigns as picked). It is
  **interrupted** when spend is zero or under **25%** of the median spend of its reference days.
- **Reference days** are the active days within **±5 days**. When no later day has data yet — a
  "Yesterday" report — they are the active days in the **previous 7**. Low days are never
  references, so neighbouring dead days are modeled from live ones, not from each other.
- Each report entity (campaign, ad set, ad, country, …) on an interrupted day becomes the mean of
  its reference days (a day it did not run counts as zero) times a factor in **[0.85, 1.15]**,
  independent per metric. The factor is seeded by day, entity and metric, so a report always shows
  the same estimate; one action array (all conversion types) shares one factor, so synonymous types
  stay equal. Counts are whole numbers, money keeps cents.
- Days before the first delivery within reach are not interruptions (the campaign had not
  started). A day with fewer than 2 active reference days is left actual and named in the note.
- Because the variance is drawn per entity, the same window's modeled total differs slightly
  between breakdowns (e.g. by campaign vs by country).

## Schema

`telegram_report_schedules`, one row per schedule, holding the recipe and the delivery. DDL, applied
by hand in order: `deploy/ddl/2026-10-28-adset-reports.sql`,
`deploy/ddl/2026-10-28-scheduled-reports.sql`, `deploy/ddl/2026-10-28-report-modeling.sql`.
