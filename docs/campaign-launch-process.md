# Campaign launch process (Notion)

The standard sequence from confirmed payment to a live, verified campaign. Lives entirely in the
Notion campaigns board — **deliberately not automated**. Nothing in MetaConsole reads or writes these
fields, so the process can be changed by whoever owns it without touching code.

Two variants, selected by one checkbox: without creative design the campaign goes live on **D+3**;
with design it goes live on **D+4** and is verified on **D+5**.

## Why it is shaped this way

- **Days are relative, never calendar.** D+0 is the day payment is confirmed. A Friday payment must
  not silently make "Day 3" mean Monday, so the day labels live on the checklist items and the only
  dates stored are the trigger and the target go-live.
- **One checklist with a branch, not two checklists.** Two templates drift apart within a month. The
  design steps are simply skipped when `Creative Required` is unchecked.
- **The checklist lives in the page body, not in columns.** Thirteen steps as thirteen properties
  would wreck a board that already carries 35 columns. Four queryable fields is enough to run a
  pipeline view; the step detail belongs in the row.
- **Roles are written into the step text** (`[AM]`, `[MB]`, `[TRK]`, `[DES]`) rather than added as
  four more people columns. `Owners` still says who is on the campaign.

## Fields added to the Campaigns board

All four are prefixed `🚀` so they group together in a long property list, and all are human-owned.
(The `🤖` prefix is reserved for columns MetaConsole writes — do not use it here.)

| Field | Type | Purpose |
| --- | --- | --- |
| `🚀 Payment Confirmed` | date | **The trigger.** D+0. Everything else is counted from this. |
| `🚀 Creative Required` | checkbox | Selects the variant. Checked → design steps apply, go-live moves to D+4. |
| `🚀 Launch Stage` | select | Pipeline position. Drives the board view. |
| `🚀 Go Live Target` | date | D+3 or D+4, set by the AM when payment lands. The date the client is told. |

`🚀 Launch Stage` options, in order:

`Tracking setup` → `Client verification` → `Creative review` → `Upload & go live` →
`Post-launch check` → `Launched`, plus `Blocked` for anything stalled.

`Creative review` is skipped when `Creative Required` is unchecked.

**Relationship to `Onboarding Status`:** that field stays as-is and answers *who is blocking*
(`Our action pending` / `Client action pending` / `Pending payment`). `🚀 Launch Stage` answers *where
in the launch we are*. Use `Blocked` on the stage only when the launch has actually stopped; the
reason belongs in `Onboarding Status`.

## The checklist

Paste this into the Notion template (see setup below). Prefixes: `[TRK]` tracking, `[MB]` media
buyer, `[DES]` design, `[AM]` account manager.

```text
D+0 — payment confirmed
[ ] [TRK] Tracking setup started
[ ] [MB]  Creative brief shared with Sofia & Victoria

D+1
[ ] [TRK] Tracking verified with the client — every event tested end to end
[ ] [TRK] PWA / prelanders set up
[ ] [MB]  Notion updated: Budget ($), Daily Budget ($), Geo's, Goal, Active Account ID
[ ] [AM]  Plan shared with the client

D+2 — ONLY IF "Creative Required" is checked
[ ] [DES] Creative designs ready
[ ] [AM]  Designs shared with the client, feedback captured

D+2 (no design) / D+3 (with design) — GO LIVE
[ ] [MB]  Campaign uploaded and set live
[ ] [AM]  Client reporting access set up and confirmed working

D+3 (no design) / D+4 (with design) — VERIFY
[ ] [MB]  Campaigns have started spending
[ ] [AM]  Reporting is receiving data and the client confirms they are happy
```

Note the day labels count from D+0 = payment confirmed, so a no-design launch goes live on the third
working day (D+2 after the trigger day) and is verified the day after. Adjust the labels if the team
prefers to count the trigger day as "Day 1" — keep whichever convention, but only one.

## One-time setup in the Notion UI

The API cannot create templates, views or automations, so these are manual:

1. **Template button** on the Campaigns board → new template named `Launch checklist`. Paste the
   checklist above into the template body as to-do blocks. One template covering both variants; the
   design block is skipped when not needed.
2. **Board view** named `Launch pipeline`, grouped by `🚀 Launch Stage`, filtered to
   `🚀 Payment Confirmed is not empty` **and** `🚀 Launch Stage is not Launched`. Sort by
   `🚀 Go Live Target` ascending. This is the daily standup view.
3. **Table view** named `Launch overdue`, filtered to `🚀 Go Live Target is before today` and
   `🚀 Launch Stage is not Launched`. This is the escalation list.
4. **Add Victoria to the workspace/board** — she is named in the brief step but is not currently a
   member of the campaigns board, so she cannot be assigned or notified.
5. Optional: a Notion reminder on `🚀 Go Live Target` for the row's `Owners`.

## Conventions

- **New campaigns only.** 15 rows currently flag `Needs Onboarding`; do not retrofit them, or the
  pipeline view will open full of history. Retrofit deliberately, one row at a time, if ever.
- **Client reporting access** is written generically on purpose. It means AgencyAnalytics today; the
  roadmap's client portal is intended to replace it, and the checklist should not need editing when
  that happens.
- **Blocked is a stage, not a state of mind.** If a launch sits in `Blocked` for more than a day, the
  reason should be visible in `Onboarding Status` and the row's comments.

## What is deliberately not automated

Four of these steps are machine-provable from data MetaConsole already holds, and three more
partially. They are ticked by humans today by choice — the process needs to prove itself before it is
worth encoding:

| Step | How it could be verified later |
| --- | --- |
| Events tested end to end | `insights_daily.actions` shows which events actually fired |
| Notion updated with amounts/targeting | the fields are either populated or they are not |
| Campaign uploaded and live | campaign `effective_status = ACTIVE` on the mapped account |
| Campaigns have started spending | spend > 0 |
| PWA / prelanders set up | `Destination URL` present + an HTTP check |
| Creative designs ready | the read-only Asset Library integration |
| Tracking setup | a pixel exists and is attached to the account |

If and when this process sticks, the natural next step is a nightly readiness audit that writes
blockers back as a `🤖` column and nudges the owner — not a rewrite of the workflow.
