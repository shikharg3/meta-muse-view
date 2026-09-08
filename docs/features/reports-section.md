# Reports section

The Reports section is where the team builds client-ready CSV and PDF reports from the Meta Ads data
MetaConsole already syncs. It replaces the old one-shot form: you can now save a recipe as a
template, re-run it, preview the result in the browser, export it, and later look up exactly what a
client received and when. It is for anyone who sends numbers to a client — media buyers, account
managers and the two operators.

## The problem

The previous `/reports` page was a single form. You picked a client, a range, a few columns and a
breakdown, it rendered a table, you downloaded a file, and every choice was gone the moment you
navigated away. Three things followed from that:

- A recurring report was rebuilt from scratch every time, and two people rebuilt it differently.
- Nothing recorded what was sent to whom. "What did we tell them in March?" had no answer.
- The column list was 22 hand-maintained entries, while the synced data holds far more.

There was also a correctness problem. The old builder had a "Split by day" checkbox, which can only
express two of the five row granularities Meta actually offers, and metrics Meta de-duplicates (such
as Reach) were summed across days, which double-counts anyone who appears on more than one day.

## What it does

- **One report engine, parameterised.** There is no fixed list of report types. A report is a
  client + a date range + a set of columns + one breakdown dimension + one time granularity, with an
  optional campaign filter and an optional client markup.
- **112 metric columns** in eight groups, all read from data already in Postgres
  (`src/lib/report-catalog.ts`). The picker hides metrics that hold no data for the client and window
  you chose.
- **24 breakdown choices** (no breakdown, plus 23 dimensions) crossed with **5 time granularities**.
- **19 named date presets** plus an explicit custom `since`/`until` pair.
- **Saved templates** — a recipe (columns and their order, breakdown, granularity, range preset,
  markup), optionally bound to one client.
- **An export ledger.** Every generated report is stored; the moment you export it, the run is
  stamped as delivered and its numbers are frozen exactly as the client received them.
- **CSV and PDF only.** Those are the two formats that exist; the PDF is DOT-branded and generated
  in the browser with `jspdf` + `jspdf-autotable` (`src/lib/report-export.ts`). There is no XLSX
  export and no emailed or scheduled delivery.

### Breakdowns — what question each answers

The breakdown decides what one row *is*. Keys and labels are from `src/lib/report-options.ts`; where
the rows come from is in `REPORT_DIMS` (`src/server/agent/report.ts`).

| Label in the picker | Answers |
| --- | --- |
| Total (no breakdown) | What did this client do overall in this window? |
| By campaign | Which campaigns spent, and what did each return? |
| By ad set | Which audiences/ad sets carried the result? |
| By ad | Which ads carried the result? |
| By platform | Which publisher platform delivered (Meta's `publisher_platform`). |
| By placement (platform · position · device) | Which exact placement worked. |
| By device platform | Which device platform delivered (Meta's `device_platform`). |
| By age | Which age bands responded. |
| By gender | Which genders responded. |
| By age · gender | The two crossed. |
| By country | Which countries the money went to. |
| By region | Which regions/states within a country. |
| By market (DMA) | US designated market areas. |
| By hour (account time) | Time of day in the ad account's timezone. |
| By hour (audience time) | Time of day where the audience is. |
| By frequency | Performance at each frequency value. |
| By product | Catalogue product performance. |
| By image asset | Which image performed, in dynamic creative. |
| By video asset | Which video performed. |
| By headline asset | Which headline performed. |
| By body text asset | Which primary text performed. |
| By CTA asset | Which call-to-action button performed. |
| By description asset | Which description performed. |
| By link URL asset | Which destination URL performed. |

The six asset breakdowns are only available at ad level; the engine queries them there automatically
(`adLevel` in `REPORT_DIMS`).

### Time granularity — what `time_increment` does

This is a separate control from the breakdown, because in Meta's Insights API they are two
independent axes. It replaced the old "Split by day" boolean, which could not express weekly,
4-weekly or monthly rows (`src/lib/time-increment.ts`, and the migration note at the top of
`src/server/fns/reports.ts`).

| Picker label | Stored value | One row means |
| --- | --- | --- |
| Whole range | `all_days` | One row per breakdown value across the whole window (the default). |
| Daily | `1` | One row per day. |
| Weekly | `7` | 7-day buckets counted from the range start — not calendar weeks. |
| 4-weekly | `28` | 28-day buckets counted from the range start. |
| Monthly | `monthly` | Calendar months, clipped at both ends of your range. |

Buckets anchor on your `since` date: `since=2026-08-02` with Weekly gives 08-02..08-08, 08-09..08-15
and so on, while `since=2026-08-05` gives 08-05..08-11. The last bucket is clipped by `until`.

## Where to find it

- **Sidebar → Reports** (`/reports`). Three tabs: **History** (the default), **New report**,
  **Templates**.
- **Clients → any client → "Export report"** opens the same builder inline, locked to that client.
  Reports built there are **not** recorded in the ledger — that page calls the engine directly
  (`generateClientReport`) and never creates a run row, so its CSV/PDF downloads never appear in
  History.
- **The AI assistant cannot build files.** It is instructed to say so and point you at
  Reports → New report (`src/server/agent/chat.ts`).

Everything under `/reports` requires an **approved** account, and nothing more: every server
function in `src/server/fns/reports.ts` starts with `requireApproved()`. A pending or rejected
account gets `Forbidden: approved access required.`

Every role — `member`, `admin`, `superadmin` — gets the whole section: history, the builder, the
commission field, and template create / edit / delete. **A `member` is staff, not a client.** The
only boundary the markup rule draws is staff vs client (see "The markup rule" below), which is why
there is no per-role gating inside here.

## How it works

**Building.** Reports → New report is a config rail on the left and a live preview on the right. On
submit the browser calls `startReportRun`, which resolves your date range, runs the engine against
**our own synced Postgres rows** (never a live Meta call, so disabled or out-of-Business-Manager
accounts still report), and writes a `report_runs` row with `exported_at = NULL` — a draft.

**Ownership scoping is automatic.** The engine resolves the client's ad accounts, then narrows to the
campaigns that actually belong to that client (`ownedCampaignIds`, `src/server/fns/campaign-attribution.ts`).
Ad accounts get shared and recycled between clients, so account-level attribution alone would show one
client another's spend. First match wins:

1. a manual override an operator set on the campaign,
2. brand-name attribution, when several current clients claim the same account,
3. the single client that designates the account as its Notion "Active Account ID",
4. nobody — an unattributed campaign counts for no client and appears in no report.

If you also tick specific campaigns in the builder, that selection is intersected with the owned set;
you can never widen a report past what the client owns.

**Exporting.** Clicking CSV or PDF downloads the file and calls `stampReportExport`, which sets
`exported_at` to now (only the first time) and appends the format to `exported_formats`. Re-exporting
the same run later adds the format but does **not** re-date the row, so a March report re-downloaded
in May is still filed under March. Opening an archived run at `/reports/<run id>` and downloading it
again does not stamp anything at all.

**History** lists exported runs only, newest first, up to 100 (`fetchReportRuns`). A draft nobody
exported is not a delivery and does not belong in the ledger.

**Retention.** Never-exported drafts older than **7 days** are deleted
(`DRAFT_RETENTION_DAYS`, `src/server/fns/reports.ts`). The delete runs in the `meta-sync` worker,
piggy-backed on the once-per-day full sync — which fires on the first hourly tick after **00:00 UTC**
(`src/sync/worker.ts`). Exported runs are kept indefinitely, payload and all.

**Freshness of the underlying data.** The hourly sync refreshes only the 12 CORE metrics over a
trailing 28 days; the full 219-metric set and the Meta-dimension breakdowns refresh once a day on the
full pass (`src/sync/cycle.ts`). So a brand-new window can have campaign data but no
platform/placement/age data yet, and the engine says so explicitly instead of reporting "no data".

## What you need to do

1. **Pick a client.** The picker lists clients still on the Notion board; clients that dropped off
   the board are retained for history but never offered.
2. **Optionally narrow campaigns.** Campaign chips appear once a client is selected, with **All** /
   **None** shortcuts. All selected (or none selected) means every campaign the client owns.
3. **Pick a date range.** 19 presets grouped Relative / Calendar / All time, or Custom. Relative
   ranges end **yesterday** — today is partial and Meta keeps restating the last ~28 days, so
   including today would make a figure move under the client's feet (`src/lib/date-presets.ts`).
4. **Pick columns.** Default is Spend, Impressions, CTR, CPC, Results. In the dialog, the left pane
   is the searchable catalog by group, the right pane is **Column order** — drag rows or use the
   arrows. That order is the report's column order.
5. **Pick a breakdown and a granularity.**
6. **Set Client markup %** if this report is going to a client at a marked-up rate. Leave it at 0
   (blank) otherwise.
7. **Generate report**, read the preview, then **CSV** or **PDF**.

If you do nothing after generating, nothing is delivered and nothing is recorded: the run stays a
draft, never appears in History, and is deleted after seven days.

**Templates** are optional. Reports → Templates → **New template** saves name, client binding
(or "Generic — choose a client each run"), columns and order, breakdown, granularity, range preset
(or "Ask each run") and markup. The ▶ action opens `/reports/new?template=<id>` with everything
pre-filled; you still choose the window if the template has no preset. Deleting a template asks for a
second click ("Confirm?") and does not touch history — past runs simply show **Ad hoc** in the
Template column.

## Reading the output

**The preview card** shows `<Client> — performance report`, the subtitle `since → until` plus the
axes, and the row count. Below it, the table; the date/dimension column stays pinned while metric
columns scroll.

**Columns you will see, in this order:**

| Column | When it appears | Contents |
| --- | --- | --- |
| Date | Granularity = Daily | The day. |
| Period | Any other granularity except Whole range | `start → end` of the bucket. |
| (breakdown label) | Any breakdown except Total | Campaign name, country, placement, and so on. |
| your metric columns | always | In the order you picked them. |
| **Total** row | when there is a Date/Period or breakdown column | Totals across every bucket, including ones past the 500-row cap. |

**An em dash (—) in a metric cell is not zero.** Reach, Unique Clicks, Full-View Reach, Unique Inline
Link Clicks and Unique Outbound Clicks are counts of distinct *people*, which Meta de-duplicates per
row. Where a report row folds in more than one of Meta's own rows, the true figure is not recoverable
by any arithmetic, so the cell is withheld rather than summed (`DEDUPED_BY_META` in
`src/lib/report-catalog.ts`). Derived metrics inherit this — Frequency is Impressions ÷ Reach, so it
is withheld wherever Reach is. The grey note line under the header says which columns were withheld
and why. To get them exactly, run **Daily** on a single-account client.

**The note line** also tells you when only some of a client's accounts had data, e.g.
`3 of 5 accounts have data in this range.`

**Filenames** are `<client>_<since>_<until>[_by_<breakdown>][_daily|_weekly|_28d|_monthly]`, plus
`.csv` or `.pdf`.

**The PDF** carries the DOT logo band, the title, the range, the note, up to four headline figures
taken from the report's own first four metric columns, up to two bar charts (only for summable
columns — a chart of averages beside a totals row would mislead), then the full table. It switches to
landscape above 6 columns.

**The CSV** has the column labels as its header row, plain rounded numbers with no currency symbols
so a spreadsheet can total them, and the totals row last.

**History columns:** Client · Range · Rows · Markup · Exported · Formats · By · Template. Click a
client name to open the frozen run.

**A frozen run** (`/reports/<run id>`) shows Exported, Run by, Template and the stored table. The
stored payload carries its own columns, so an archived report can never drift when the catalog
changes; if a metric has since been retired you get a line saying how many of its columns are no
longer in the catalog.

## Setup and configuration

There is nothing to install or switch on. Points worth knowing:

| Thing | Where it lives | Default |
| --- | --- | --- |
| Access | `requireApproved()` in `src/server/fns/reports.ts` | any approved account, every role |
| Templates | `report_templates` table | none; you create them |
| Runs and exports | `report_runs` table | one row per generated report |
| Draft retention | `DRAFT_RETENTION_DAYS` | 7 days |
| History page size | `fetchReportRuns` limit | 100 most recent exported runs |
| Row cap per report | `MAX_ROWS` in `src/server/agent/report.ts` | 500 rows |
| Default columns | `DEFAULT_REPORT_COLUMN_KEYS` | Spend, Impressions, CTR, CPC, Results |
| Default granularity | `DEFAULT_TIME_INCREMENT` | Whole range (`all_days`) |
| Default range in the builder | `ReportBuilder` | Last 7 days |
| Markup | per template and per run | 0 (no markup) |

### The markup rule — internal only

Read this once and do not work around it.

- You enter a whole percent (0–100) in **Client markup %**. It is stored as a fraction: 15 becomes
  `0.15`.
- It **inflates spend** before any cost metric is computed, so CPC, CPM, Cost / Result and every
  other cost-per rise, and ROAS falls. Delivered figures — impressions, clicks, reach, results,
  revenue — are real and untouched (`buildReport`, `src/server/agent/report.ts`).
- Cost and ratio metrics are always *derived from spend*, never read from Meta's precomputed fields,
  precisely so a marked-up report cannot print an un-inflated cost beside inflated spend
  (`src/lib/report-catalog.ts`).

**The rate itself is internal and must never reach the client.** In the shipped code it is visible in
exactly three places, all of them staff-only surfaces:

1. the chip on the internal report card, reading e.g. `+15% markup · internal`;
2. the **Markup** column of the History table, reading e.g. `+15%`;
3. the stored `params` of the run in the database.

It is **not** in the CSV, **not** on the PDF, and **not** in the PDF's document properties. The type
the CSV and PDF render from (`ReportDoc`) has no markup field at all, so an export cannot print the
rate even by mistake, and `clientSubtitle()` additionally strips any `incl. N% markup` text from the
subtitle before it is drawn or written into the file's metadata (`src/lib/report-export.ts`). The
client portal is fed figures that already include the markup and never receives the rate.

Practical consequence: never paste a screenshot of the report card, or of the History table, into a
client-facing channel. Send the exported file.

## When something looks wrong

| Symptom | Cause | What to do |
| --- | --- | --- |
| `No data for "<client>" in <since> → <until>.` | No synced rows for those accounts in that window. | Widen the range, or check the client's accounts are mapped and syncing (Settings / Activity). |
| `"<client>" HAS data … but the "<breakdown>" breakdown hasn't been synced for that window yet` | Meta-dimension breakdowns only refresh on the daily full sync. | Re-run with no breakdown, or by day / campaign / ad set / ad — those never lag — or retry after the next full sync. |
| `No ad accounts are mapped to "<client>".` | The client has no `act_…` accounts on the Notion board. | Fix the mapping on the board, or ask an operator. |
| `Pick a valid date range.` / `Select at least one column.` / `Unknown client.` | Incomplete builder input. | Fill the missing field. Custom ranges need both dates. |
| `Forbidden: approved access required.` | Your account is not approved yet. | Ask an admin to approve it. |
| A metric column is all zeros for recent days but has data further back | The hourly refresh writes only the 12 CORE metrics and overwrites the other promoted columns for the trailing 28 days; the daily full pass restores them. Known, unfixed, sync-side (`src/sync/jobs/insights.ts`). | Wait for the next daily full sync, or use the columns the picker offers — the availability filter already hides most affected metrics. |
| Em dashes where you expected Reach | Withheld de-duplicated metric — see "Reading the output". | Switch granularity to Daily, or accept the totals row figure only for a single-day/single-account bucket. |
| A campaign you expected is missing | It is owned by another client, or unattributed. | Set a campaign override on the client page, then re-run. |
| The report shows fewer rows than expected, and exactly 500 | The 500-row cap. | Narrow the breakdown, the campaign set or the range. Note the totals row still covers everything. |
| A report you sent is not in History | It was built from the client page (not recorded), or it was never exported. | Rebuild it under Reports → New report and export from there. |
| A draft you meant to keep has vanished | Drafts are deleted after 7 days. | Re-run it; templates exist so the recipe is not lost. |
| PDF is unreadable, columns crushed | Too many columns. Above 12 the builder warns `PDF is unreadable beyond ~12 columns — use CSV`. | Use CSV, or cut columns. |
| Numbers disagree with Ads Manager on a de-duplicated metric | Ads Manager de-duplicates over the whole window; a multi-day or multi-account sum cannot reproduce that. | Compare on a single day and a single account, or compare additive metrics. |

Escalate to an operator for: account mapping and campaign overrides, role changes, sync failures, and
anything where the underlying data looks wrong rather than the report.

## Limits and edge cases

- **One breakdown dimension per report.** Two-dimension breakdowns are not supported.
- **One client per report.** No batch or multi-client runs.
- **No period-over-period comparison** column.
- **No scheduled or emailed delivery.** Export is the delivery.
- **500 rows maximum** per report; empty buckets are dropped before the cap so they cannot crowd out
  real rows. The Total row is computed over every bucket, including those cut by the cap.
- **CSV and PDF only.** No XLSX.
- **Snapshots preserve numbers, not bytes.** A re-exported archived run has identical figures; the
  exact PDF layout can change if the renderer changes.
- **Date maths is UTC on plain `YYYY-MM-DD` dates**, and the stored daily `date` is a plain date in
  the ad account's own timezone. Presets never use the server's local timezone, so a client's month
  boundary does not move depending on where the process runs.
- **Templates cannot hold a campaign filter unless they are bound to a client** — campaign ids belong
  to one client. The template form carries an existing filter but does not let you edit it; narrow
  campaigns at run time instead.
- **Deleting a template does not delete history.** Runs made from it show **Ad hoc** afterwards.
- **Clients removed from the Notion board** are excluded from the client and template pickers; their
  past runs remain (the `report_runs` → `clients` foreign key is `RESTRICT` on purpose).
- **The Reports section does not filter by engagement status.** A Paused or "Full Budget Finished"
  client can still be reported on, which is what you want when invoicing or wrapping up. That is
  different from the daily Telegram report, which deliberately excludes engagements marked
  `Full Budget Finished` even while they are still spending (`src/lib/daily-report.ts`).
- **Results** is objective-aware (traffic → link clicks, leads → leads, sales → purchases, and an ad
  set's optimised conversion event outranks the campaign objective), so it matches Ads Manager rather
  than any single action type.
- Reports read the synced database, so a campaign reporting ACTIVE in Meta may still have delivered
  nothing — account-level suspension or an exhausted spend cap stops delivery without changing
  campaign status.

## FAQ

**Where did "Split by day" go?**
It became the **Granularity** control, with five options instead of two. A checkbox could only say
daily or not-daily; Meta's axis is `all_days | 1 | 7 | 28 | monthly`, and summing daily rows into a
wider one silently double-counts every de-duplicated metric — so the setting had to become the
granularity itself.

**Does the client ever see the markup percentage?**
No. It appears only on the internal report card chip, in the History table's Markup column, and in the
stored run parameters — all staff-only, never the client. The CSV and the PDF (including the PDF's document properties)
cannot contain it: the document type they render from has no markup field. Do not screenshot the
report card or History into a client channel.

**Does markup change the impressions or the results?**
No. It inflates spend only, which raises every cost-per metric and lowers ROAS. Impressions, clicks,
reach, results and revenue are the real delivered figures.

**I generated a report yesterday and it is not in History. Why?**
History lists exported runs only. If you never clicked CSV or PDF, it is a draft — invisible in
History and deleted seven days after it was created. Reports built from a client page's "Export
report" panel are never recorded at all; use Reports → New report if you need the record.

**How long is a report kept?**
Exported runs are kept indefinitely, with their numbers frozen as delivered. Un-exported drafts live
seven days, then the sync worker deletes them on its daily pass.

**Why does Reach show a dash?**
Because that row covers more than one of Meta's own rows. Reach counts distinct people per day and
per account; adding two days together would count anyone present on both twice, and the true number
cannot be worked back out. Run at Daily granularity on a single-account client to get it exactly.

**Why can I not find ROAS (or another metric) in the column picker?**
The picker hides metrics with no data for the selected client and window — on a client with no
purchase data most of the 112 are dead columns of zeros. The footer says how many have data and
offers a **Show all** checkbox if you want the whole catalog anyway.

**A client's campaign is missing from their report.**
Ownership is resolved per campaign, not per account, because accounts are shared and recycled. If
name-based attribution and the Notion "Active Account ID" both fail to decide, the campaign is
assigned to nobody and appears in no client's report. Set a campaign override on the client page and
re-run.

**Can I schedule a weekly report to send itself?**
No. Save it as a template so it is one click, then run and export it. Export is the delivery.

**Can the AI assistant build me the file?**
No. It has no export tool and is instructed to send you here; it can answer the same question as
numbers in the chat.

**Can I export more than 500 rows?**
Not in one report. Narrow the breakdown, the campaigns or the range and run more than once. The
totals row is still correct for the whole window even when rows are cut.

**Two of us edited the same template — whose version wins?**
The last save. `saveTemplate` overwrites every field of the row, and the Templates table shows an
"Updated" timestamp so you can see when it last moved.
