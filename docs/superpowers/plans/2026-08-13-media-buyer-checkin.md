# Daily Media-Buyer Check-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At 17:00 Europe/Berlin each day, ask each media buyer one status-appropriate question per campaign they own that needs attention, and write each typed answer as a comment on that campaign's Notion card.

**Architecture:** A pure core (`src/lib/checkin.ts`) decides *what* to ask, *who* to ask and *how* every message and comment reads — no database, no network, fully unit-tested. A thin Telegram client mirrors the existing `NotionClient` shape (injectable `fetchImpl`, never throws). An independent loop inside the existing `meta-sync` worker long-polls `getUpdates`, evaluates the 17:00 and 09:00 time gates on every iteration, and flushes pending Notion comments. Answers are attributed by Telegram `force_reply` message ids, never by per-chat guessing.

**Tech Stack:** TypeScript, Bun test, Drizzle ORM + Postgres, Notion API `2025-09-03`, Telegram Bot API, TanStack Start server functions.

**Design spec:** `docs/superpowers/specs/2026-08-13-media-buyer-checkin-design.md`

---

## Conventions in this codebase — read before Task 1

- **There IS a test database — this plan originally said otherwise and was wrong.** `bunfig.toml` has
  `[test] preload = ["./test-setup.ts"]`, and `test-setup.ts` rewrites `DATABASE_URL` to
  `TEST_DATABASE_URL` (`.../meta_test`) for EVERY `bun test` run. `src/db/client.ts` builds its client
  from `env().DATABASE_URL` at import time, so any test importing it hits `meta_test`.
  `src/db/schema.test.ts` already truncates and round-trips a real row there.
- **Keep `meta_test` in step with `meta`.** It carries all 11 `infra_*` tables the other session
  shipped, so that is the established convention. Apply new DDL to BOTH databases, by executing
  drizzle's generated statements directly — never via `db:push` (see the schema note below).
- **Write pure-unit tests only. Do NOT add a DB-backed test in this plan.** `meta_test` is a *shared
  mutable* database, not a private fixture: measured 2026-08-13 during this build, it had **34 live
  connections** from another session (querying `infra_business_managers`, `users`, `sync_state`) and
  that session's own smoke fixtures (`DOT-SMOKE-TEST-1`, `Amber Media-SMOKE-9`) being inserted
  *while our suite ran*. A test that `truncate`s shared tables there is not merely flaky in both
  directions — **it deletes the other session's fixtures**, which ours did once before being reverted.
  The pre-existing `src/db/schema.test.ts` gets away with it only because nothing else was running
  when it was written.
- Consequence for the `checkin_prompts` unique index, which IS the idempotency guarantee of the 17:00
  job: it was verified **empirically** rather than by a committed test. Inserting a duplicate
  (`prompt_date`, `notion_page_id`, `buyer_person_id`) produced
  `PostgresError 23505: duplicate key value violates unique constraint
  "checkin_prompts_day_page_buyer_idx"` with `detail: Key (prompt_date, notion_page_id,
  buyer_person_id)=(2026-08-13, page-1, buyer-a) already exists`, and `.onConflictDoNothing()` against
  it was confirmed a silent no-op. If this project ever gets a private, per-run test database, that is
  the test to add first.
- **`bun test` is NOT a clean gate on this repo.** Measured 2026-08-13: some pre-existing tests hit
  the real Postgres and are flaky. Known members of that set, all verified pre-existing by restoring
  the `HEAD` version of the file and re-running:
  - `src/lib/auth/users.test.ts` — `setUserPassword rotates the password` (5 s timeout)
  - a `saveCredentials` case
  - `src/sync/jobs/clients.test.ts` — imports `@/db/client`, runs `truncate table clients cascade` in
    `beforeEach`; 2 of its 4 tests time out ("a client that leaves the board is retained and marked
    removedAt", "a re-appearing client is un-marked"). **Task 14 must not gate on this file.**

  **Root cause, measured 2026-08-13 — environmental, not a code defect.** Every DB-backed test runs
  against the droplet's Postgres over an ssh tunnel from Windows. `src/db/schema.test.ts` (one
  truncate, one insert, one select — the most trivial DB test in the repo) takes **3.84 s**, i.e. 77%
  of bun's 5000 ms default timeout. Anything doing `truncate ... cascade` plus multi-row fixtures
  therefore blows the timeout on round-trip latency alone. Do NOT "fix" these by rewriting the tests;
  they pass against a local database.

  A baseline run gave 126 pass / 1 fail, and a second gave 125 / 2, with no code change between them.
  Always compare against a baseline you took yourself rather than expecting zero failures.
- Run a single test file with `bun test <path>`; run this feature's own files with
  `bun test src/lib/checkin.test.ts src/lib/berlin-time.test.ts src/lib/checkin-render.test.ts`.
- The project formatter is authoritative over the code blocks in this plan: `printWidth` is 100, and
  a few snippets here exceed it. If `bunx eslint` rejects a verbatim snippet on `prettier/prettier`,
  run `bunx prettier --write` on the files you created and move on — do not hand-reflow.
- API clients take `private fetchImpl: typeof fetch = fetch` as their second constructor argument so
  tests can record calls. Copy the `recorder()` helper from `src/notion/client.test.ts`.
- Server fns live in `src/server/fns/*.ts` as plain async functions that call `requireAdmin()` from
  `./auth`, and are exposed to the client through `createServerFn` wrappers in `src/lib/api/*.ts`.
- **Schema changes use `drizzle-kit push`, not migrations.** Measured 2026-08-13: `src/db/migrations`
  does not exist in this repo or on the droplet, and the 11 infrastructure-registry tables added
  earlier today are live in production — so the project's convention is `bun run db:push`. Edit
  `src/db/schema.ts`, then push. Never hand-write SQL.
- `drizzle-kit` reads `DATABASE_URL` from the environment via `drizzle.config.ts`. A fresh git
  worktree has no `.env` (it is gitignored), so copy it in before running any `db:*` script.
- Commit after every task. Stage only the files that task names — the repo has untracked scratch
  files (`.tmp-*.ts`) and **a parallel session may be working in this worktree**, so
  `git add -A` is prohibited.

---

## PREREQUISITE — Task 0 must pass before anything else is built

The feature cannot work unless the Notion integration may insert comments. Reads are known to work;
inserts are unverified.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/checkin.ts` (create) | Pure decision core: gate hours, the status→question catalogue, the `CheckinStatus`/`PromptState` vocabulary, and the prompt planner. No imports except a type-only one from `delivery-status.ts`. |
| `src/lib/checkin.test.ts` (create) | Unit tests for the decision core. |
| `src/lib/berlin-time.ts` (create) | Generic Berlin wall-clock helpers: `berlinNow`, `dayLabel`. Knows nothing about check-ins. |
| `src/lib/berlin-time.test.ts` (create) | Unit tests for the time helpers, including hostile-timezone runs. |
| `src/lib/checkin-render.ts` (create) | Presentation for two external systems: Telegram callback encoding + message rendering, and Notion comment chunking. Pure. |
| `src/lib/checkin-render.test.ts` (create) | Unit tests for the renderers. |
| `src/telegram/client.ts` (create) | `TelegramClient`: `sendMessage`, `editMessageText`, `answerCallbackQuery`, `getUpdates`. Never throws. |
| `src/telegram/client.test.ts` (create) | Recorded-`fetchImpl` tests. |
| `src/telegram/updates.ts` (create) | `handleUpdate(update, deps)` — dispatch logic over injected repository functions. |
| `src/telegram/updates.test.ts` (create) | Dispatch tests with fake deps. |
| `src/notion/client.ts` (modify) | Add `createComment(pageId, chunks)`. |
| `src/notion/client.test.ts` (modify) | Test the comment request shape. |
| `src/notion/parse.ts` (modify) | Parse `Owners` people ids onto rows; carry them through `clubClients` and `boardRows`. |
| `src/notion/parse.test.ts` (modify) | Owner parsing + round-trip through `boardRows`. |
| `src/db/schema.ts` (modify) | Five new tables. |
| `src/sync/jobs/checkin.ts` (create) | DB/IO orchestration: plan + send, poll, flush comments, escalate. |
| `src/sync/alerts.ts` (modify) | Route its Telegram send through `TelegramClient` so there is one Telegram code path. |
| `src/sync/worker.ts` (modify) | Start the independent check-in loop. |
| `src/server/fns/checkin.ts` (create) | Admin-only reads/writes for buyer binding. |
| `src/lib/api/checkin.ts` (create) | `createServerFn` wrappers. |
| `src/components/settings/MediaBuyerPanel.tsx` (create) | Settings panel: bind buyers, view today's prompts. |
| `src/routes/settings.tsx` (modify) | Mount the panel. |

`src/lib/checkin.ts` deliberately does not import `deriveStatus`: it receives a status string and
returns a question, so the whole decision surface is testable without a database or a network.

---

## Task 0: Verify the Notion comment-insert capability

**Files:** none — this is a verification gate.

- [ ] **Step 1: Create a throwaway Notion page to write to**

In Notion, create a page named `MetaConsole comment test` anywhere the integration can already see
(easiest: inside the same workspace area as the campaigns board), and share it with the MetaConsole
integration. **Do not use a client campaign card for this test.**

- [ ] **Step 2: Attempt a comment insert**

Write `/tmp/verify_comment.ts` on the droplet:

```typescript
import { createDecipheriv } from "node:crypto";

function dec(blob: string, keyHex: string): string {
  const [iv, tag, ct] = blob.split(".");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

const token = dec(process.env.ENC!, process.env.APP_ENCRYPTION_KEY!);
const res = await fetch("https://api.notion.com/v1/comments", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2025-09-03",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    parent: { page_id: process.env.TEST_PAGE_ID },
    rich_text: [{ type: "text", text: { content: "MetaConsole capability check — safe to delete." } }],
  }),
});
console.log(res.status, (await res.text()).slice(0, 300));
```

Run it:

```bash
ssh -i C:/Users/shikh/.ssh/id_ed25519 root@159.65.110.111 \
  'cd /opt/meta-dashboard && set -a && . ./.env && set +a \
   && export ENC=$(psql "$DATABASE_URL" -At -c "select notion_token_enc from meta_credentials where id='"'"'singleton'"'"'") \
   && export TEST_PAGE_ID=<the page id> \
   && bun /tmp/verify_comment.ts'
```

Expected on success: `200` and a JSON body whose `object` is `comment`.

- [ ] **Step 3: If it returns 403, stop and fix the capability**

A `403` with `insufficient permissions` means the integration lacks **Insert comments**. Enable it at
Notion → Settings → Connections → MetaConsole → Capabilities → *Insert comments*, then re-run Step 2.
**Do not proceed past this task until Step 2 returns `200`** — every later task assumes comment writes
work, and the feature has no fallback.

- [ ] **Step 4: Clean up**

Delete the test comment and the throwaway page. Delete `/tmp/verify_comment.ts`.

---

## Task 1: Time helpers, the question catalogue and the prompt vocabulary

> **Revised twice on 2026-08-13**, after two rounds of mutation-tested code review. Every change
> below was verified by measurement — do not "restore" the older shapes:
> 1. The Berlin/label helpers moved to their own module. They are generic calendar plumbing that
>    would read identically in a module about invoices, and every other module in `src/lib` is one
>    concept plus one test file (`delivery-status.ts` 101 lines, `range.ts` 131, `creative-links.ts`
>    118, largest 196). Leaving them here put `checkin.ts` on course for ~275 lines over four
>    concerns.
> 2. `previousDate` is **deleted, not moved**: `addDays(date, n)` in `src/lib/range.ts:47` already
>    does it and is already used by four call sites. Task 11 calls `addDays(date, -1)`.
> 3. `hourCycle: "h23"` replaces `hour12: false` + `% 24`. Measured on this runtime:
>    `hour12: false` already resolves to `h23`, so the modulo was unreachable dead code with a
>    three-line comment; ECMA-402 lets `hour12` override `hourCycle`, so the two cannot be combined.
>    Under a forced `h24` cycle Berlin midnight really does format as hour `"24"` with the date
>    already rolled over, so the hazard is real — it is now prevented at the formatter instead of
>    patched after it.
> 4. `dayLabel` is **not in this task at all** — it moved to `checkin-render.ts` (Task 3). It uses
>    neither Berlin nor a clock: it is a `YYYY-MM-DD` → display-string formatter for the top of the
>    buyer's Telegram message, i.e. presentation. It also gained a malformed-input guard, because
>    without one `dayLabel("garbage")` returns the literal string `"undefined NaN undefined"`
>    (measured) — `DAYS[NaN]` types as `string` while evaluating to `undefined` since this project
>    does not enable `noUncheckedIndexedAccess`.
> 5. The formatter is built **per call inside `berlinNow`**, not hoisted to a module const. An
>    import-time formatter cannot observe a `process.env.TZ` change, which made the hostile-timezone
>    test inert: mutation-testing showed the dropped-`timeZone` mutant surviving 7 of 7.
> 6. `withTZ` in the test file restores a **concrete zone name**. `process.env.TZ` is unset under
>    `bun test`, and assigning `undefined` to a `process.env` key stores the string `"undefined"`,
>    leaving ICU pinned to the hostile zone for the rest of the process — measured leaking across
>    test files.

**Files:**
- Create: `src/lib/berlin-time.ts`
- Create: `src/lib/berlin-time.test.ts`
- Create: `src/lib/checkin.ts`
- Create: `src/lib/checkin.test.ts`

- [ ] **Step 1: Write the failing time-helper tests**

Create `src/lib/berlin-time.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { berlinNow } from "./berlin-time";

/**
 * Run `fn` as if the process were in `tz`, then restore.
 *
 * Restores a CONCRETE zone name. `process.env.TZ` is unset by default under `bun test`, and
 * assigning `undefined` to a `process.env` key stores the literal string `"undefined"` instead of
 * deleting it, which leaves ICU pinned to the hostile zone for the rest of the process — measured
 * leaking across test files. `delete process.env.TZ` clears the key but also leaves ICU hostile.
 *
 * Only objects constructed AFTER the flip observe it, so the function under test must build its own
 * `Date`/`Intl` internally for a probe like this to mean anything.
 */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

test("converts UTC to Berlin wall clock in summer", () => {
  // 2026-08-13 15:30Z is 17:30 CEST.
  expect(berlinNow(new Date("2026-08-13T15:30:00Z"))).toEqual({ date: "2026-08-13", hour: 17 });
});

test("converts UTC to Berlin wall clock in winter", () => {
  // 2026-01-13 16:30Z is 17:30 CET — an hour of offset difference from the summer case, so a
  // hard-coded +2 cannot satisfy both tests.
  expect(berlinNow(new Date("2026-01-13T16:30:00Z"))).toEqual({ date: "2026-01-13", hour: 17 });
});

test("reports Berlin midnight as hour 0 of the NEXT date", () => {
  // 22:00Z in summer is 00:00 Berlin the following day. An h24 hour cycle would say "24" here and
  // leave every `hour >= CHECKIN_HOUR` gate true all night.
  expect(berlinNow(new Date("2026-08-12T22:00:00Z"))).toEqual({ date: "2026-08-13", hour: 0 });
});

test("does not reach the prompt hour one minute early", () => {
  // 14:59Z summer is 16:59 Berlin: the 17:00 gate must still be shut.
  expect(berlinNow(new Date("2026-08-13T14:59:00Z")).hour).toBe(16);
});

test("berlinNow ignores the process timezone", () => {
  // Bites only because berlinNow builds its formatter per call: an import-time formatter cannot
  // observe this flip, and a dropped `timeZone: "Europe/Berlin"` would survive the mutation.
  const hostile = withTZ("Pacific/Kiritimati", () => berlinNow(new Date("2026-08-13T15:30:00Z")));
  expect(hostile).toEqual({ date: "2026-08-13", hour: 17 });
});

```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test src/lib/berlin-time.test.ts`

Expected: FAIL — `Cannot find module './berlin-time'`.

- [ ] **Step 3: Write the time helpers**

Create `src/lib/berlin-time.ts`:

```typescript
/**
 * Berlin wall-clock helpers.
 *
 * Deliberately NOT in `checkin.ts`: nothing here knows what a check-in is, and the next consumer
 * will look for these beside the other date helpers rather than inside a feature module.
 */

export interface LocalNow {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Local hour, 0-23. */
  hour: number;
}

/**
 * Formatter options. The formatter itself is constructed per call inside `berlinNow`, NOT hoisted:
 * an import-time formatter cannot observe a `process.env.TZ` change, which makes the hostile-timezone
 * test inert (mutation-proven: the dropped-`timeZone` mutant survived 7 of 7). This runs about twice
 * a minute, so the construction cost is irrelevant, and `format.ts` already builds `Intl` per call.
 *
 * `hourCycle: "h23"` asks ICU for the 0-23 cycle explicitly. Do NOT swap it for `hour12: false`:
 * ECMA-402 lets `hour12` override `hourCycle`, and an `h24` cycle renders Berlin midnight as hour
 * "24" (measured) with the date already rolled forward, which would leave an
 * `hour >= CHECKIN_HOUR` gate true all night.
 */
const BERLIN_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
};

/**
 * Berlin wall-clock date and hour for an instant. "17:00 CET" means 17:00 local, so this follows
 * DST: 15:00 UTC in summer, 16:00 UTC in winter.
 *
 * Throws on a missing part rather than returning a silent `NaN` hour. This project does not enable
 * `noUncheckedIndexedAccess`, so a dropped field would otherwise yield `hour: NaN`, and
 * `NaN >= CHECKIN_HOUR` is false forever — a check-in that never fires and never complains.
 */
export function berlinNow(at: Date): LocalNow {
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  let hour: string | undefined;
  for (const p of new Intl.DateTimeFormat("en-CA", BERLIN_OPTIONS).formatToParts(at)) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
    else if (p.type === "hour") hour = p.value;
  }
  if (!year || !month || !day || hour === undefined) {
    throw new Error("berlinNow: Intl returned no Berlin date parts");
  }
  return { date: `${year}-${month}-${day}`, hour: Number(hour) };
}
```

- [ ] **Step 4: Run the time-helper tests**

Run: `bun test src/lib/berlin-time.test.ts`

Expected: PASS, 5 tests. (`dayLabel` is not here — it is presentation, uses neither Berlin nor a
clock, and belongs with the other renderers in Task 3.)

- [ ] **Step 5: Write the failing decision-core tests**

Create `src/lib/checkin.test.ts`:

```typescript
import { test, expect } from "bun:test";
import {
  CHECKIN_QUESTIONS,
  questionFor,
  isCheckinStatus,
  CHECKIN_HOUR,
  ESCALATION_HOUR,
} from "./checkin";
import { MACHINE_STATUSES } from "./delivery-status";

test("every machine-owned status has a question", () => {
  // `satisfies` already enforces this at compile time; asserted at runtime too so loosening the
  // type does not silently produce campaigns nobody is ever asked about.
  for (const s of MACHINE_STATUSES) expect(questionFor(s)).toBeTruthy();
});

test("On Boarding is asked even though it is human-owned", () => {
  expect(questionFor("On Boarding")).toBe("What's still outstanding before launch?");
});

test("statuses outside the check-in set are not asked", () => {
  expect(questionFor("Full Budget Finished")).toBeNull();
  expect(questionFor("Not started")).toBeNull();
  expect(questionFor(null)).toBeNull();
  expect(questionFor("")).toBeNull();
});

test("inherited Object members are not mistaken for statuses", () => {
  // Statuses arrive as untrusted strings from Notion; a bare index read would hand back inherited
  // functions and break the declared string | null contract.
  expect(questionFor("toString")).toBeNull();
  expect(questionFor("constructor")).toBeNull();
  expect(questionFor("hasOwnProperty")).toBeNull();
});

test("isCheckinStatus recognises exactly the six in-scope statuses", () => {
  // `Object.keys(X).every(isCheckinStatus)` would be tautological — isCheckinStatus IS hasOwn over
  // that same object — and the six-value assertion lives in the next test.
  expect(isCheckinStatus("Live")).toBe(true);
  expect(isCheckinStatus("Not started")).toBe(false);
  expect(isCheckinStatus(null)).toBe(false);
});

test("the status set is exactly the six agreed values", () => {
  expect(Object.keys(CHECKIN_QUESTIONS).sort()).toEqual(
    [
      "Ad Account Blocked",
      "Ad Account Disabled",
      "All ads rejected",
      "Live",
      "On Boarding",
      "Paused",
    ].sort(),
  );
});

test("the gate hours are the agreed ones", () => {
  expect(CHECKIN_HOUR).toBe(17);
  expect(ESCALATION_HOUR).toBe(9);
});
```

- [ ] **Step 6: Run the tests and watch them fail**

Run: `bun test src/lib/checkin.test.ts`

Expected: FAIL — `Cannot find module './checkin'`.

- [ ] **Step 7: Write the decision core**

Create `src/lib/checkin.ts`:

```typescript
/**
 * Pure decision core of the daily media-buyer check-in: which campaigns are asked about, who is
 * asked, and what they are asked.
 *
 * No database, no network, no clock — the caller supplies rows, buyers and a time. Berlin wall-clock
 * helpers live in `berlin-time.ts`; Telegram/Notion rendering lives in `checkin-render.ts`. The only
 * import here is type-only, so this module has no runtime dependencies at all.
 */
import type { MachineStatus } from "./delivery-status";

/** The prompt fires at this Europe/Berlin hour. */
export const CHECKIN_HOUR = 17;
/** Unanswered prompts are escalated at this Europe/Berlin hour the NEXT day. */
export const ESCALATION_HOUR = 9;

/**
 * One question per status: the five machine-owned delivery states from `delivery-status.ts`, plus
 * the human-owned `On Boarding` on the operator's instruction.
 *
 * `as const satisfies Record<MachineStatus | "On Boarding", string>` earns three things a
 * `Record<string, string>` annotation cannot: the compiler rejects a missing machine status, the
 * compiler rejects mutating it (`as const` is compile-time only; nothing is frozen at runtime), and
 * `CheckinStatus` below becomes a usable union instead of bare `string`.
 *
 * A status absent from this map is NOT prompted (see `questionFor`) — a default question would ask a
 * finished engagement for a daily update.
 */
export const CHECKIN_QUESTIONS = {
  Live: "Any changes today — budget, creatives, targeting?",
  Paused: "Why is it paused, and when does it resume?",
  "Ad Account Disabled": "What's the recovery plan — is a replacement account lined up?",
  "Ad Account Blocked": "Funding/top-up status — when does delivery resume?",
  "All ads rejected": "What's the fix — new creatives or an appeal?",
  "On Boarding": "What's still outstanding before launch?",
} as const satisfies Record<MachineStatus | "On Boarding", string>;

/** The statuses the check-in asks about. */
export type CheckinStatus = keyof typeof CHECKIN_QUESTIONS;

/** The lifecycle of one prompt; mirrored by `checkin_prompts.state` in the database. */
export type PromptState =
  | "pending"
  | "awaiting_reply"
  | "answered"
  | "no_changes"
  | "escalated"
  | "unroutable";

/** Narrows an untrusted board status to one the check-in asks about. */
export function isCheckinStatus(status: string | null | undefined): status is CheckinStatus {
  return status != null && Object.hasOwn(CHECKIN_QUESTIONS, status);
}

/** The question for a status, or null when the status is out of scope for the check-in. */
export function questionFor(status: string | null | undefined): string | null {
  return isCheckinStatus(status) ? CHECKIN_QUESTIONS[status] : null;
}
```

- [ ] **Step 8: Run both test files and the typecheck**

Run: `bun test src/lib/checkin.test.ts src/lib/berlin-time.test.ts && bunx tsc --noEmit`

Expected: PASS, 12 tests total (5 berlin-time + 7 checkin); typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add src/lib/berlin-time.ts src/lib/berlin-time.test.ts src/lib/checkin.ts src/lib/checkin.test.ts
git commit -m "feat(checkin): Berlin time helpers, question catalogue and prompt vocabulary"
```

## Task 2: The prompt planner

**Files:**
- Modify: `src/lib/checkin.ts`
- Modify: `src/lib/checkin.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/checkin.test.ts`:

```typescript
import { planPrompts, type CheckinBoardRow, type CheckinBuyer } from "./checkin";

const VLAD = "2cbd872b-594c-8119-9649-0002845d8d9c";
const SHIKHAR = "254d872b-594c-8154-9479-000271904e5b";
const SOFIA = "28cd872b-594c-81ff-af89-0002cb38d0f7";

const buyers: CheckinBuyer[] = [
  { personId: SHIKHAR, displayName: "Shikhar Gupta", chatId: "111", active: true },
  { personId: VLAD, displayName: "Vladyslav Istrati", chatId: "222", active: true },
];

const row = (o: Partial<CheckinBoardRow> = {}): CheckinBoardRow => ({
  pageId: o.pageId ?? "p1",
  title: o.title ?? "Slots.lv",
  // `?? "Live"` cannot distinguish an explicit null from an absent key, which would silently turn
  // `row({ status: null })` into a Live row and make the out-of-scope test assert nothing.
  status: "status" in o ? (o.status ?? null) : "Live",
  ownerIds: o.ownerIds ?? [SHIKHAR],
});

test("a live row owned by a buyer produces one prompt", () => {
  const plans = planPrompts([row()], buyers);
  expect(plans).toHaveLength(1);
  expect(plans[0]).toEqual({
    notionPageId: "p1",
    campaignTitle: "Slots.lv",
    status: "Live",
    buyerPersonId: SHIKHAR,
    chatId: "111",
    question: "Any changes today — budget, creatives, targeting?",
  });
});

test("out-of-scope statuses produce nothing", () => {
  expect(planPrompts([row({ status: "Full Budget Finished" })], buyers)).toEqual([]);
  expect(planPrompts([row({ status: null })], buyers)).toEqual([]);
});

test("non-buyer owners are ignored", () => {
  // Sofia, Nick, Abel and Elad own rows but are not media buyers.
  expect(planPrompts([row({ ownerIds: [SOFIA] })], buyers)).toEqual([]);
});

test("a row with no owners produces nothing", () => {
  expect(planPrompts([row({ ownerIds: [] })], buyers)).toEqual([]);
});

test("a row owned by both buyers prompts both", () => {
  const plans = planPrompts([row({ ownerIds: [SHIKHAR, VLAD] })], buyers);
  expect(plans.map((p) => p.buyerPersonId).sort()).toEqual([SHIKHAR, VLAD].sort());
});

test("an inactive buyer is skipped", () => {
  const inactive = [{ ...buyers[0], active: false }, buyers[1]];
  expect(planPrompts([row({ ownerIds: [SHIKHAR] })], inactive)).toEqual([]);
});

test("a buyer with no bound chat is still planned, with a null chat", () => {
  // Planned rather than dropped so the 09:00 escalation can name the binding gap.
  const unbound = [{ ...buyers[0], chatId: null }];
  const plans = planPrompts([row()], unbound);
  expect(plans).toHaveLength(1);
  expect(plans[0].chatId).toBeNull();
});

test("the same page listed twice yields one prompt per buyer", () => {
  // A page can appear under more than one client snapshot; a duplicate prompt would double-comment.
  const plans = planPrompts([row(), row()], buyers);
  expect(plans).toHaveLength(1);
});

test("prompts are ordered by campaign title so the message is stable", () => {
  const plans = planPrompts(
    [
      row({ pageId: "p2", title: "Zebra", ownerIds: [SHIKHAR] }),
      row({ pageId: "p3", title: "Alpha", ownerIds: [SHIKHAR] }),
    ],
    buyers,
  );
  expect(plans.map((p) => p.campaignTitle)).toEqual(["Alpha", "Zebra"]);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test src/lib/checkin.test.ts`

Expected: FAIL — `planPrompts is not a function` / no exported member.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/checkin.ts`:

```typescript
/** One board row as the planner needs it: its own status and its Notion `Owners` person ids. */
export interface CheckinBoardRow {
  pageId: string;
  title: string;
  status: string | null;
  ownerIds: string[];
}

/** A media buyer. Membership in this list is what makes someone a media buyer — it is DB data. */
export interface CheckinBuyer {
  personId: string;
  displayName: string;
  /** Null until an admin binds their Telegram chat. */
  chatId: string | null;
  active: boolean;
}

export interface PlannedPrompt {
  notionPageId: string;
  campaignTitle: string;
  /** Narrowed by `isCheckinStatus`, so a prompt can only ever carry an in-scope status. */
  status: CheckinStatus;
  buyerPersonId: string;
  chatId: string | null;
  question: string;
}

/**
 * One prompt per (row, media-buyer owner) for rows whose status is in scope.
 *
 * Rows are de-duplicated by page id: the same board page can appear in more than one client
 * snapshot, and a duplicate would write two comments for one answer. An unbound buyer is still
 * planned (with `chatId: null`) so the escalation can name the missing binding instead of the row
 * disappearing silently.
 */
export function planPrompts(rows: CheckinBoardRow[], buyers: CheckinBuyer[]): PlannedPrompt[] {
  const byPerson = new Map(buyers.filter((b) => b.active).map((b) => [b.personId, b]));
  const seen = new Set<string>();
  const out: PlannedPrompt[] = [];

  const ordered = [...rows].sort((a, b) => a.title.localeCompare(b.title));
  for (const row of ordered) {
    // Narrow rather than lookup-then-null-check: this is what lets `PlannedPrompt.status` be the
    // `CheckinStatus` union instead of bare `string`, all the way through to the database write.
    if (!isCheckinStatus(row.status)) continue;
    const question = CHECKIN_QUESTIONS[row.status];
    for (const ownerId of row.ownerIds) {
      const buyer = byPerson.get(ownerId);
      if (!buyer) continue;
      const key = `${row.pageId}:${ownerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        notionPageId: row.pageId,
        campaignTitle: row.title,
        status: row.status,
        buyerPersonId: buyer.personId,
        chatId: buyer.chatId,
        question,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/lib/checkin.test.ts`

Expected: PASS, 16 tests (7 from Task 1 plus the 9 planner tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/checkin.ts src/lib/checkin.test.ts
git commit -m "feat(checkin): plan one prompt per campaign per owning media buyer"
```

---

## Task 3: Message, comment and callback rendering

**Files:**
- Create: `src/lib/checkin-render.ts`
- Create: `src/lib/checkin-render.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/checkin-render.test.ts`:

> Its own module rather than more of `checkin.ts`: these ~120 lines are presentation for two
> different external systems — Telegram `callback_data` plus inline keyboards, and Notion `rich_text`
> chunking — while `checkin.ts` decides who is asked what. Both stay pure, and downstream tasks only
> change which module name they import from.

```typescript
import { test, expect } from "bun:test";
import {
  callbackData,
  parseCallback,
  renderList,
  forceReplyText,
  commentBody,
  escalationText,
  NOTION_TEXT_LIMIT,
  type ListItem,
  dayLabel,
} from "./checkin-render";

/**
 * Run `fn` as if the process were in `tz`, then restore.
 *
 * Restores a CONCRETE zone name: `process.env.TZ` is unset under `bun test`, and assigning
 * `undefined` to a `process.env` key stores the literal string `"undefined"`, which leaves ICU
 * pinned to the hostile zone for the rest of the process.
 */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

test("dayLabel formats a date as 'Thu 13 Aug'", () => {
  expect(dayLabel("2026-08-13")).toBe("Thu 13 Aug");
  expect(dayLabel("2026-08-03")).toBe("Mon 03 Aug");
  expect(dayLabel("2026-01-01")).toBe("Thu 01 Jan");
});

test("dayLabel ignores the process timezone", () => {
  // The Pacific/Midway (UTC-11) case is the one that bites: it is what fails if the UTC getters are
  // ever swapped for local ones. UTC+14 does not shift a 00:00Z date at all.
  expect(withTZ("Pacific/Kiritimati", () => dayLabel("2026-08-13"))).toBe("Thu 13 Aug");
  expect(withTZ("Pacific/Midway", () => dayLabel("2026-08-13"))).toBe("Thu 13 Aug");
});

test("dayLabel refuses a malformed date instead of rendering garbage", () => {
  // Without the guard these return the literal string "undefined NaN undefined", which this
  // function's own docstring would put at the top of the buyer's daily message.
  for (const bad of ["garbage", "", "2026-13-45", "2026-8-3"]) {
    expect(() => dayLabel(bad)).toThrow("not a YYYY-MM-DD date");
  }
});

const items: ListItem[] = [
  { promptId: 7, title: "Slots.lv", status: "Live", question: "Any changes today?", state: "pending" },
  {
    promptId: 8,
    title: "Lucky Rebel",
    status: "Ad Account Blocked",
    question: "Funding/top-up status?",
    state: "pending",
  },
];

test("callback data round-trips and stays within Telegram's 64-byte limit", () => {
  expect(callbackData("no_changes", 7)).toBe("nc:7");
  expect(callbackData("update", 7)).toBe("up:7");
  expect(parseCallback("nc:7")).toEqual({ action: "no_changes", promptId: 7 });
  expect(parseCallback("up:12345")).toEqual({ action: "update", promptId: 12345 });
  expect(Buffer.byteLength(callbackData("no_changes", 2_000_000_000))).toBeLessThan(64);
});

test("malformed callback data is rejected rather than guessed", () => {
  expect(parseCallback("")).toBeNull();
  expect(parseCallback("xx:7")).toBeNull();
  expect(parseCallback("nc:")).toBeNull();
  expect(parseCallback("nc:abc")).toBeNull();
  expect(parseCallback("nc:7:8")).toBeNull();
});

test("the daily list numbers campaigns and pairs each with two buttons", () => {
  const { text, keyboard } = renderList("Thu 13 Aug", items);
  expect(text).toContain("🕔 Daily check-in — Thu 13 Aug");
  expect(text).toContain("1. Slots.lv — Live");
  expect(text).toContain("2. Lucky Rebel — Ad Account Blocked");
  expect(keyboard).toEqual([
    [
      { text: "✅ No changes · 1", callback_data: "nc:7" },
      { text: "✍️ Update · 1", callback_data: "up:7" },
    ],
    [
      { text: "✅ No changes · 2", callback_data: "nc:8" },
      { text: "✍️ Update · 2", callback_data: "up:8" },
    ],
  ]);
});

test("closed campaigns keep their number, show a marker and lose their buttons", () => {
  const { text, keyboard } = renderList("Thu 13 Aug", [
    { ...items[0], state: "no_changes" },
    { ...items[1], state: "answered" },
  ]);
  expect(text).toContain("1. ✅ Slots.lv");
  expect(text).toContain("2. ✍️ Lucky Rebel");
  expect(keyboard).toEqual([]);
});

test("an awaiting_reply campaign still offers no changes but not a second update prompt", () => {
  const { keyboard } = renderList("Thu 13 Aug", [{ ...items[0], state: "awaiting_reply" }]);
  expect(keyboard).toEqual([[{ text: "✅ No changes · 1", callback_data: "nc:7" }]]);
});

test("the force-reply prompt names the campaign and asks for a reply", () => {
  expect(forceReplyText({ title: "Slots.lv", status: "Live", question: "Any changes today?" })).toBe(
    "✍️ Update for Slots.lv (Live)\nAny changes today?\n↩️ Reply to this message.",
  );
});

test("the comment body carries date, buyer, status, question and answer", () => {
  expect(
    commentBody({
      date: "2026-08-13",
      buyerName: "Shikhar Gupta",
      status: "Ad Account Blocked",
      question: "Funding/top-up status?",
      answer: "Topped up $2k, delivery resumes tonight.",
    }),
  ).toEqual([
    "🤖 Daily check-in · 2026-08-13 · Shikhar Gupta\n" +
      "Status: Ad Account Blocked\n" +
      "Q: Funding/top-up status?\n" +
      "A: Topped up $2k, delivery resumes tonight.",
  ]);
});

test("a long answer splits into chunks instead of being truncated", () => {
  const answer = "x".repeat(2500);
  const chunks = commentBody({
    date: "2026-08-13",
    buyerName: "Vladyslav Istrati",
    status: "Live",
    question: "Any changes today?",
    answer,
  });
  expect(chunks.length).toBe(2);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(NOTION_TEXT_LIMIT);
  // Nothing is lost: every character of the answer survives the split.
  expect(chunks.join("").endsWith("x".repeat(50))).toBe(true);
  expect(chunks.join("").match(/x/g)?.length).toBe(2500);
});

test("the escalation message groups unanswered campaigns by buyer and names binding gaps", () => {
  const text = escalationText("2026-08-13", [
    { buyerName: "Shikhar Gupta", titles: ["Slots.lv", "Lucky Rebel"], unroutable: false },
    { buyerName: "Vladyslav Istrati", titles: ["CasinOK.com"], unroutable: true },
  ]);
  expect(text).toContain("⚠️ Check-in 2026-08-13 — 3 campaigns unanswered");
  expect(text).toContain("Shikhar Gupta: Slots.lv, Lucky Rebel");
  expect(text).toContain("Vladyslav Istrati (no Telegram binding): CasinOK.com");
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test src/lib/checkin-render.test.ts`

Expected: FAIL — `Cannot find module './checkin-render'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/checkin-render.ts`:

```typescript
/**
 * Presentation for the daily check-in: the buyer's Telegram list, the force-reply prompt, the
 * callback encoding, and the Notion comment body.
 *
 * Pure, like `checkin.ts`, but a separate module because it renders for two external systems rather
 * than deciding anything. `PromptState` is imported rather than redeclared — the prompt lifecycle is
 * core vocabulary and the database column mirrors it.
 */
import type { PromptState } from "./checkin";

/** Notion rejects a `rich_text` item over 2000 characters. */
export const NOTION_TEXT_LIMIT = 2000;

export type CallbackAction = "no_changes" | "update";

const ACTION_PREFIX: Record<CallbackAction, string> = { no_changes: "nc", update: "up" };

/** Telegram caps `callback_data` at 64 bytes, so prompts are addressed by integer id. */
export function callbackData(action: CallbackAction, promptId: number): string {
  return `${ACTION_PREFIX[action]}:${promptId}`;
}

export function parseCallback(data: string): { action: CallbackAction; promptId: number } | null {
  const parts = data.split(":");
  if (parts.length !== 2) return null;
  const [prefix, raw] = parts;
  const action = (Object.keys(ACTION_PREFIX) as CallbackAction[]).find(
    (a) => ACTION_PREFIX[a] === prefix,
  );
  if (!action) return null;
  if (!/^\d+$/.test(raw)) return null;
  return { action, promptId: Number(raw) };
}

export interface ListItem {
  promptId: number;
  title: string;
  status: string;
  question: string;
  state: PromptState;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface RenderedList {
  text: string;
  keyboard: InlineButton[][];
}

const STATE_MARKER: Partial<Record<PromptState, string>> = {
  no_changes: "✅",
  answered: "✍️",
  escalated: "⏭️",
};

/**
 * The buyer's daily list, re-rendered after every state change so a tap visibly registers.
 *
 * Numbers are stable across re-renders and button labels carry the number rather than the campaign
 * title — titles on this board reach 40+ characters (`fortunegalaxy.io   Palmluck (26 May 2026)`),
 * which no button label can show.
 */
export function renderList(dateLabel: string, items: ListItem[]): RenderedList {
  const lines = [`🕔 Daily check-in — ${dateLabel}`, ""];
  const keyboard: InlineButton[][] = [];

  items.forEach((item, i) => {
    const n = i + 1;
    const marker = STATE_MARKER[item.state];
    lines.push(`${n}. ${marker ? `${marker} ` : ""}${item.title} — ${item.status}`);
    if (!marker) lines.push(`   ${item.question}`);

    const row: InlineButton[] = [];
    if (item.state === "pending" || item.state === "awaiting_reply") {
      row.push({ text: `✅ No changes · ${n}`, callback_data: callbackData("no_changes", item.promptId) });
    }
    if (item.state === "pending") {
      row.push({ text: `✍️ Update · ${n}`, callback_data: callbackData("update", item.promptId) });
    }
    if (row.length) keyboard.push(row);
  });

  return { text: lines.join("\n"), keyboard };
}

/** The `force_reply` message. Its `message_id` is what binds a typed answer to a campaign. */
export function forceReplyText(input: { title: string; status: string; question: string }): string {
  return `✍️ Update for ${input.title} (${input.status})\n${input.question}\n↩️ Reply to this message.`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Thu 13 Aug" from a YYYY-MM-DD date, for the top of the buyer's daily Telegram message.
 *
 * Table lookup on UTC fields rather than a locale format: `en-GB` returns "Thu, 13 Aug" and would
 * need its comma stripped, buying a dependency on ICU never reordering the fields. (`shortDay` in
 * `src/portal/mock.ts` avoids `Date` entirely by splitting the string; this needs the weekday, which
 * only a `Date` can give.)
 *
 * Throws rather than rendering `"undefined NaN undefined"`: `DAYS[NaN]` types as `string` while
 * evaluating to `undefined`, because this project does not enable `noUncheckedIndexedAccess`.
 */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`dayLabel: not a YYYY-MM-DD date: ${date}`);
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${day} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * The Notion comment, split into `rich_text`-sized chunks.
 *
 * The buyer's name is in the body because the comment's AUTHOR is the integration, not the human —
 * without this the board would show a wall of identical robot authorship.
 */
export function commentBody(input: {
  date: string;
  buyerName: string;
  status: string;
  question: string;
  answer: string;
}): string[] {
  const full =
    `🤖 Daily check-in · ${input.date} · ${input.buyerName}\n` +
    `Status: ${input.status}\n` +
    `Q: ${input.question}\n` +
    `A: ${input.answer}`;
  const chunks: string[] = [];
  for (let i = 0; i < full.length; i += NOTION_TEXT_LIMIT) {
    chunks.push(full.slice(i, i + NOTION_TEXT_LIMIT));
  }
  return chunks;
}

/** The 09:00 escalation posted to the shared alert channel. */
export function escalationText(
  date: string,
  groups: { buyerName: string; titles: string[]; unroutable: boolean }[],
): string {
  const total = groups.reduce((n, g) => n + g.titles.length, 0);
  const lines = [`⚠️ Check-in ${date} — ${total} campaign${total === 1 ? "" : "s"} unanswered`];
  for (const g of groups) {
    const who = g.unroutable ? `${g.buyerName} (no Telegram binding)` : g.buyerName;
    lines.push(`${who}: ${g.titles.join(", ")}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/lib/checkin-render.test.ts`

Expected: PASS, 12 tests in the new file. Then run
`bun test src/lib/checkin.test.ts src/lib/berlin-time.test.ts src/lib/checkin-render.test.ts` and
confirm 33 pass (5 berlin-time + 16 checkin + 12 render). Do NOT expect `bun test src/lib` to be
clean — it includes the pre-existing flaky DB-backed tests noted in the conventions above.

- [ ] **Step 5: Commit**

```bash
git add src/lib/checkin-render.ts src/lib/checkin-render.test.ts
git commit -m "feat(checkin): render the daily list, force-reply prompt and Notion comment"
```

---

## Task 4: Database tables

**Files:**
- Modify: `src/db/schema.ts`
- Applied with: `bun run db:push`

- [ ] **Step 1: Add the tables**

Append to `src/db/schema.ts` (the file already imports `pgTable`, `text`, `integer`, `bigint`,
`timestamp`, `date`, `boolean`, `serial` is NOT imported — add it to the import list at line 1):

```typescript
// Telegram chats the bot has seen, so an admin can bind one to a media buyer in Settings. Discovery
// only: being here grants nothing. Chat ids are text — Telegram ids exceed 32-bit.
export const telegramChats = pgTable("telegram_chats", {
  chatId: text("chat_id").primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// Membership here is what makes someone a media buyer: the daily check-in prompts exactly these
// people, matched against the Notion `Owners` people property by PERSON ID (display names drift).
// A third buyer is therefore a Settings action, not a deploy.
export const mediaBuyers = pgTable("media_buyers", {
  notionPersonId: text("notion_person_id").primaryKey(),
  displayName: text("display_name").notNull(),
  telegramChatId: text("telegram_chat_id"), // null = unroutable; prompts are still recorded
  active: boolean("active").notNull().default(true),
  boundBy: text("bound_by"),
  boundAt: timestamp("bound_at", { withTimezone: true }),
});

// One row per (local date, board page, buyer). The unique index is what makes the 17:00 job
// idempotent: a worker restart inside the same minute cannot double-prompt.
export const checkinPrompts = pgTable(
  "checkin_prompts",
  {
    id: serial("id").primaryKey(),
    promptDate: date("prompt_date").notNull(),
    notionPageId: text("notion_page_id").notNull(),
    campaignTitle: text("campaign_title").notNull(),
    status: text("status").notNull(), // snapshotted: the status at prompt time
    buyerPersonId: text("buyer_person_id").notNull(),
    chatId: text("chat_id"),
    question: text("question").notNull(), // snapshotted, so re-wording never rewrites history
    listMessageId: text("list_message_id"), // the buyer's daily list, for re-rendering
    replyMessageId: text("reply_message_id"), // the force_reply message an answer replies to
    state: text("state").notNull().default("pending"),
    answerText: text("answer_text"), // stored BEFORE the Notion write, so an answer is never lost
    notionCommentId: text("notion_comment_id"), // null while state=answered means a retry is owed
    note: text("note"), // last error (send failure, comment failure)
    commentAttempts: integer("comment_attempts").notNull().default(0), // stops an unwritable comment retrying forever
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("checkin_prompts_day_page_buyer_idx").on(
      t.promptDate,
      t.notionPageId,
      t.buyerPersonId,
    ),
    index("checkin_prompts_reply_idx").on(t.chatId, t.replyMessageId),
    index("checkin_prompts_state_idx").on(t.state),
  ],
);

// Makes both time gates idempotent. Without it the 17:00 gate would re-plan every poll iteration on
// a day with zero in-scope rows, because "no prompts exist" is indistinguishable from "not planned".
export const checkinRuns = pgTable("checkin_runs", {
  runDate: date("run_date").primaryKey(),
  plannedAt: timestamp("planned_at", { withTimezone: true }),
  promptsCreated: integer("prompts_created").notNull().default(0),
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),
});

// The getUpdates cursor. `sync_state` is keyed per ad account and cannot hold this.
export const telegramState = pgTable("telegram_state", {
  id: text("id").primaryKey().default("singleton"),
  updateOffset: bigint("update_offset", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Update the import at the top of the file to include `serial` and `uniqueIndex`:

```typescript
import {
  pgTable,
  text,
  bigint,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  date,
  boolean,
  primaryKey,
  index,
  serial,
  uniqueIndex,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Push the schema**

First confirm `DATABASE_URL` is available (`grep -c DATABASE_URL .env`; copy `.env` from the main
checkout if the worktree lacks it).

Run: `bun run db:push`

Expected: drizzle prints the statements it intends to run. **Read them before confirming.** They must
be purely additive — five `CREATE TABLE` statements plus `CREATE UNIQUE INDEX
"checkin_prompts_day_page_buyer_idx"` and the two secondary indexes. If drizzle proposes ANY
`DROP`, `ALTER ... DROP COLUMN` or table rename, abort and report: that means the schema file has
drifted from the live database (another session ships tables to this same schema), and pushing would
destroy their work.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`

Expected: no errors. (This project has no `typecheck` script; call `tsc` directly.)

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/migrations
git commit -m "feat(checkin): tables for prompts, buyers, chats, runs and poll offset"
```

---

## Task 5: Telegram client

**Files:**
- Create: `src/telegram/client.ts`
- Create: `src/telegram/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/telegram/client.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { TelegramClient } from "./client";

interface Call {
  url: string;
  body: unknown;
}

/** A fetch stand-in that records calls and replays queued responses. */
function recorder(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses[calls.length - 1] ?? { body: { ok: true, result: {} } };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("sendMessage posts the text and returns the new message id", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: { message_id: 42 } } }]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.sendMessage({ chatId: "111", text: "hello" });

  expect(res).toEqual({ ok: true, messageId: 42 });
  expect(calls[0].url).toBe("https://api.telegram.org/botTOK/sendMessage");
  expect(calls[0].body).toEqual({
    chat_id: "111",
    text: "hello",
    disable_web_page_preview: true,
  });
});

test("sendMessage attaches an inline keyboard when given one", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: { message_id: 1 } } }]);
  const tg = new TelegramClient("TOK", impl);

  await tg.sendMessage({
    chatId: "111",
    text: "list",
    keyboard: [[{ text: "✅", callback_data: "nc:1" }]],
  });

  expect(calls[0].body).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "✅", callback_data: "nc:1" }]] },
  });
});

test("sendMessage can request a forced reply", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: { message_id: 5 } } }]);
  const tg = new TelegramClient("TOK", impl);

  await tg.sendMessage({ chatId: "111", text: "update?", forceReply: true });

  expect(calls[0].body).toMatchObject({ reply_markup: { force_reply: true, selective: true } });
});

test("an API error is returned, never thrown", async () => {
  const { impl } = recorder([{ status: 400, body: { ok: false, description: "chat not found" } }]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.sendMessage({ chatId: "999", text: "hi" });

  expect(res.ok).toBe(false);
  expect(res.error).toContain("chat not found");
});

test("a rate limit surfaces retryAfter so the caller can back off", async () => {
  const { impl } = recorder([
    { status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } } },
  ]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.sendMessage({ chatId: "111", text: "hi" });

  expect(res.ok).toBe(false);
  expect(res.retryAfter).toBe(7);
});

test("a network failure is returned, never thrown", async () => {
  const impl = (async () => {
    throw new Error("socket hang up");
  }) as unknown as typeof fetch;
  const tg = new TelegramClient("TOK", impl);

  expect(await tg.sendMessage({ chatId: "1", text: "x" })).toEqual({
    ok: false,
    error: "socket hang up",
  });
});

test("getUpdates passes the offset and long-poll timeout and returns updates", async () => {
  const { calls, impl } = recorder([
    { body: { ok: true, result: [{ update_id: 10, message: { message_id: 1, chat: { id: 111 }, text: "hi" } }] } },
  ]);
  const tg = new TelegramClient("TOK", impl);

  const res = await tg.getUpdates({ offset: 9, timeoutSec: 30 });

  expect(calls[0].url).toBe("https://api.telegram.org/botTOK/getUpdates");
  expect(calls[0].body).toEqual({ offset: 9, timeout: 30, allowed_updates: ["message", "callback_query"] });
  expect(res.ok).toBe(true);
  expect(res.updates).toHaveLength(1);
  expect(res.updates[0].update_id).toBe(10);
});

test("editMessageText and answerCallbackQuery hit the right endpoints", async () => {
  const { calls, impl } = recorder([{ body: { ok: true, result: {} } }, { body: { ok: true, result: true } }]);
  const tg = new TelegramClient("TOK", impl);

  await tg.editMessageText({ chatId: "111", messageId: 42, text: "updated", keyboard: [] });
  await tg.answerCallbackQuery({ id: "cb1", text: "Logged" });

  expect(calls[0].url).toContain("/editMessageText");
  expect(calls[0].body).toMatchObject({ chat_id: "111", message_id: 42, text: "updated" });
  expect(calls[1].url).toContain("/answerCallbackQuery");
  expect(calls[1].body).toMatchObject({ callback_query_id: "cb1", text: "Logged" });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test src/telegram/client.test.ts`

Expected: FAIL — `Cannot find module './client'`.

- [ ] **Step 3: Write the implementation**

Create `src/telegram/client.ts`:

```typescript
// Minimal Telegram Bot API client (no SDK; four methods, fetch is enough).
// Mirrors NotionClient: injectable fetchImpl for tests, and it NEVER throws — every failure comes
// back as data, because a check-in send failure must not take down the sync worker's loop.
const BASE = "https://api.telegram.org";

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramChat {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramChat;
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from: TelegramChat;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface SendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  /** Seconds Telegram asked us to wait, when it answered 429. */
  retryAfter?: number;
}

export interface UpdatesResult {
  ok: boolean;
  updates: TelegramUpdate[];
  error?: string;
  retryAfter?: number;
}

interface ApiEnvelope {
  ok?: boolean;
  description?: string;
  result?: unknown;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string; retryAfter?: number }> {
    try {
      const res = await this.fetchImpl(`${BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as ApiEnvelope;
      if (!res.ok || body.ok === false) {
        return {
          ok: false,
          error: `Telegram ${res.status}: ${body.description ?? "request failed"}`,
          retryAfter: body.parameters?.retry_after,
        };
      }
      return { ok: true, result: body.result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    keyboard?: InlineButton[][];
    forceReply?: boolean;
  }): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
      disable_web_page_preview: true,
    };
    if (input.keyboard?.length) payload.reply_markup = { inline_keyboard: input.keyboard };
    else if (input.forceReply) payload.reply_markup = { force_reply: true, selective: true };

    const r = await this.call("sendMessage", payload);
    if (!r.ok) return { ok: false, error: r.error, retryAfter: r.retryAfter };
    const messageId = (r.result as { message_id?: number } | null)?.message_id;
    return { ok: true, messageId };
  }

  /** Re-render an existing message. An empty keyboard removes the buttons. */
  async editMessageText(input: {
    chatId: string;
    messageId: number;
    text: string;
    keyboard: InlineButton[][];
  }): Promise<SendResult> {
    const r = await this.call("editMessageText", {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: input.keyboard },
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error, retryAfter: r.retryAfter };
  }

  /** Must be called on every callback or the buyer's client spins for ~30s. */
  async answerCallbackQuery(input: { id: string; text?: string }): Promise<SendResult> {
    const r = await this.call("answerCallbackQuery", {
      callback_query_id: input.id,
      ...(input.text ? { text: input.text } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** Long-poll. `offset` must be lastSeenUpdateId + 1, persisted across restarts. */
  async getUpdates(input: { offset: number | null; timeoutSec: number }): Promise<UpdatesResult> {
    const r = await this.call("getUpdates", {
      ...(input.offset != null ? { offset: input.offset } : {}),
      timeout: input.timeoutSec,
      allowed_updates: ["message", "callback_query"],
    });
    if (!r.ok) return { ok: false, updates: [], error: r.error, retryAfter: r.retryAfter };
    return { ok: true, updates: (r.result as TelegramUpdate[] | null) ?? [] };
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/telegram/client.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/client.ts src/telegram/client.test.ts
git commit -m "feat(telegram): minimal bot client that never throws"
```

---

## Task 6: Route the existing alerts through the new client

One Telegram code path, not two. `src/sync/alerts.ts` currently builds its own `fetch` call.

**Files:**
- Modify: `src/sync/alerts.ts:102-126`

- [ ] **Step 1: Replace the private sender**

In `src/sync/alerts.ts`, add to the imports at the top:

```typescript
import { TelegramClient } from "@/telegram/client";
```

Replace the whole body of `sendTelegram` (lines 102–126, the function and its doc comment) with:

```typescript
/** Send a message to the configured Telegram channel; returns ok/error (never throws). */
async function sendTelegram(text: string): Promise<{ ok: boolean; error?: string }> {
  const e = env();
  if (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_ALERT_CHAT_ID)
    return {
      ok: false,
      error: "Telegram not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID.",
    };
  const res = await new TelegramClient(e.TELEGRAM_BOT_TOKEN).sendMessage({
    chatId: e.TELEGRAM_ALERT_CHAT_ID,
    text,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
```

Export it so the check-in escalation can reuse the same channel:

```typescript
export { sendTelegram as sendAlertChannelMessage };
```

- [ ] **Step 2: Run the existing alert tests**

Run: `bun test src/sync/alerts.test.ts`

Expected: PASS with the same count as before the change. The behaviour is identical — unconfigured
returns `ok: false` with the same message, and a configured send returns `ok: true`.

- [ ] **Step 3: Typecheck and commit**

Run: `bunx tsc --noEmit`

```bash
git add src/sync/alerts.ts
git commit -m "refactor(alerts): send through TelegramClient so there is one Telegram path"
```

---

## Task 7: Notion comment insert

**Files:**
- Modify: `src/notion/client.ts`
- Modify: `src/notion/client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/notion/client.test.ts`:

```typescript
test("createComment posts one rich_text item per chunk and returns the comment id", async () => {
  const { calls, impl } = recorder([{ object: "comment", id: "c123" }]);
  const client = new NotionClient("tok", impl);

  const id = await client.createComment("page-1", ["first", "second"]);

  expect(id).toBe("c123");
  expect(calls[0].url).toBe("https://api.notion.com/v1/comments");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].body).toEqual({
    parent: { page_id: "page-1" },
    rich_text: [
      { type: "text", text: { content: "first" } },
      { type: "text", text: { content: "second" } },
    ],
  });
});

test("createComment rejects an empty body instead of posting a blank comment", async () => {
  const { calls, impl } = recorder([{}]);
  const client = new NotionClient("tok", impl);

  await expect(client.createComment("page-1", [])).rejects.toThrow("empty");
  expect(calls).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test src/notion/client.test.ts`

Expected: FAIL — `client.createComment is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/notion/client.ts`, add this method to `NotionClient` immediately after `setPageValue`:

```typescript
  /**
   * Add a comment to a page. Requires the integration's "Insert comments" capability — a missing
   * capability surfaces as a Notion 403 through `req`.
   *
   * `chunks` are pre-split by the caller because Notion rejects a rich_text item over 2000 chars.
   */
  async createComment(pageId: string, chunks: string[]): Promise<string> {
    if (chunks.length === 0) throw new Error(`refusing to post an empty comment on ${pageId}`);
    const body = await this.req(`/comments`, {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: pageId },
        rich_text: chunks.map((content) => ({ type: "text", text: { content } })),
      }),
    });
    // Throwing, not returning "": Task 11 treats a non-null `notion_comment_id` as durable success,
    // so an empty string would mark the prompt commented with an unusable id and it would never be
    // retried or flagged. `req()` already throws on failure; this keeps the contract consistent.
    const id = body.id;
    if (typeof id !== "string" || !id) {
      throw new Error(`Notion accepted the comment on ${pageId} but returned no id`);
    }
    return id;
  }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/notion/client.test.ts`

Expected: PASS, 14 — the 10 pre-existing plus 4 new. Beyond the two shown above (request shape, empty
body) you need one test per arm of the id guard, because each is separately mutable: a response with
**no** `id`, and a response whose `id` is the **empty string**. Dropping `!id` from the guard leaves
the suite green otherwise, which would let Notion's `id: ""` be stored as a real comment id. Match the
empty-comment error on `/empty comment on page-1/` rather than bare `/empty/`, or dropping the page id
from the message also goes undetected.

- [ ] **Step 5: Commit**

```bash
git add src/notion/client.ts src/notion/client.test.ts
git commit -m "feat(notion): insert page comments"
```

---

## Task 8: Carry Notion `Owners` through to storage

The 17:00 job must not query Notion — it reads the board snapshot already stored on `clients.raw`.
`reconcileClients` persists `raw: c.pages`, so adding owners to the page shape is enough.

**Files:**
- Modify: `src/notion/parse.ts:88-98` (`ParsedCampaignRow`), `:100-112` (`ClubbedClient`), `:63-86` (`boardRows`), `:132-154` (`parseCampaignRow`), `:233-238` (`clubClients` page push)
- Modify: `src/notion/parse.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/notion/parse.test.ts`:

```typescript
import { parseCampaignRow, boardRows, clubClients } from "./parse";

const VLAD = "2cbd872b-594c-8119-9649-0002845d8d9c";
const SHIKHAR = "254d872b-594c-8154-9479-000271904e5b";

test("parseCampaignRow reads Owners person ids", () => {
  const row = parseCampaignRow({
    id: "page-1",
    properties: {
      Campaign: { type: "title", title: [{ plain_text: "Slots.lv" }] },
      Owners: {
        type: "people",
        people: [
          { id: SHIKHAR, name: "Shikhar Gupta" },
          { id: VLAD, name: "Vladyslav Istrati" },
        ],
      },
    },
  } as never);

  expect(row?.ownerIds).toEqual([SHIKHAR, VLAD]);
});

test("a row with no Owners cell parses to an empty owner list", () => {
  const row = parseCampaignRow({
    id: "page-2",
    properties: { Campaign: { type: "title", title: [{ plain_text: "Farside" }] } },
  } as never);

  expect(row?.ownerIds).toEqual([]);
});

test("owner ids survive clubbing and the clients.raw round-trip", () => {
  // clubClients output is written verbatim to clients.raw, and boardRows reads it back. If either
  // side drops ownerIds the check-in silently prompts nobody.
  const clubbed = clubClients(
    [
      {
        pageId: "page-1",
        title: "Slots.lv",
        clientRelationIds: [],
        activeIds: ["act_1"],
        otherIds: [],
        status: "Live",
        budget: null,
        startDate: null,
        endDate: null,
        ownerIds: [SHIKHAR],
      },
    ],
    new Map(),
  );

  expect(clubbed[0].pages[0].ownerIds).toEqual([SHIKHAR]);
  expect(boardRows(clubbed[0].pages)).toEqual([
    { pageId: "page-1", title: "Slots.lv", status: "Live", ownerIds: [SHIKHAR] },
  ]);
});

test("boardRows tolerates rows stored before owners existed", () => {
  // Existing clients.raw rows have no ownerIds. They must read back as [] rather than undefined.
  expect(boardRows([{ pageId: "p", title: "t", status: "Live" }])).toEqual([
    { pageId: "p", title: "t", status: "Live", ownerIds: [] },
  ]);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test src/notion/parse.test.ts`

Expected: FAIL — `ownerIds` is not a property of the parsed row.

- [ ] **Step 3: Write the implementation**

In `src/notion/parse.ts`:

Add the people reader next to `relationIds` (after line 118):

```typescript
const peopleIds = (p: NotionProp | undefined): string[] =>
  ((p?.people as { id?: string }[] | undefined) ?? [])
    .map((x) => x.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
```

Add `ownerIds: string[];` to `ParsedCampaignRow` (after `status`), and add
`ownerIds: string[];` to the `pages` element type of `ClubbedClient`:

```typescript
  pages: {
    pageId: string;
    title: string;
    status: string | null;
    accountIds: string[];
    /** Notion `Owners` person ids for this row — the daily check-in's recipient list. */
    ownerIds: string[];
  }[];
```

In `parseCampaignRow`, add to the returned object (after `status: statusOf(page),`):

```typescript
    // The board's `Owners` people column. Person ids, not names: names drift, ids do not.
    ownerIds: peopleIds(page.properties?.["Owners"]),
```

In `clubClients`, extend the `c.pages.push({...})` call (line 233) with:

```typescript
      ownerIds: row.ownerIds,
```

Rewrite `boardRows` so it also reads owners and stays tolerant of rows written before this change:

```typescript
export function boardRows(
  raw: unknown,
): { pageId: string; title: string; status: string | null; ownerIds: string[] }[] {
  if (!Array.isArray(raw)) return [];
  const rows: unknown[] = raw;
  const out: { pageId: string; title: string; status: string | null; ownerIds: string[] }[] = [];
  for (const p of rows) {
    if (!p || typeof p !== "object") continue;
    if (!("pageId" in p) || typeof p.pageId !== "string") continue;
    const title = "title" in p ? p.title : undefined;
    const status = "status" in p ? p.status : undefined;
    const owners = "ownerIds" in p ? p.ownerIds : undefined;
    out.push({
      pageId: p.pageId,
      title: typeof title === "string" ? title : "",
      status: typeof status === "string" ? status : null,
      // Rows stored before owners were captured have none; the next Notion sync fills them in.
      ownerIds: Array.isArray(owners) ? owners.filter((x): x is string => typeof x === "string") : [],
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/notion/parse.test.ts && bun test src/sync/jobs/notion-budget.test.ts`

Expected: PASS. `notion-budget.test.ts` consumes `boardRows`, so it must stay green — the extra field
is additive.

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc --noEmit`

```bash
git add src/notion/parse.ts src/notion/parse.test.ts
git commit -m "feat(notion): capture Owners person ids on board rows"
```

---

## Task 9: Plan and send the daily prompts

**Files:**
- Create: `src/sync/jobs/checkin.ts`

This task is DB/IO orchestration; its decisions were already unit-tested in Tasks 1–3, so there is no
new pure-unit test here. Verification is the smoke test in Task 14, plus the DB-backed idempotency
test on the `checkin_prompts` unique index added in Task 4.

- [ ] **Step 1: Write the job**

Create `src/sync/jobs/checkin.ts`:

```typescript
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { boardRows } from "@/notion/parse";
import { TelegramClient } from "@/telegram/client";
import { berlinNow } from "@/lib/berlin-time";
import { dayLabel, renderList, type ListItem } from "@/lib/checkin-render";
import {
  planPrompts,
  type CheckinBoardRow,
  type CheckinBuyer,
  type PromptState,
} from "@/lib/checkin";
import { recordServiceHealth } from "@/sync/state";

/** Null when the bot token is unset — the whole feature is then inert, which Settings surfaces. */
export function telegram(): TelegramClient | null {
  const token = env().TELEGRAM_BOT_TOKEN;
  return token ? new TelegramClient(token) : null;
}

/** Media buyers as the planner needs them. */
async function loadBuyers(): Promise<CheckinBuyer[]> {
  const rows = await db.select().from(schema.mediaBuyers);
  return rows.map((r) => ({
    personId: r.notionPersonId,
    displayName: r.displayName,
    chatId: r.telegramChatId,
    active: r.active,
  }));
}

/** Every live client's stored board rows, flattened. */
async function loadBoardRows(): Promise<CheckinBoardRow[]> {
  const rows = await db
    .select({ raw: schema.clients.raw })
    .from(schema.clients)
    .where(isNull(schema.clients.removedAt));
  return rows.flatMap((r) => boardRows(r.raw));
}

/**
 * Plan and send today's prompts. Idempotent: `checkin_runs.run_date` is claimed first, so a worker
 * restart inside the same minute cannot double-prompt, and a day with zero in-scope rows is recorded
 * as planned rather than re-planned on every poll iteration.
 *
 * Returns null when the day was already planned or Telegram is unconfigured.
 */
export async function runDailyCheckin(now: Date): Promise<{ created: number; sent: number } | null> {
  const tg = telegram();
  if (!tg) return null;
  const local = berlinNow(now);

  const claimed = await db
    .insert(schema.checkinRuns)
    .values({ runDate: local.date })
    .onConflictDoNothing()
    .returning({ runDate: schema.checkinRuns.runDate });
  if (claimed.length === 0) return null; // another iteration (or process) already planned today

  const plans = planPrompts(await loadBoardRows(), await loadBuyers());
  let created = 0;
  for (const p of plans) {
    const ins = await db
      .insert(schema.checkinPrompts)
      .values({
        promptDate: local.date,
        notionPageId: p.notionPageId,
        campaignTitle: p.campaignTitle,
        status: p.status,
        buyerPersonId: p.buyerPersonId,
        chatId: p.chatId,
        question: p.question,
        state: p.chatId ? "pending" : "unroutable",
      })
      .onConflictDoNothing()
      .returning({ id: schema.checkinPrompts.id });
    created += ins.length;
  }

  await db
    .update(schema.checkinRuns)
    .set({ plannedAt: new Date(), promptsCreated: created })
    .where(eq(schema.checkinRuns.runDate, local.date));

  const sent = await sendDailyLists(local.date);
  await recordServiceHealth("checkin", true, `${created} prompts, ${sent} messages`);
  return { created, sent };
}

/**
 * One list message per buyer with a routable prompt today. Called from `runDailyCheckin` AND from the
 * worker loop, because it only picks up prompts whose `listMessageId` is still null — that is what
 * makes a failed or rate-limited send retry on the next iteration instead of being lost for the day.
 */
export async function sendDailyLists(date: string): Promise<number> {
  const tg = telegram();
  if (!tg) return 0;
  const prompts = await db
    .select()
    .from(schema.checkinPrompts)
    .where(and(eq(schema.checkinPrompts.promptDate, date), isNull(schema.checkinPrompts.listMessageId)));

  const byChat = new Map<string, typeof prompts>();
  for (const p of prompts) {
    if (!p.chatId) continue;
    const list = byChat.get(p.chatId) ?? [];
    list.push(p);
    byChat.set(p.chatId, list);
  }

  let sent = 0;
  for (const [chatId, list] of byChat) {
    const ordered = [...list].sort((a, b) => a.campaignTitle.localeCompare(b.campaignTitle));
    const { text, keyboard } = renderList(dayLabel(date), ordered.map(toListItem));
    const res = await tg.sendMessage({ chatId, text, keyboard });
    if (!res.ok) {
      // Left with listMessageId null on purpose: the next loop iteration retries this buyer.
      if (res.retryAfter) await sleep(res.retryAfter * 1000);
      await db
        .update(schema.checkinPrompts)
        .set({ note: res.error ?? "send failed" })
        .where(
          inArray(
            schema.checkinPrompts.id,
            ordered.map((p) => p.id),
          ),
        );
      continue;
    }
    sent += 1;
    await db
      .update(schema.checkinPrompts)
      .set({ listMessageId: String(res.messageId), note: null })
      .where(
        inArray(
          schema.checkinPrompts.id,
          ordered.map((p) => p.id),
        ),
      );
  }
  return sent;
}

function toListItem(p: {
  id: number;
  campaignTitle: string;
  status: string;
  question: string;
  state: string;
}): ListItem {
  return {
    promptId: p.id,
    title: p.campaignTitle,
    status: p.status,
    question: p.question,
    state: p.state as PromptState,
  };
}

/** Re-render one buyer's daily list after a state change. Failure is non-fatal: the DB is the truth. */
export async function rerenderList(chatId: string, listMessageId: string): Promise<void> {
  const tg = telegram();
  if (!tg) return;
  const prompts = await db
    .select()
    .from(schema.checkinPrompts)
    .where(
      and(
        eq(schema.checkinPrompts.chatId, chatId),
        eq(schema.checkinPrompts.listMessageId, listMessageId),
      ),
    );
  if (prompts.length === 0) return;
  const ordered = [...prompts].sort((a, b) => a.campaignTitle.localeCompare(b.campaignTitle));
  const { text, keyboard } = renderList(dayLabel(ordered[0].promptDate), ordered.map(toListItem));
  const res = await tg.editMessageText({
    chatId,
    messageId: Number(listMessageId),
    text,
    keyboard,
  });
  if (!res.ok) console.error("[checkin] list re-render failed:", res.error);
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`

Expected: no errors. If drizzle complains about `.returning()` on `onConflictDoNothing()`, confirm the
chain order is `.insert(...).values(...).onConflictDoNothing().returning({...})`.

- [ ] **Step 3: Commit**

```bash
git add src/sync/jobs/checkin.ts
git commit -m "feat(checkin): plan the day's prompts and send one list per buyer"
```

---

## Task 10: Handle taps and replies

**Files:**
- Create: `src/telegram/updates.ts`
- Create: `src/telegram/updates.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/telegram/updates.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { handleUpdate, type UpdateDeps, type PromptRow } from "./updates";

const prompt = (o: Partial<PromptRow> = {}): PromptRow => ({
  id: o.id ?? 7,
  promptDate: o.promptDate ?? "2026-08-13",
  chatId: o.chatId ?? "111",
  campaignTitle: o.campaignTitle ?? "Slots.lv",
  status: o.status ?? "Live",
  question: o.question ?? "Any changes today?",
  listMessageId: o.listMessageId ?? "500",
  state: o.state ?? "pending",
});

/** Records every deps call so a test can assert what the dispatcher decided to do. */
function fakeDeps(overrides: Partial<UpdateDeps> = {}) {
  const log: string[] = [];
  const deps: UpdateDeps = {
    sendMessage: async (chatId, text, forceReply) => {
      log.push(`send:${chatId}:${forceReply ? "force" : "plain"}:${text.slice(0, 24)}`);
      return { ok: true, messageId: 900 };
    },
    answerCallback: async (id, text) => {
      log.push(`ack:${id}:${text ?? ""}`);
    },
    recordChat: async (chatId) => {
      log.push(`chat:${chatId}`);
    },
    isBoundChat: async () => true,
    loadPrompt: async (id) => (id === 7 ? prompt() : null),
    loadPromptByReply: async () => null,
    openPromptsForChat: async () => [],
    markNoChanges: async (id) => {
      log.push(`nochanges:${id}`);
    },
    markAwaitingReply: async (id, messageId) => {
      log.push(`awaiting:${id}:${messageId}`);
    },
    saveAnswer: async (id, text) => {
      log.push(`answer:${id}:${text}`);
    },
    rerenderList: async (chatId, listMessageId) => {
      log.push(`rerender:${chatId}:${listMessageId}`);
    },
    ...overrides,
  };
  return { log, deps };
}

test("tapping No changes closes the prompt, writes nothing and re-renders", async () => {
  const { log, deps } = fakeDeps();

  await handleUpdate({ update_id: 1, callback_query: { id: "cb", data: "nc:7", from: { id: 111 } } }, deps);

  expect(log).toContain("nochanges:7");
  expect(log).toContain("ack:cb:Logged — no changes");
  expect(log).toContain("rerender:111:500");
  expect(log.some((l) => l.startsWith("answer:"))).toBe(false);
});

test("tapping Update sends a force-reply prompt and records the message id", async () => {
  const { log, deps } = fakeDeps();

  await handleUpdate({ update_id: 2, callback_query: { id: "cb", data: "up:7", from: { id: 111 } } }, deps);

  expect(log).toContain("send:111:force:✍️ Update for Slots.lv (L");
  expect(log).toContain("awaiting:7:900");
});

test("a reply to the force-reply message is saved against that campaign", async () => {
  const { log, deps } = fakeDeps({
    loadPromptByReply: async (chatId, replyId) =>
      chatId === "111" && replyId === 900 ? prompt({ state: "awaiting_reply" }) : null,
  });

  await handleUpdate(
    {
      update_id: 3,
      message: {
        message_id: 950,
        chat: { id: 111 },
        text: "Topped up $2k",
        reply_to_message: { message_id: 900 },
      },
    },
    deps,
  );

  expect(log).toContain("answer:7:Topped up $2k");
  expect(log).toContain("rerender:111:500");
});

test("a plain message is attributed when exactly one prompt is awaiting a reply", async () => {
  const { log, deps } = fakeDeps({
    openPromptsForChat: async () => [prompt({ state: "awaiting_reply" })],
  });

  await handleUpdate(
    { update_id: 4, message: { message_id: 951, chat: { id: 111 }, text: "no news" } },
    deps,
  );

  expect(log).toContain("answer:7:no news");
});

test("an ambiguous plain message asks which campaign instead of guessing", async () => {
  // Writing to the wrong page would put one client's update on another client's card.
  const { log, deps } = fakeDeps({
    openPromptsForChat: async () => [
      prompt({ id: 7, state: "awaiting_reply" }),
      prompt({ id: 8, campaignTitle: "Lucky Rebel", state: "awaiting_reply" }),
    ],
  });

  await handleUpdate(
    { update_id: 5, message: { message_id: 952, chat: { id: 111 }, text: "all good" } },
    deps,
  );

  expect(log.some((l) => l.startsWith("answer:"))).toBe(false);
  expect(log.some((l) => l.includes("which campaign"))).toBe(true);
});

test("a plain message with nothing open is answered politely and stored nowhere", async () => {
  const { log, deps } = fakeDeps({ openPromptsForChat: async () => [] });

  await handleUpdate(
    { update_id: 6, message: { message_id: 953, chat: { id: 111 }, text: "hello?" } },
    deps,
  );

  expect(log.some((l) => l.startsWith("answer:"))).toBe(false);
  expect(log.some((l) => l.includes("Nothing open"))).toBe(true);
});

test("/start from an unknown chat records it and returns the chat id, and leaks no campaign data", async () => {
  const { log, deps } = fakeDeps({ isBoundChat: async () => false });

  await handleUpdate(
    { update_id: 7, message: { message_id: 1, chat: { id: 777, username: "someone" }, text: "/start" } },
    deps,
  );

  expect(log).toContain("chat:777");
  expect(log.some((l) => l.includes("777"))).toBe(true);
  expect(log.some((l) => l.startsWith("answer:"))).toBe(false);
});

test("a message from an unbound chat that is not /start is ignored entirely", async () => {
  const { log, deps } = fakeDeps({ isBoundChat: async () => false });

  await handleUpdate(
    { update_id: 8, message: { message_id: 2, chat: { id: 777 }, text: "who are you" } },
    deps,
  );

  expect(log).toEqual(["chat:777"]);
});

test("a callback for an unknown or closed prompt is acknowledged without a state change", async () => {
  const { log, deps } = fakeDeps({ loadPrompt: async () => null });

  await handleUpdate({ update_id: 9, callback_query: { id: "cb", data: "nc:404", from: { id: 111 } } }, deps);

  expect(log).toContain("ack:cb:That check-in is closed");
  expect(log.some((l) => l.startsWith("nochanges:"))).toBe(false);
});

test("a callback with malformed data is acknowledged and dropped", async () => {
  const { log, deps } = fakeDeps();

  await handleUpdate({ update_id: 10, callback_query: { id: "cb", data: "garbage", from: { id: 111 } } }, deps);

  expect(log).toEqual(["ack:cb:Unrecognised action"]);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test src/telegram/updates.test.ts`

Expected: FAIL — `Cannot find module './updates'`.

- [ ] **Step 3: Write the implementation**

Create `src/telegram/updates.ts`:

```typescript
import { type PromptState } from "@/lib/checkin";
import { forceReplyText, parseCallback } from "@/lib/checkin-render";
import type { TelegramUpdate } from "./client";

/** A prompt row as the dispatcher needs it. */
export interface PromptRow {
  id: number;
  promptDate: string;
  chatId: string | null;
  campaignTitle: string;
  status: string;
  question: string;
  listMessageId: string | null;
  state: PromptState;
}

/**
 * Everything the dispatcher needs from the outside world. Injected so the decision logic is testable
 * with fakes — no database and no Telegram in the tests.
 */
export interface UpdateDeps {
  sendMessage(
    chatId: string,
    text: string,
    forceReply?: boolean,
  ): Promise<{ ok: boolean; messageId?: number }>;
  answerCallback(id: string, text?: string): Promise<void>;
  recordChat(chatId: string, username?: string, firstName?: string): Promise<void>;
  isBoundChat(chatId: string): Promise<boolean>;
  loadPrompt(id: number): Promise<PromptRow | null>;
  loadPromptByReply(chatId: string, replyMessageId: number): Promise<PromptRow | null>;
  openPromptsForChat(chatId: string): Promise<PromptRow[]>;
  markNoChanges(id: number): Promise<void>;
  markAwaitingReply(id: number, replyMessageId: number): Promise<void>;
  saveAnswer(id: number, text: string): Promise<void>;
  rerenderList(chatId: string, listMessageId: string): Promise<void>;
}

/** States a prompt can still be answered from. */
const OPEN: PromptState[] = ["pending", "awaiting_reply"];

/**
 * Route one Telegram update. Never throws: the caller is a long-running loop.
 *
 * The ordering rule that matters: an answer is attributed by `reply_to_message` first, and only then
 * by "exactly one prompt is awaiting a reply". If neither is unambiguous the bot ASKS. A guess here
 * would land one client's update on another client's Notion card.
 */
export async function handleUpdate(update: TelegramUpdate, deps: UpdateDeps): Promise<void> {
  if (update.callback_query) {
    const cb = update.callback_query;
    const parsed = cb.data ? parseCallback(cb.data) : null;
    if (!parsed) {
      await deps.answerCallback(cb.id, "Unrecognised action");
      return;
    }
    const prompt = await deps.loadPrompt(parsed.promptId);
    if (!prompt || !OPEN.includes(prompt.state)) {
      await deps.answerCallback(cb.id, "That check-in is closed");
      return;
    }
    const chatId = prompt.chatId ?? String(cb.from.id);

    if (parsed.action === "no_changes") {
      await deps.markNoChanges(prompt.id);
      await deps.answerCallback(cb.id, "Logged — no changes");
    } else {
      const sent = await deps.sendMessage(
        chatId,
        forceReplyText({
          title: prompt.campaignTitle,
          status: prompt.status,
          question: prompt.question,
        }),
        true,
      );
      if (sent.ok && sent.messageId != null) await deps.markAwaitingReply(prompt.id, sent.messageId);
      await deps.answerCallback(cb.id, sent.ok ? undefined : "Could not open the reply box");
    }
    if (prompt.listMessageId) await deps.rerenderList(chatId, prompt.listMessageId);
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  await deps.recordChat(chatId, msg.chat.username, msg.chat.first_name);

  const text = (msg.text ?? "").trim();
  if (!(await deps.isBoundChat(chatId))) {
    // Unbound chats get no campaign data — only their own id, so an admin can bind them.
    if (text.startsWith("/start")) {
      await deps.sendMessage(
        chatId,
        `👋 MetaConsole check-in bot.\nYour chat id is ${chatId} — send it to your admin to be bound as a media buyer.`,
      );
    }
    return;
  }

  if (!text) return;

  const replyTo = msg.reply_to_message?.message_id;
  const target = replyTo != null ? await deps.loadPromptByReply(chatId, replyTo) : null;
  if (target) {
    await deps.saveAnswer(target.id, text);
    if (target.listMessageId) await deps.rerenderList(chatId, target.listMessageId);
    return;
  }

  const open = (await deps.openPromptsForChat(chatId)).filter((p) => p.state === "awaiting_reply");
  if (open.length === 1) {
    await deps.saveAnswer(open[0].id, text);
    if (open[0].listMessageId) await deps.rerenderList(chatId, open[0].listMessageId);
    return;
  }
  if (open.length > 1) {
    await deps.sendMessage(
      chatId,
      `Which campaign is that for? Tap ✍️ Update on the campaign in today's list, then reply.\nOpen: ${open
        .map((p) => p.campaignTitle)
        .join(", ")}`,
    );
    return;
  }
  await deps.sendMessage(
    chatId,
    "Nothing open right now — today's check-in is either done or hasn't been sent yet.",
  );
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/telegram/updates.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/updates.ts src/telegram/updates.test.ts
git commit -m "feat(telegram): dispatch taps and replies without ever guessing attribution"
```

---

## Task 11: Poll, write comments, escalate

**Files:**
- Modify: `src/sync/jobs/checkin.ts`
- Modify: `src/sync/alerts.test.ts` (two items carried over from Task 6's review — see below)

> **Carried over from Task 6.** This task consumes `sendAlertChannelMessage`, so it owns closing two
> gaps the refactor exposed:
> 1. **`sendAlertChannelMessage` has no direct test.** `alerts.test.ts` never calls it, so the
>    unconfigured guard is a surviving mutant (`if (false)` leaves the suite green). Add unit coverage
>    for all three returns: the unconfigured guard with its exact string
>    (`"Telegram not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID."`, which the
>    Settings UI surfaces), the `{ ok: true }` success mapping, and a failure returning
>    `{ ok: false, error }` without throwing. The escalation is the only thing that surfaces an
>    unanswered check-in, so a silently broken send means nobody ever learns.
> 2. **A latent trap in the existing stub.** `alerts.test.ts:19` stubs
>    `new Response("{}", { status: 200 })`, which modelled a successful send under the old inline
>    `fetch` but models a FAILURE under `TelegramClient`'s stricter rule that `body.ok` must be
>    `true`. It is inert today only because no `TELEGRAM_BOT_TOKEN` is set in the test environment, so
>    the unconfigured guard fires first and the stub never intercepts a Telegram POST. On any machine
>    where those vars are set it silently becomes a failure simulation. Change the stub body to a real
>    `{"ok":true,"result":{"message_id":1}}` envelope.

- [ ] **Step 1: Add the poll loop body, the comment flush and the escalation**

Add these imports to the ones already at the top of `src/sync/jobs/checkin.ts` (imports belong at the
top of the file, not beside the functions below):

```typescript
import { getNotionCredentials } from "@/lib/credentials";
import { NotionClient } from "@/notion/client";
import { commentBody, escalationText } from "@/lib/checkin-render";
import { addDays } from "@/lib/range";
import { handleUpdate, type PromptRow, type UpdateDeps } from "@/telegram/updates";
import { sendAlertChannelMessage } from "@/sync/alerts";

const POLL_TIMEOUT_SEC = 30;
/** A comment that has failed this many times stops being retried and is reported instead. */
const MAX_COMMENT_ATTEMPTS = 5;

const asPromptRow = (r: typeof schema.checkinPrompts.$inferSelect): PromptRow => ({
  id: r.id,
  promptDate: r.promptDate,
  chatId: r.chatId,
  campaignTitle: r.campaignTitle,
  status: r.status,
  question: r.question,
  listMessageId: r.listMessageId,
  state: r.state as PromptState,
});

function buildDeps(tg: TelegramClient): UpdateDeps {
  return {
    sendMessage: async (chatId, text, forceReply) => {
      const r = await tg.sendMessage({ chatId, text, forceReply });
      return { ok: r.ok, messageId: r.messageId };
    },
    answerCallback: async (id, text) => {
      await tg.answerCallbackQuery({ id, text });
    },
    recordChat: async (chatId, username, firstName) => {
      const vals = { chatId, username: username ?? null, firstName: firstName ?? null, lastSeenAt: new Date() };
      await db
        .insert(schema.telegramChats)
        .values(vals)
        .onConflictDoUpdate({
          target: schema.telegramChats.chatId,
          set: { username: vals.username, firstName: vals.firstName, lastSeenAt: vals.lastSeenAt },
        });
    },
    isBoundChat: async (chatId) => {
      const [row] = await db
        .select({ id: schema.mediaBuyers.notionPersonId })
        .from(schema.mediaBuyers)
        .where(and(eq(schema.mediaBuyers.telegramChatId, chatId), eq(schema.mediaBuyers.active, true)));
      return Boolean(row);
    },
    loadPrompt: async (id) => {
      const [row] = await db.select().from(schema.checkinPrompts).where(eq(schema.checkinPrompts.id, id));
      return row ? asPromptRow(row) : null;
    },
    loadPromptByReply: async (chatId, replyMessageId) => {
      const [row] = await db
        .select()
        .from(schema.checkinPrompts)
        .where(
          and(
            eq(schema.checkinPrompts.chatId, chatId),
            eq(schema.checkinPrompts.replyMessageId, String(replyMessageId)),
          ),
        );
      return row ? asPromptRow(row) : null;
    },
    openPromptsForChat: async (chatId) => {
      const rows = await db
        .select()
        .from(schema.checkinPrompts)
        .where(
          and(
            eq(schema.checkinPrompts.chatId, chatId),
            inArray(schema.checkinPrompts.state, ["pending", "awaiting_reply"]),
          ),
        );
      return rows.map(asPromptRow);
    },
    markNoChanges: async (id) => {
      await db
        .update(schema.checkinPrompts)
        .set({ state: "no_changes", answeredAt: new Date() })
        .where(eq(schema.checkinPrompts.id, id));
    },
    markAwaitingReply: async (id, replyMessageId) => {
      await db
        .update(schema.checkinPrompts)
        .set({ state: "awaiting_reply", replyMessageId: String(replyMessageId) })
        .where(eq(schema.checkinPrompts.id, id));
    },
    saveAnswer: async (id, text) => {
      // Stored BEFORE any Notion call: a comment failure must never lose what the buyer typed.
      await db
        .update(schema.checkinPrompts)
        .set({ state: "answered", answerText: text, answeredAt: new Date(), note: null })
        .where(eq(schema.checkinPrompts.id, id));
    },
    rerenderList,
  };
}

/** One long-poll pass. Returns the number of updates handled. */
export async function pollTelegramOnce(): Promise<number> {
  const tg = telegram();
  if (!tg) return 0;
  const [state] = await db
    .select()
    .from(schema.telegramState)
    .where(eq(schema.telegramState.id, "singleton"));

  const res = await tg.getUpdates({
    offset: state?.updateOffset ?? null,
    timeoutSec: POLL_TIMEOUT_SEC,
  });
  if (!res.ok) {
    console.error("[checkin] getUpdates failed:", res.error);
    // Back off rather than spin: a persistent failure (revoked token, 429) would otherwise re-poll
    // immediately in a tight loop.
    await sleep((res.retryAfter ?? 5) * 1000);
    return 0;
  }

  const deps = buildDeps(tg);
  let highest = state?.updateOffset ?? 0;
  for (const update of res.updates) {
    try {
      await handleUpdate(update, deps);
    } catch (err) {
      console.error("[checkin] update handling failed:", err);
    }
    // Advance past a failed update too: retrying it forever would wedge the poll loop.
    highest = Math.max(highest, update.update_id + 1);
  }
  if (res.updates.length) {
    const vals = { id: "singleton", updateOffset: highest, updatedAt: new Date() };
    await db
      .insert(schema.telegramState)
      .values(vals)
      .onConflictDoUpdate({ target: schema.telegramState.id, set: vals });
  }
  return res.updates.length;
}

/**
 * Write comments for answers that don't have one yet. Separate from the reply handler so a Notion
 * outage delays comments without losing answers.
 */
export async function flushPendingComments(): Promise<number> {
  const creds = await getNotionCredentials();
  if (!creds) return 0;
  const notion = new NotionClient(creds.token);

  const pending = await db
    .select()
    .from(schema.checkinPrompts)
    .where(
      and(
        eq(schema.checkinPrompts.state, "answered"),
        isNull(schema.checkinPrompts.notionCommentId),
        sql`coalesce(${schema.checkinPrompts.commentAttempts}, 0) < ${MAX_COMMENT_ATTEMPTS}`,
      ),
    );

  const names = new Map(
    (await db.select().from(schema.mediaBuyers)).map((b) => [b.notionPersonId, b.displayName]),
  );

  let written = 0;
  for (const p of pending) {
    if (!p.answerText) continue;
    try {
      const id = await notion.createComment(
        p.notionPageId,
        commentBody({
          date: p.promptDate,
          buyerName: names.get(p.buyerPersonId) ?? p.buyerPersonId,
          status: p.status,
          question: p.question,
          answer: p.answerText,
        }),
      );
      await db
        .update(schema.checkinPrompts)
        .set({ notionCommentId: id, note: null })
        .where(eq(schema.checkinPrompts.id, p.id));
      written += 1;
    } catch (err) {
      const attempts = (p.commentAttempts ?? 0) + 1;
      const note = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.checkinPrompts)
        .set({ commentAttempts: attempts, note })
        .where(eq(schema.checkinPrompts.id, p.id));
      if (attempts >= MAX_COMMENT_ATTEMPTS) {
        await sendAlertChannelMessage(
          `❌ Check-in comment failed ${attempts}× for ${p.campaignTitle} (${p.promptDate}): ${note}\nThe answer is stored in checkin_prompts id ${p.id}.`,
        );
        await recordServiceHealth("checkin", false, `comment failed for prompt ${p.id}: ${note}`);
      }
    }
  }
  return written;
}

/**
 * Post yesterday's unanswered prompts to the shared alert channel, once. Unroutable prompts are
 * named too, so a missing Telegram binding is visible rather than silent.
 */
export async function escalateUnanswered(now: Date): Promise<number | null> {
  const local = berlinNow(now);
  const date = addDays(local.date, -1); // yesterday, via the shared date helper

  const [run] = await db
    .select()
    .from(schema.checkinRuns)
    .where(eq(schema.checkinRuns.runDate, date));
  if (!run || run.escalatedAt) return null; // nothing planned that day, or already escalated

  const open = await db
    .select()
    .from(schema.checkinPrompts)
    .where(
      and(
        eq(schema.checkinPrompts.promptDate, date),
        inArray(schema.checkinPrompts.state, ["pending", "awaiting_reply", "unroutable"]),
      ),
    );

  if (open.length) {
    const names = new Map(
      (await db.select().from(schema.mediaBuyers)).map((b) => [b.notionPersonId, b.displayName]),
    );
    const byBuyer = new Map<string, { buyerName: string; titles: string[]; unroutable: boolean }>();
    for (const p of open) {
      const key = `${p.buyerPersonId}:${p.state === "unroutable"}`;
      const g =
        byBuyer.get(key) ??
        {
          buyerName: names.get(p.buyerPersonId) ?? p.buyerPersonId,
          titles: [],
          unroutable: p.state === "unroutable",
        };
      g.titles.push(p.campaignTitle);
      byBuyer.set(key, g);
    }
    await sendAlertChannelMessage(escalationText(date, [...byBuyer.values()]));
    await db
      .update(schema.checkinPrompts)
      .set({ state: "escalated" })
      .where(
        inArray(
          schema.checkinPrompts.id,
          open.map((p) => p.id),
        ),
      );
  }

  await db
    .update(schema.checkinRuns)
    .set({ escalatedAt: new Date() })
    .where(eq(schema.checkinRuns.runDate, date));
  return open.length;
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/sync/jobs/checkin.ts
git commit -m "feat(checkin): poll updates, write comments with retries, escalate at 09:00"
```

---

## Task 12: Wire the independent worker loop

**Files:**
- Modify: `src/sync/worker.ts`

- [ ] **Step 1: Add the loop**

Replace the whole of `src/sync/worker.ts` with:

```typescript
import { setTimeout as sleep } from "node:timers/promises";
import { runCycle, runBackfillCycle } from "./cycle";
import {
  runDailyCheckin,
  escalateUnanswered,
  pollTelegramOnce,
  flushPendingComments,
  sendDailyLists,
} from "./jobs/checkin";
import { berlinNow } from "@/lib/berlin-time";
import { CHECKIN_HOUR, ESCALATION_HOUR } from "@/lib/checkin";

const HOUR_MS = 3_600_000;
// Backfill always gets at least this much time each loop, so a slow daily full refresh can never
// starve it (the bug where refresh > 1h left backfill with a deadline already in the past).
const BACKFILL_MIN_MS = 20 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * The check-in loop runs INDEPENDENTLY of the sync loop below. `runCycle({full:true})` can occupy
 * hours, and a 17:00 prompt sequenced behind it would arrive at midnight. Each iteration long-polls
 * Telegram for 30s and re-evaluates both time gates, so scheduling precision is ~30s.
 */
async function checkinLoop(): Promise<void> {
  console.log("[checkin] loop started (17:00 prompt, 09:00 escalation, 30s poll)");
  for (;;) {
    try {
      const now = new Date();
      const local = berlinNow(now);
      if (local.hour >= CHECKIN_HOUR) await runDailyCheckin(now);
      if (local.hour >= ESCALATION_HOUR) await escalateUnanswered(now);
      if (local.hour >= CHECKIN_HOUR) await sendDailyLists(local.date);
      await flushPendingComments();
      await pollTelegramOnce();
    } catch (e) {
      console.error("[checkin] loop iteration failed:", e);
      await sleep(5_000);
    }
  }
}

if (process.argv.includes("--once")) {
  // Manual one-shot: a full (all-metrics) refresh.
  runCycle({ full: true })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[sync] cycle failed:", e);
      process.exit(1);
    });
} else {
  console.log("[sync] scheduler started (hourly CORE refresh + daily full + continuous backfill)");
  void checkinLoop();
  void (async () => {
    // Seed with today so a restart/deploy does NOT re-trigger the ~3h full refresh; it runs once
    // at the next UTC day boundary. (A manual Sync-now still forces a full refresh.)
    let lastFullDay = today();
    for (;;) {
      const t0 = Date.now();
      // One full (all 219 metrics + breakdowns) refresh per calendar day; every other hour pulls
      // just the CORE KPIs so the refresh stays fast and leaves the hour to backfill.
      const full = today() !== lastFullDay;
      await runCycle({ full }).catch((e) => console.error("[sync] refresh failed:", e));
      if (full) lastFullDay = today();
      // Backfill until the next hour, but ALWAYS at least BACKFILL_MIN_MS.
      await runBackfillCycle(Math.max(t0 + HOUR_MS, Date.now() + BACKFILL_MIN_MS)).catch((e) =>
        console.error("[sync] backfill failed:", e),
      );
      const rest = t0 + HOUR_MS - Date.now();
      if (rest > 0) await sleep(rest);
    }
  })();
}
```

- [ ] **Step 2: Typecheck and run the whole suite**

Run: `bunx tsc --noEmit && bun test`

Expected: no type errors; every test passes.

- [ ] **Step 3: Commit**

```bash
git add src/sync/worker.ts
git commit -m "feat(checkin): run the check-in loop independently of the sync cycle"
```

---

## Task 13: Settings panel for buyer binding

**Files:**
- Create: `src/server/fns/checkin.ts`
- Create: `src/lib/api/checkin.ts`
- Create: `src/components/settings/MediaBuyerPanel.tsx`
- Modify: `src/routes/settings.tsx`

- [ ] **Step 1: Write the server fns**

Create `src/server/fns/checkin.ts`:

```typescript
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireAdmin, audit } from "./auth";

export interface CheckinAdminView {
  buyers: {
    personId: string;
    displayName: string;
    chatId: string | null;
    active: boolean;
    boundBy: string | null;
  }[];
  chats: { chatId: string; username: string | null; firstName: string | null }[];
  today: {
    campaignTitle: string;
    status: string;
    buyerPersonId: string;
    state: string;
    note: string | null;
  }[];
}

/** Everything the Settings panel shows. Admin-only. */
export async function fetchCheckinAdmin(): Promise<CheckinAdminView> {
  await requireAdmin();
  const [buyers, chats, prompts] = await Promise.all([
    db.select().from(schema.mediaBuyers),
    db.select().from(schema.telegramChats).orderBy(desc(schema.telegramChats.lastSeenAt)),
    db
      .select()
      .from(schema.checkinPrompts)
      .orderBy(desc(schema.checkinPrompts.promptDate), schema.checkinPrompts.campaignTitle)
      .limit(50),
  ]);
  return {
    buyers: buyers.map((b) => ({
      personId: b.notionPersonId,
      displayName: b.displayName,
      chatId: b.telegramChatId,
      active: b.active,
      boundBy: b.boundBy,
    })),
    chats: chats.map((c) => ({ chatId: c.chatId, username: c.username, firstName: c.firstName })),
    today: prompts.map((p) => ({
      campaignTitle: p.campaignTitle,
      status: p.status,
      buyerPersonId: p.buyerPersonId,
      state: p.state,
      note: p.note,
    })),
  };
}

/**
 * Create or update a media buyer. The Notion person id is the key: display names drift, ids do not.
 * Passing an empty chatId unbinds them, which leaves their prompts recorded but unroutable.
 */
export async function upsertMediaBuyer(data: {
  personId: string;
  displayName: string;
  chatId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const personId = data.personId.trim();
  const displayName = data.displayName.trim();
  if (!personId) return { ok: false, error: "No Notion person id" };
  if (!displayName) return { ok: false, error: "No display name" };
  const chatId = data.chatId.trim() || null;

  const vals = {
    notionPersonId: personId,
    displayName,
    telegramChatId: chatId,
    boundBy: user.email,
    boundAt: new Date(),
  };
  await db
    .insert(schema.mediaBuyers)
    .values(vals)
    .onConflictDoUpdate({ target: schema.mediaBuyers.notionPersonId, set: vals });
  await audit("checkin.buyer", `bound ${displayName} (${personId}) to chat ${chatId ?? "none"}`);
  return { ok: true };
}

/** Stop prompting a buyer without deleting their history. */
export async function setMediaBuyerActive(data: {
  personId: string;
  active: boolean;
}): Promise<{ ok: true }> {
  await requireAdmin();
  await db
    .update(schema.mediaBuyers)
    .set({ active: data.active })
    .where(eq(schema.mediaBuyers.notionPersonId, data.personId));
  await audit("checkin.buyer", `${data.active ? "activated" : "deactivated"} ${data.personId}`);
  return { ok: true };
}
```

- [ ] **Step 2: Write the server-fn wrappers**

Create `src/lib/api/checkin.ts`:

```typescript
import { createServerFn } from "@tanstack/react-start";
import {
  fetchCheckinAdmin,
  upsertMediaBuyer,
  setMediaBuyerActive,
} from "@/server/fns/checkin";

export const getCheckinAdmin = createServerFn({ method: "GET" }).handler(() => fetchCheckinAdmin());

export const saveMediaBuyer = createServerFn({ method: "POST" })
  .inputValidator((d: { personId: string; displayName: string; chatId: string }) => d)
  .handler(({ data }) => upsertMediaBuyer(data));

export const toggleMediaBuyer = createServerFn({ method: "POST" })
  .inputValidator((d: { personId: string; active: boolean }) => d)
  .handler(({ data }) => setMediaBuyerActive(data));
```

- [ ] **Step 3: Write the panel**

Create `src/components/settings/MediaBuyerPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { getCheckinAdmin, saveMediaBuyer, toggleMediaBuyer } from "@/lib/api/checkin";

type Admin = Awaited<ReturnType<typeof getCheckinAdmin>>;

/** Known media buyers, so binding is a two-field form rather than hunting for a person id. */
const KNOWN_BUYERS = [
  { personId: "254d872b-594c-8154-9479-000271904e5b", displayName: "Shikhar Gupta" },
  { personId: "2cbd872b-594c-8119-9649-0002845d8d9c", displayName: "Vladyslav Istrati" },
];

export function MediaBuyerPanel() {
  const [data, setData] = useState<Admin | null>(null);
  const [form, setForm] = useState({ personId: KNOWN_BUYERS[0].personId, chatId: "" });
  const [msg, setMsg] = useState<string | null>(null);

  const reload = () => void getCheckinAdmin().then(setData);
  useEffect(reload, []);

  const save = async () => {
    const known = KNOWN_BUYERS.find((b) => b.personId === form.personId);
    const res = await saveMediaBuyer({
      data: {
        personId: form.personId,
        displayName: known?.displayName ?? form.personId,
        chatId: form.chatId,
      },
    });
    setMsg(res.ok ? "Saved." : (res.error ?? "Failed."));
    reload();
  };

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Daily check-in — media buyers</h2>
        <p className="text-xs text-muted-foreground">
          Prompts go out at 17:00 Europe/Berlin to the buyers bound here. A buyer must send /start to
          the bot once before their chat appears below.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs space-y-1">
          <span className="block text-muted-foreground">Buyer</span>
          <select
            value={form.personId}
            onChange={(e) => setForm({ ...form, personId: e.target.value })}
            className="h-9 rounded-md border border-border bg-background px-2 text-xs"
          >
            {KNOWN_BUYERS.map((b) => (
              <option key={b.personId} value={b.personId}>
                {b.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs space-y-1">
          <span className="block text-muted-foreground">Telegram chat</span>
          <select
            value={form.chatId}
            onChange={(e) => setForm({ ...form, chatId: e.target.value })}
            className="h-9 rounded-md border border-border bg-background px-2 text-xs"
          >
            <option value="">— unbound —</option>
            {(data?.chats ?? []).map((c) => (
              <option key={c.chatId} value={c.chatId}>
                {c.firstName ?? c.username ?? c.chatId} ({c.chatId})
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={save}
          className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
        >
          Bind
        </button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>

      <div className="space-y-1">
        {(data?.buyers ?? []).map((b) => (
          <div key={b.personId} className="flex items-center gap-3 text-xs">
            <span className="font-medium">{b.displayName}</span>
            <span className="font-mono text-muted-foreground">{b.chatId ?? "no chat bound"}</span>
            <button
              onClick={async () => {
                await toggleMediaBuyer({ data: { personId: b.personId, active: !b.active } });
                reload();
              }}
              className="rounded border border-border px-2 py-0.5"
            >
              {b.active ? "active" : "inactive"}
            </button>
          </div>
        ))}
        {data?.buyers.length === 0 && (
          <p className="text-xs text-muted-foreground">No buyers bound yet.</p>
        )}
      </div>

      {(data?.today ?? []).length > 0 && (
        <div className="space-y-1 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">Recent prompts</h3>
          {(data?.today ?? []).map((p, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-48 truncate">{p.campaignTitle}</span>
              <span className="w-36">{p.status}</span>
              <span>{p.state}</span>
              {p.note && <span className="text-destructive">{p.note}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Mount the panel**

In `src/routes/settings.tsx`, add the import next to the other component imports:

```typescript
import { MediaBuyerPanel } from "@/components/settings/MediaBuyerPanel";
```

and render `<MediaBuyerPanel />` as the last section inside the page's main content container
(immediately before the container's closing tag).

- [ ] **Step 5: Verify it renders**

Run: `bun run dev`

Open `http://localhost:3000/settings` as an admin. Expected: the "Daily check-in — media buyers"
panel appears, the buyer dropdown lists both media buyers, and the chat dropdown shows `— unbound —`
until someone sends `/start`.

- [ ] **Step 6: Commit**

```bash
git add src/server/fns/checkin.ts src/lib/api/checkin.ts src/components/settings/MediaBuyerPanel.tsx src/routes/settings.tsx
git commit -m "feat(checkin): admin panel to bind media buyers to Telegram chats"
```

---

## Task 14: Smoke test on the droplet and deploy

**Files:** none — deployment and verification.

- [ ] **Step 1: Run the full suite and the linter locally**

Run this feature's tests and lint only what it touched:

```bash
bun test src/lib/checkin.test.ts src/lib/berlin-time.test.ts src/lib/checkin-render.test.ts \
  src/telegram/client.test.ts src/telegram/updates.test.ts src/notion/client.test.ts \
  src/notion/parse.test.ts src/sync/alerts.test.ts src/sync/jobs/notion-budget.test.ts
bunx eslint $(git diff --name-only origin/feat/meta-integration...HEAD -- '*.ts' '*.tsx')
```

Expected: all of those pass; eslint clean on the files this feature touched. Take a `bun test`
baseline before and after if you want a whole-repo comparison — it is not expected to be zero-fail.

**Do NOT gate on repo-wide `bun run lint`.** Measured 2026-08-13 on a clean checkout: it already
reports 20 errors / 7 warnings, all prettier formatting in files this feature never touches
(`src/lib/env.test.ts`, `src/lib/crypto.ts`, `src/server/fns/settings.test.ts`,
`src/db/schema.test.ts`, several components). `src/lib/env.test.ts` was last modified by `ccc0b64`,
long before this feature. Reformatting them here would bury the feature diff in unrelated churn; if
the team wants them fixed, that is its own commit.

- [ ] **Step 2: Commit and push to all three remotes**

```bash
git push origin feat/meta-integration
git push droplet feat/meta-integration
git push madsmonitor
```

- [ ] **Step 3: Deploy (no schema step)**

```bash
ssh -i C:/Users/shikh/.ssh/id_ed25519 root@159.65.110.111 \
  'cd /opt/meta-dashboard && git pull origin feat/meta-integration \
   && bun run build && systemctl restart meta-web meta-sync'
```

Expected: build succeeds; both services restart.

**Deliberately no `db:push` here.** The five tables were applied in Task 4, and this project has one
shared Postgres (local dev reaches it through an ssh tunnel on 127.0.0.1:5432), so there is nothing
left to apply. More importantly, **`bun run db:push` is not safe to run unattended on this repo** —
measured 2026-08-13, and it predates this feature:

> Alongside any additive change, drizzle also proposes
> `ALTER TABLE insights_breakdown_daily DROP CONSTRAINT ... ` plus a re-`ADD` under a different name.
> The composite `primaryKey()` at `src/db/schema.ts:183` has no explicit `name:`, so drizzle wants a
> 79-character constraint name that Postgres truncates back to the same 63 characters. Drizzle
> therefore sees a permanent diff and re-proposes the rename on every push — rebuilding the primary
> key of a **458,423-row** table for no gain.

Fixing that means giving the constraint an explicit short name, which is itself a rename on a large
table: it needs its own owner and a deliberate window, and it is out of scope here. Until then, apply
additive DDL explicitly (drizzle's own generated statements, in one transaction) rather than
confirming a push.

- [ ] **Step 4: Confirm the loop started**

```bash
ssh -i C:/Users/shikh/.ssh/id_ed25519 root@159.65.110.111 \
  'journalctl -u meta-sync -n 30 --no-pager | grep -i checkin'
```

Expected: `[checkin] loop started (17:00 prompt, 09:00 escalation, 30s poll)`.

- [ ] **Step 5: Bind both buyers**

Have Vlad and Shikhar each send `/start` to the bot. Expected: each receives their chat id. Then bind
both in Settings → "Daily check-in — media buyers". Confirm each row shows a chat id.

- [ ] **Step 6: Force one real prompt cycle**

The 17:00 gate fires only after 17:00 local. To test earlier, delete today's run claim so the next
poll iteration re-plans:

```bash
ssh -i C:/Users/shikh/.ssh/id_ed25519 root@159.65.110.111 \
  'cd /opt/meta-dashboard && set -a && . ./.env && set +a \
   && psql "$DATABASE_URL" -c "delete from checkin_prompts where prompt_date = current_date;" \
   && psql "$DATABASE_URL" -c "delete from checkin_runs where run_date = current_date;"'
```

Then temporarily set `CHECKIN_HOUR` to the current Berlin hour, deploy, observe, and **revert it to
17 before finishing**. Expected: each bound buyer receives one list message naming their campaigns
(Shikhar ~9, Vlad ~7 at the time of writing).

- [ ] **Step 7: Verify the three interaction paths end to end**

1. Tap **✅ No changes** on one campaign → the list re-renders with `✅` and that campaign loses its
   buttons. Confirm no Notion comment was created on that card.
2. Tap **✍️ Update** on another → a force-reply prompt arrives; reply with `smoke test — please
   ignore`. Confirm the campaign's Notion card shows a comment in the exact §7 format, and:

```bash
ssh -i C:/Users/shikh/.ssh/id_ed25519 root@159.65.110.111 \
  'cd /opt/meta-dashboard && set -a && . ./.env && set +a \
   && psql "$DATABASE_URL" -At -F "|" -c "select id, campaign_title, state, notion_comment_id, note from checkin_prompts where prompt_date = current_date order by id;"'
```

Expected: the tapped rows read `no_changes` and `answered` with a non-null `notion_comment_id`, and
`note` is null on both.
3. Send a plain message with nothing open → the bot replies "Nothing open right now".

- [ ] **Step 8: Delete the smoke-test comment from Notion**

Remove the `smoke test — please ignore` comment from the client's card so no client-facing artifact
is left behind.

- [ ] **Step 9: Confirm health is recorded**

```bash
ssh -i C:/Users/shikh/.ssh/id_ed25519 root@159.65.110.111 \
  'cd /opt/meta-dashboard && set -a && . ./.env && set +a \
   && psql "$DATABASE_URL" -At -F "|" -c "select * from service_health where service = '"'"'checkin'"'"';"'
```

Expected: one row, `ok = t`.

- [ ] **Step 10: Record the feature in the roadmap**

Add the check-in to `docs/product-roadmap.md` §3 as an approved, shipped item, noting it is a
*workflow prompt*, not the rejected idea-8 metrics digest. Commit and push to all three remotes.

---

## Appendix: what was deliberately left out

Per spec §12: no per-campaign reminder before the 09:00 escalation, no editing or deleting a comment
after it is written, no web UI for answering (Settings shows state only), no LLM in the write path, and
no performance figures in any prompt.
