# Daily performance Telegram report — design

**Date:** 2026-09-01
**Status:** approved, ready to implement

## Goal

Post one message to the shared Telegram alert channel each morning listing **yesterday's**
performance for every active engagement: spend, results, ad-account active/disabled state, and the
**Notion** name (not the Meta campaign name).

## The granularity problem, and what "Campaign Name from Notion" resolves to

The Notion board's title property is literally called `Campaign` (`src/notion/parse.ts:168`), which
makes the request sound trivial. It is not: **a board row is one client-brand engagement**, not a
Meta campaign — e.g. `"wildcasino.ag (June/July 2026)"`, `"Farside (2)"`. The board carries **no
Meta campaign id anywhere**. Its only link to Meta is two free-text ad-account-id columns,
`Active Account ID` and `Other ad accounts` (`parse.ts:174-175`).

A Meta campaign therefore has no Notion name of its own. The finest Notion-sourced name available is
the owning engagement's row title, reached campaign → account → owning row.

**Decision: one line per Notion engagement**, aggregating all of that engagement's campaigns. This
matches the grain at which Notion names actually exist, keeps the message short, and never prints a
duplicated label.

## Attribution — the load-bearing decision

Aggregate from **campaign-level** insights, attributed via `loadCampaignOwnership()`
(`src/server/fns/campaign-attribution.ts:79`; ladder: manual override → brand name → sole
`Active Account ID` claimant → nobody).

Do **not** aggregate account-level insights through `effectiveAccountIds()`. Ad accounts are shared
and recycled, so several Notion rows can claim one `act_` id; summing account-level spend per
claimant gives each of them the account's **full** spend. `fetchClientsRanked()`
(`src/server/fns/clients.ts:133`) has exactly this shape and must not be the model here. CLAUDE.md
records the same class of bug being wrong by 71× on multi-account clients.

## Membership rules

Two grains, and the distinction matters:

**Which engagements are REPORTED** (`isReportable`, applied to the aggregated row):

- trailing spend over the **3 complete days ending yesterday** is **> $1**, AND
- the client's Notion `Account Status` is **not** `Full Budget Finished`.

Both clauses do independent work and neither implies the other. A finished engagement can still be
spending — bspin.io billed $513.84 over three days while marked finished — and a live engagement can
go quiet for a day. Trailing spend rather than yesterday's, so a client that simply had a dark day is
not dropped from a report the team reads as "who is running". `> $1`, not `>= $1`: the threshold
exists to discard rounding dust.

Testing the client's single winning status is safe: `clubClients` resolves a client's board rows by
`STATUS_PRIORITY` (`src/notion/parse.ts:237`), where every live-ish value outranks
`Full Budget Finished`, so a client reading it has no current row at all. The Clients page already
filters this way (`src/routes/clients.index.tsx:37`).

The rule is applied to the **engagement**, not to each campaign. A kept engagement therefore reports
its true total for yesterday; filtering campaigns individually would print a figure that excluded
part of the engagement's real spend and stop reconciling against Meta. On live data both readings
selected the same seven engagements, so this costs nothing today and keeps the totals honest.

**Which campaigns CONTRIBUTE to a reported engagement's numbers** (`includeCampaign`): spent > 0
yesterday OR `effective_status` is currently `ACTIVE`. The union keeps yesterday's total correct (a
campaign paused this morning still spent yesterday) without letting long-dead campaigns drag the
account-health badge.

**Excluded entirely:** campaigns whose owner resolves to `null`. Consequence, accepted deliberately:
the printed total does not reconcile with Meta's true daily spend, so it is labelled
`across N engagements` and never "yesterday's total spend".

## Collapse rules

**Results** — objective-aware per campaign via `objectiveResults(w).campaign`
(`src/server/fns/dashboard.ts:132`), which applies `resultSpec()` (`src/server/creative.ts:60`) and
returns `{ value, label }`. Per engagement, sum counts **grouped by label**:

- one distinct label → `83 Purchases`
- several → `27 Leads, 4 Purchases`, sorted by count descending
- all zero → `0 <dominant-spend label>`

Summing across labels into one number is prohibited: it would count a lead as a purchase.

**Account status** — an engagement is **ACTIVE when ANY one of its accounts can still deliver**.
Any-active-wins, not worst-wins: an agency engagement accumulates recycled and banned accounts as it
runs, so worst-wins flagged nearly every engagement as partly disabled — true, but it buried the only
question the line answers, *can this client still spend?*

"Can deliver" is `canDeliver()` (`src/sync/jobs/notion-budget.ts:179`), **not**
`accountStatus() === "ACTIVE"`. Meta stops delivery when a prepaid `spend_cap` is exhausted and
leaves the account reporting ACTIVE, so under any-active-wins a single exhausted account would
otherwise mark a dead engagement healthy.

When nothing can deliver, the state needing the most different action wins:

- any account deliverable → `✅`
- status ACTIVE but cap exhausted → `💸 OUT OF BUDGET` (top it up, not appeal it)
- else worst of `DISABLED > PENDING > PAUSED` → `🚫 DISABLED (payment failed)`

No account counts are ever printed. Reason text via `disableReasonLabel()` (`src/lib/format.ts:41`),
never a raw code.

**Currency** — there is **no FX conversion anywhere in this codebase** (verified: no
`exchangeRate`/`toUsd`/`convertCurrency` symbol exists) and `accounts.currency` varies. Spend is
therefore summed **per currency**. A single-currency engagement renders `$1,240.50`; a mixed one
renders `$800.00 + €300.00`. Never a single invented number.

## Message format

Plain text. The Telegram client sends **no `parse_mode`** (`src/telegram/client.ts:114` — the wire
payload is only `chat_id`, `text`, `disable_web_page_preview`), so there is no Markdown/HTML
escaping to do and none must be introduced. Emoji is the only available emphasis, matching existing
headings like `🚨 Spend-drop alert`.

```
📊 Yesterday · Mon 31 Aug

1. wildcasino.ag (June/July 2026) — $1,240.50 · 83 Purchases ✅
2. Farside (2) — $610.00 · 27 Leads, 4 Purchases · 🚫 DISABLED (payment failed)
3. Slots.lv — $210.00 · 9 Registrations · 💸 OUT OF BUDGET
4. CasinOK.com — $0.00 · 0 Purchases ✅

Total: $2,061.00 across 4 engagements
```

Sorted by spend descending, so zero-spend live engagements sit at the bottom. Date label via
`dayLabel()` (`src/lib/checkin-render.ts:131`) → `Mon 31 Aug`.

**Overflow:** Telegram caps a message at 4096 characters and no Telegram chunker exists
(`commentBody()` targets Notion's 2000-char limit, not this). Split at engagement-line boundaries
into numbered messages, header `📊 Yesterday · Mon 31 Aug (1/2)`; the counter is omitted when there
is only one message. Nothing is ever dropped.

## Schedule

**10:00 Europe/Berlin, seven days a week.**

Los Angeles midnight lands at 09:00 Berlin in *both* DST regimes (summer UTC-7 vs UTC+2; winter
UTC-8 vs UTC+1), so 10:00 is the earliest DST-robust slot at which US west-coast accounts' local
"yesterday" has closed. `INSIGHTS_REFRESH_DAYS = 28` (`src/sync/cycle.ts:41`) means the hourly core
pass keeps re-ingesting yesterday, so the figures do not depend on one lucky sync.

Weekends included — spend does not stop. This differs from `isPromptDay()`, which is Mon–Fri because
it is asking humans questions.

## Architecture

```
src/lib/daily-report.ts          PURE: DAILY_REPORT_AT, aggregateEngagements(),
                                       collapseResults(), engagementDelivery()
src/lib/daily-report-render.ts   PURE: renderDailyReport() -> string[], 4096 chunking
src/server/fns/daily-report.ts   IO:   fetchDailyEngagementRows(w)
src/sync/jobs/daily-report.ts    JOB:  claim -> fetch -> render -> send -> record
src/db/schema.ts                 +daily_report_runs
src/sync/worker.ts               +one atOrAfter gate
```

Mirrors the established split: pure decision core in `src/lib` (as `checkin.ts`), pure presentation
beside it (as `checkin-render.ts`), IO in `src/sync/jobs`. The pure halves carry the logic worth
testing and need no database.

Data reads: one `insights_daily` spend query grouped by `entity_id` at `level='campaign'`, plus
`objectiveResults(w)`, the `campaigns` and `accounts` rows, and `loadCampaignOwnership()`.
`fetchCampaigns()` is deliberately **not** reused — it loads all ad sets, ad counts and creatives,
and its returned `status` is a display status derived from `campaigns.status`, not the
`effective_status` this feature needs.

`insightsBreakdownDaily` must not be touched: it is the same spend split by dimension and summing it
double-counts.

## Idempotency

New table, mirroring `checkin_runs`:

```ts
export const dailyReportRuns = pgTable("daily_report_runs", {
  runDate: date("run_date").primaryKey(),   // the REPORTED date (yesterday), not the send date
  sentAt: timestamp("sent_at", { withTimezone: true }),
  engagements: integer("engagements").notNull().default(0),
  messages: integer("messages").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
});
```

The day is claimed by `insert … onConflictDoNothing().returning()` **before** sending, because
double-posting is worse than posting late. On send failure `sent_at` stays null and `attempts`
increments; the next 30s loop iteration retries until `MAX_ATTEMPTS`, then stops and leaves `error`
for Settings/logs. Matches the existing claim style of `checkin_runs.run_date` and
`alerts.onConflictDoNothing()`.

The worker's single-instance assumption (`src/sync/worker.ts:25-41`) still holds — the row claim is
in-transaction, so a second process would simply lose the race.

## Accepted caveats

1. The window is UTC date arithmetic while `insights_daily.date` is a plain date in each **account's
   own** timezone. This is the documented app-wide convention (`src/lib/date-presets.ts:11-13`);
   deviating here would make this report disagree with every dashboard.
2. Meta restates attribution for ~28 days, so yesterday's numbers drift slightly after sending.
3. The total omits unattributed spend (see membership rules) and says so.

## Testing

Pure unit tests, no DB, fast:

- `src/lib/daily-report.test.ts` — membership union (spent-not-active, active-not-spent);
  shared-account attribution not double-counted; results uniform vs mixed vs all-zero; one deliverable
  account beating many dead ones regardless of order; an exhausted-cap account reading as
  OUT_OF_BUDGET rather than ACTIVE or DISABLED; per-currency splitting.
- `src/lib/daily-render.test.ts` — line format; spend ordering; chunk boundaries at exactly 4096 with
  `(i/n)` headers; single-message case omits the counter.

Then a real end-to-end send against the live alert channel to prove the wiring, since a passing unit
test on a pure renderer does not prove the job posts anything.

## Out of scope

- No manual send button and no `/report` Telegram command (`handleUpdate` deliberately swallows all
  commands in bound chats).
- No second destination chat: the system has exactly one alert channel, resolved by
  `getTelegramCredentials()`.
- No change to `mmv-checkin/`, which is a git-less divergent duplicate working copy. Build only in
  `meta-muse-view`.
