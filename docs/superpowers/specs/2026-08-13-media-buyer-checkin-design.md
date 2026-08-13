# Daily Media-Buyer Check-In — Design

**Date:** 2026-08-13
**Status:** approved for planning (design gate passed with the operator on 2026-08-13)
**Author:** design session with the operator; every decision below is theirs unless marked
*[design call]*

---

## 1. Goal

At **17:00 Europe/Berlin** every day, ask each media buyer one status-appropriate question per
campaign they own that currently needs attention, and turn each substantive answer into a **comment
on that campaign's card** on the Notion campaigns board.

Success looks like: a buyer spends under a minute a day tapping "No changes" on most rows and typing
one or two real updates, and the Notion card accumulates a dated, attributed history of what actually
happened — without anyone opening Notion.

### Non-goals

- **This is not a metrics digest.** Roadmap fork K was resolved "dashboard-first" on 2026-08-13 and
  idea 8 (buyer digest) was rejected. This feature pushes **no** performance numbers to Telegram; it
  collects human context and writes it to Notion. The distinction is deliberate and must survive
  implementation: no spend, CPA, ROAS or pacing figures in the prompt.
- No client-facing surface. Internal team only.
- No write actions against Meta (roadmap idea 20 was rejected).
- Not a replacement for `alerts.ts`. Exception alerts stay exactly as they are.

---

## 2. Measured context (probed 2026-08-13)

Facts the design depends on, verified against the live board and production Postgres:

- The campaigns board is a **multi-source database with 2 data sources**; the campaigns data source is
  `a60b4fac-5877-834a-ae27-073d4ca57134` ("Meta Onboarding (1)"), **92 pages**.
- The status column is **`🤖 Account Status`** (type `status`), maintained by
  `syncNotionDailyBudgets` via `deriveStatus()`.
- **`Owners` is a `people` property.** Six humans appear in it board-wide: Shikhar Gupta (33 rows),
  Sofia Khomych (33), Vladyslav Istrati (12), Nick (9), Abel (6), Elad Malka (4).
- Notion person ids (stable; the design matches on these, never on display names):
  - Shikhar Gupta — `254d872b-594c-8154-9479-000271904e5b`
  - Vladyslav Istrati — `2cbd872b-594c-8119-9649-0002845d8d9c`
- Status distribution: `Full Budget Finished` 72, `Live` 8, `Ad Account Disabled` 4,
  `Ad Account Blocked` 4, `Not started` 4. `Paused`, `All ads rejected` and `On Boarding` currently
  have **zero** rows but are in scope when they occur.
- **Target rows today: 16.** Split by buyer: Shikhar 9, Vlad 7. Every target row has at least one
  media-buyer owner; no target row currently has both, though 28 of 92 rows carry 2–4 owners.
- Comment **reads** against a page return `200`, so the integration holds comment-read capability.
  Comment **inserts are unverified** — see §10.
- Telegram today is **send-only**: `sendTelegram()` in `src/sync/alerts.ts` posts to a single
  `TELEGRAM_ALERT_CHAT_ID` using `TELEGRAM_BOT_TOKEN`. There is no inbound path of any kind.
- `src/sync/worker.ts` is a bare hourly loop. `runCycle({full:true})` (the daily all-metrics refresh)
  can occupy hours, so **nothing time-sensitive may be sequenced behind it**.
- `sync_state` is keyed per **ad account**, so it cannot hold a Telegram cursor.

---

## 3. Decisions

| Decision | Choice |
|---|---|
| Trigger time | 17:00 **Europe/Berlin wall clock** — 15:00 UTC in summer, 16:00 UTC in winter |
| Target statuses | `Live`, `Paused`, `Ad Account Disabled`, `Ad Account Blocked`, `All ads rejected`, `On Boarding` |
| "Onboarding" means | `🤖 Account Status = "On Boarding"` — **not** the separate `Onboarding Status` or `Needs Onboarding` columns |
| Message shape | **One message per buyer**, listing their campaigns, two inline buttons per campaign |
| Questions | **One status-aware question** per campaign (§6) |
| Update filter | **Button only.** "No changes" writes nothing; *any* typed reply becomes a comment |
| Non-response | Escalate to the shared alert channel **the next morning at 09:00 Europe/Berlin** |
| Identity binding | Buyer sends `/start`; the bot records the chat; an **admin binds Notion person → chat id in Settings** |
| Shared rows | **Both** owners are prompted independently; **both** answers become comments |
| Inbound leg | **`getUpdates` long-poll inside `meta-sync`** — no public route, no new service |

Rejected alternatives, recorded so they are not revisited: one message per campaign (16 notifications
a day), one free-text blob split by an LLM (misattribution lands a comment on the wrong client's
card), LLM substantiality judgement (can swallow a real update), webhook into `meta-web` (adds an
unauthenticated public route to an auth-gated app), a dedicated `meta-checkin` systemd unit
(operational overhead, and the CLAUDE.md deploy runbook would need changing).

---

## 4. Architecture

```
17:00 Europe/Berlin tick ─► plan prompts (target rows × buyer owners)
                              │
                              ├─► checkin_prompts rows (unique per date+page+buyer)
                              └─► one Telegram message per buyer, 2 buttons per campaign

getUpdates long-poll ─► dispatch
   ├─ callback "No changes"  ─► prompt = no_changes, re-render list, write NOTHING
   ├─ callback "Update"      ─► send force_reply prompt, prompt = awaiting_reply
   ├─ reply to force_reply   ─► store answer ─► POST /v1/comments ─► prompt = answered
   └─ /start from any chat   ─► telegram_chats row (discovery for Settings binding)

09:00 next-day tick ─► escalate anything still open to TELEGRAM_ALERT_CHAT_ID
```

Both the poll and the two time gates live in **one independent loop** in `src/sync/worker.ts`,
started alongside — never inside — the existing hourly sync loop. The loop ticks on a short interval
(30 s long-poll), and each tick also evaluates the time gates, giving ≤1 minute of scheduling
precision regardless of what the sync cycle is doing.

### 4.1 Answer attribution — the load-bearing mechanism

A misattributed comment lands on the wrong client's card, so an answer is **never guessed**.

Tapping **Update** makes the bot send a *new* message — `✍️ Update for <Campaign> (<Status>)` — with
`reply_markup: { force_reply: true, selective: true }`. Telegram then stamps
`reply_to_message.message_id` onto whatever the buyer types, and that id maps 1:1 to a
`checkin_prompts` row. This survives answering out of order, answering hours later, and several
prompts being open at once.

Fallback for a plain message that is not a reply:

- exactly one prompt in `awaiting_reply` for that chat → attribute to it;
- more than one → the bot **asks which campaign** and writes nothing;
- none → the bot replies that there is nothing open, and writes nothing.

Callback payloads must fit Telegram's 64-byte limit: `nc:<promptId>` and `up:<promptId>` over integer
prompt ids. `answerCallbackQuery` is called immediately on every callback so the buyer's client stops
spinning.

### 4.2 Live checklist rendering *[design call]*

After every state change the buyer's daily message is re-rendered with `editMessageText`: closed
campaigns show `✅` or `✍️` and lose their buttons, open ones keep them. This makes a tap visibly
register and doubles as the buyer's own progress list. Re-render failures are non-fatal — the prompt
state in Postgres is authoritative.

---

## 5. Data model

Five tables. All new; none alter existing ones except `clients.raw`'s stored row shape (§7).

**`telegram_chats`** — discovery only, so Settings can offer a chat to bind.

| column | type | notes |
|---|---|---|
| `chat_id` | text PK | Telegram chat id as text (ids exceed 32-bit) |
| `username` | text null | `@handle` at last sighting |
| `first_name` | text null | for display in Settings |
| `first_seen_at` / `last_seen_at` | timestamptz | |

**`media_buyers`** — membership here is what makes someone a media buyer. A third buyer is a Settings
action, not a deploy.

| column | type | notes |
|---|---|---|
| `notion_person_id` | text PK | matched against `Owners` |
| `display_name` | text | as it appears in Notion |
| `telegram_chat_id` | text null | null = unroutable |
| `active` | boolean default true | inactive buyers are skipped without deleting history |
| `bound_by` / `bound_at` | text null / timestamptz null | audit of who bound the chat |

**`checkin_prompts`** — one row per (date, page, buyer).

| column | type | notes |
|---|---|---|
| `id` | serial PK | small integer keeps callback data well under 64 bytes |
| `prompt_date` | date | Europe/Berlin local date |
| `notion_page_id` | text | the campaign card |
| `campaign_title` | text | snapshotted for the message and for history |
| `status` | text | the status at prompt time |
| `buyer_person_id` | text | FK → `media_buyers` |
| `chat_id` | text null | null when unroutable |
| `question` | text | snapshotted, so later wording changes don't rewrite history |
| `list_message_id` | text null | the buyer's daily list message, for re-rendering |
| `reply_message_id` | text null | the `force_reply` message an answer replies to |
| `state` | text | `pending` \| `awaiting_reply` \| `answered` \| `no_changes` \| `escalated` \| `unroutable` |
| `answer_text` | text null | stored **before** the Notion write |
| `notion_comment_id` | text null | null with `state=answered` means the comment still owes a retry |
| `note` | text null | last error (send failure, comment failure) |
| `answered_at` / `created_at` | timestamptz | |

Unique index on (`prompt_date`, `notion_page_id`, `buyer_person_id`) — a worker restart at 17:00
cannot double-prompt.

**`checkin_runs`** — makes both time gates idempotent, and stops the 17:00 gate from re-planning every
minute on a day with zero target rows.

| column | type | notes |
|---|---|---|
| `run_date` | date PK | Europe/Berlin local date |
| `planned_at` | timestamptz null | set once prompts are planned |
| `prompts_created` | integer default 0 | zero is a legitimate outcome |
| `escalated_at` | timestamptz null | set once the 09:00 escalation for that date has run |

**`telegram_state`** — singleton, holding the `getUpdates` cursor so restarts neither replay nor drop
taps.

| column | type |
|---|---|
| `id` | text PK default `'singleton'` |
| `update_offset` | bigint null |
| `updated_at` | timestamptz |

---

## 6. Question per status

Snapshotted onto the prompt row at creation.

| Status | Question |
|---|---|
| `Live` | Any changes today — budget, creatives, targeting? |
| `Paused` | Why is it paused, and when does it resume? |
| `Ad Account Disabled` | What's the recovery plan — is a replacement account lined up? |
| `Ad Account Blocked` | Funding/top-up status — when does delivery resume? |
| `All ads rejected` | What's the fix — new creatives or an appeal? |
| `On Boarding` | What's still outstanding before launch? |

A status with no mapping is **not prompted**, and the run reports it — a silent default question would
be worse than an obvious gap.

---

## 7. Message and comment formats

**Daily list** (one per buyer):

```
🕔 Daily check-in — Wed 13 Aug

1. Slots.lv — Live
   Any changes today — budget, creatives, targeting?
2. Lucky Rebel — Ad Account Blocked
   Funding/top-up status — when does delivery resume?
```

Inline keyboard: one row per campaign, `✅ No changes · 1` and `✍️ Update · 1`. The index ties a short
button label to the list unambiguously — campaign titles are too long for button labels
(`fortunegalaxy.io   Palmluck (26 May 2026)`).

**Force-reply prompt:**

```
✍️ Update for Slots.lv (Live)
Any changes today — budget, creatives, targeting?
↩️ Reply to this message.
```

**Notion comment** on the campaign page:

```
🤖 Daily check-in · 2026-08-13 · Shikhar Gupta
Status: Ad Account Blocked
Q: Funding/top-up status — when does delivery resume?
A: Topped up $2k this morning, delivery should resume tonight.
```

The buyer's name is carried in the body because the comment's author is the integration, not the
human. Notion caps a `rich_text` item at 2000 characters and Telegram caps a message at 4096, so an
answer needs at most two chunks; the body is split on that boundary rather than truncated.

**Escalation** to `TELEGRAM_ALERT_CHAT_ID` at 09:00 the next morning:

```
⚠️ Check-in 2026-08-13 — 3 campaigns unanswered
Shikhar Gupta: Slots.lv, Lucky Rebel
Vladyslav Istrati: CasinOK.com
No Telegram binding: —
```

Unroutable prompts are named in the same message, so a missing binding is visible rather than silent.

---

## 8. Code layout

| File | Responsibility |
|---|---|
| `src/lib/checkin.ts` (create) | Pure. `CHECKIN_STATUSES`, `questionFor(status)`, `planPrompts()`, `commentBody()`, `renderList()`, `parseCallback()`, `berlinNow(clock)`. No imports from `db/`, `sync/` or `notion/`. |
| `src/lib/checkin.test.ts` (create) | Unit tests for all of the above. |
| `src/telegram/client.ts` (create) | `sendMessage`, `editMessageText`, `answerCallbackQuery`, `getUpdates`. Injectable `fetchImpl`, mirroring `NotionClient`. |
| `src/telegram/client.test.ts` (create) | Recorded-`fetchImpl` tests, following `src/notion/client.test.ts`. |
| `src/telegram/updates.ts` (create) | `handleUpdate(update, deps)` → intents. IO at the edges. |
| `src/telegram/updates.test.ts` (create) | Dispatch cases incl. unknown chat, ambiguous plain message, stale callback. |
| `src/notion/client.ts` (modify) | Add `createComment(pageId, chunks)`. |
| `src/notion/parse.ts` (modify) | Parse `Owners` person ids into the parsed row; extend `boardRows()` output shape. |
| `src/sync/jobs/clients.ts` (modify) | Persist owner ids on `clients.raw` rows so the 17:00 job needs no Notion read. |
| `src/sync/jobs/checkin.ts` (create) | `runDailyCheckin(today)`, `escalateUnanswered(date)`, comment-retry sweep. Writes `service_health` (`service='checkin'`). |
| `src/sync/worker.ts` (modify) | Start the independent poll + time-gate loop. |
| `src/db/schema.ts` (modify) + migration | The five tables in §5. |
| `src/server/fns/checkin.ts` (create) | Admin-only: list discovered chats, bind/unbind a buyer, read today's prompt states. |
| Settings UI (modify) | Binding panel + today's check-in state + a comment-capability health line. |

`src/lib/checkin.ts` deliberately does not import `deriveStatus` or any db module: it receives rows
and returns plans, so the whole decision surface is testable without a database or a network.

---

## 9. Failure handling

- **A typed answer is persisted before the Notion call.** A comment failure never loses it; a retry
  sweep on later ticks re-attempts, and a persistent failure is reported to the alert channel and to
  `service_health`.
- **Send failure** leaves the prompt `pending` with `note` set; the next tick retries. A prompt that
  was never delivered still escalates at 09:00.
- **Unroutable buyer** (`telegram_chat_id` null) creates prompts in state `unroutable` so the gap is
  named in the escalation instead of vanishing.
- **Telegram 429** → honour `retry_after`. Notion writes stay under the existing ~3 req/s pacing
  (`WRITE_GAP_MS`).
- **Stale callback** (yesterday's message, already-closed prompt) → `answerCallbackQuery` with a short
  explanation, no state change.
- **Unknown chat** sends `/start` → recorded in `telegram_chats`, replied to with its chat id so the
  admin can bind it. **No campaign data is ever sent to an unbound chat.**
- **Late answers** still write, and the comment names the date the check-in was for.
- **A page deleted or archived in Notion** between prompt and answer → comment fails permanently;
  after the retry budget the prompt is marked with the reason in `note` and reported.

---

## 10. External prerequisites

1. **Notion "Insert comments" capability must be enabled on the integration.** Reads return `200`;
   inserts were deliberately not tested against the live board during design. Implementation must
   verify this **first** — with a comment on a scratch page, not a client card — because the feature
   cannot work without it and the fix requires Notion workspace admin rights.
2. **Both buyers must send `/start` to the bot once**, and an admin must bind each to their Notion
   person id in Settings. Until then their prompts are `unroutable`.

---

## 11. Testing strategy

Pure-unit first, no live Telegram or Notion anywhere in the suite:

- `questionFor` covers all six statuses; an unmapped status returns null and is not prompted.
- `planPrompts`: status filter; owner ∩ media-buyer filter (Sofia/Nick/Abel/Elad excluded); multi-owner
  fan-out produces one prompt per buyer; inactive buyer skipped; unroutable buyer still planned;
  re-running the same date produces no duplicates.
- `parseCallback`: valid `nc:`/`up:`, unknown prefix, non-numeric id, oversized payload.
- `commentBody`: exact format; a >2000-character answer splits into two chunks, never truncates.
- `renderList`: closed campaigns lose buttons and show their marker; button labels stay within
  Telegram's limits.
- `berlinNow`: 17:00 gate fires once per local day across a DST boundary in both directions.
- Dispatcher: reply resolves via `reply_to_message`; ambiguous plain message asks instead of guessing;
  message from an unbound chat is ignored except for `/start`; stale callback is a no-op.

---

## 12. Out of scope for this build

Client-facing exposure of any of it; performance figures in the prompt (see §1); per-campaign
reminders before the 09:00 escalation; editing or deleting a comment after it is written; a web UI for
answering (Settings shows state only); any Meta write action.
