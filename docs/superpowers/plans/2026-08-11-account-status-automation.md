# Account Status Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive the Notion campaigns board's `Account Status` column from Meta each sync cycle, without ever overwriting a value a human owns, and with an admin-settable override.

**Architecture:** A pure ladder function maps already-fetched Meta rows to one of five machine-owned status values. The existing `syncNotionDailyBudgets` job calls it per board row and writes the result through `setPageValue`. Machine-owned and human-owned status values are disjoint sets, so the value on the board tells you who owns it and no provenance tracking is needed. All five machine values join `LIVE_STATUSES` so the machine's writes cannot change `isLive`, which the same job uses for account→row assignment.

**Tech Stack:** TypeScript, Bun test, Drizzle ORM + Postgres, Notion API `2025-09-03`, TanStack Start server functions.

**Design spec:** `docs/superpowers/specs/2026-08-11-account-status-automation-design.md`

---

## PREREQUISITE — read before Task 6

`src/sync/jobs/notion-budget.ts` and `src/sync/jobs/notion-budget.test.ts` currently have **uncommitted
local changes by another operator** (a refactor changing `🤖 Daily Budget ($)` from Meta's in-force
daily budget to `targetDailyBudget(notionBudget)`, the contracted budget spread over
`TARGET_BUDGET_DAYS = 30`).

Tasks 1–5 and 7 do not touch that file and can proceed immediately. **Task 6 modifies it.** Git stages
whole files, so committing Task 6 would also commit that operator's in-flight refactor under this
plan's commit message.

**Before starting Task 6:** confirm the refactor has been committed by its author. Verify with:

```bash
git status --short src/sync/jobs/notion-budget.ts
```

Expected: no output. If it prints ` M src/sync/jobs/notion-budget.ts`, stop and ask — do not stash,
do not commit someone else's work, and do not use `git add -p` to split their hunks from yours.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/delivery-status.ts` (create) | The ladder. Pure, no imports from `sync/` or `db/`. Owns the machine/human value sets. |
| `src/lib/delivery-status.test.ts` (create) | Ladder tests, including every vacuous-truth case. |
| `src/notion/parse.ts` (modify) | `STATUS_PRIORITY` and `LIVE_STATUSES` gain the new options. |
| `src/notion/parse.test.ts` (modify) | Pins priority order and `LIVE_STATUSES` membership. |
| `src/notion/client.ts` (modify) | `addStatusOptions` — append missing options to an existing status property. |
| `src/notion/client.test.ts` (create) | Tests `addStatusOptions` against an injected `fetchImpl`. |
| `src/db/schema.ts` (modify) | `notionStatusOverrides` table. |
| `src/server/fns/account-status.ts` (create) | Admin-only override read/write/clear. |
| `src/sync/jobs/notion-budget.ts` (modify) | Widen two queries, derive per row, write the cell. |
| `src/components/dashboard/ClientDetailView.tsx` (modify) | Admin override control. |

The ladder deliberately does **not** import `canDeliver` or `accountStatus`. Those live in
`sync/jobs/notion-budget.ts` and `server/agg.ts`; importing them into `src/lib/` would invert the
layering. The caller computes two booleans per account and passes them in.

---

## Task 1: The ladder

**Files:**
- Create: `src/lib/delivery-status.ts`
- Test: `src/lib/delivery-status.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/delivery-status.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { deriveStatus, MACHINE_STATUSES, HUMAN_STATUSES, isMachineStatus } from "./delivery-status";

const acct = (o: Partial<{ disabled: boolean; deliverable: boolean }> = {}) => ({
  disabled: o.disabled ?? false,
  deliverable: o.deliverable ?? true,
});
const camp = (id: string, active = true) => ({ id, active });
const set = (id: string, campaignId: string, active = true) => ({ id, campaignId, active });
const ad = (adSetId: string, disapproved = false) => ({ adSetId, disapproved });

// A fully healthy row: one live account, one active campaign, one active ad set, one running ad.
const healthy = {
  accounts: [acct()],
  campaigns: [camp("c1")],
  adSets: [set("s1", "c1")],
  ads: [ad("s1")],
};

test("a delivering row is Live", () => {
  expect(deriveStatus(healthy)).toBe("Live");
});

test("every account disabled reads as Ad Account Disabled", () => {
  expect(
    deriveStatus({ ...healthy, accounts: [acct({ disabled: true, deliverable: false })] }),
  ).toBe("Ad Account Disabled");
});

test("one live account among disabled ones still reads Live", () => {
  // Strict all-or-nothing: partial breakage is not the status column's job.
  expect(
    deriveStatus({
      ...healthy,
      accounts: [acct({ disabled: true, deliverable: false }), acct()],
    }),
  ).toBe("Live");
});

test("accounts active but none able to deliver reads as Ad Account Blocked", () => {
  // The Slots.lv shape: account_status ACTIVE, prepaid cap exhausted, campaigns still ACTIVE.
  expect(deriveStatus({ ...healthy, accounts: [acct({ deliverable: false })] })).toBe(
    "Ad Account Blocked",
  );
});

test("all accounts disabled outranks all accounts undeliverable", () => {
  // A disabled account is also undeliverable; the more specific reason must win.
  expect(
    deriveStatus({
      ...healthy,
      accounts: [acct({ disabled: true, deliverable: false })],
    }),
  ).toBe("Ad Account Disabled");
});

test("no active campaign reads as Paused", () => {
  expect(deriveStatus({ ...healthy, campaigns: [camp("c1", false)] })).toBe("Paused");
});

test("active campaign with every ad set paused reads as Paused", () => {
  expect(deriveStatus({ ...healthy, adSets: [set("s1", "c1", false)] })).toBe("Paused");
});

test("every ad under the active ad sets disapproved reads as All ads rejected", () => {
  expect(deriveStatus({ ...healthy, ads: [ad("s1", true)] })).toBe("All ads rejected");
});

test("one running ad among disapproved ones still reads Live", () => {
  expect(deriveStatus({ ...healthy, ads: [ad("s1", true), ad("s1")] })).toBe("Live");
});

test("ads under paused ad sets are ignored when testing for rejection", () => {
  // An ad under a paused ad set is not rejected, it is simply not running. Counting it would let
  // ordinary ad-set pausing masquerade as a policy problem.
  expect(
    deriveStatus({
      ...healthy,
      adSets: [set("s1", "c1"), set("s2", "c1", false)],
      ads: [ad("s1"), ad("s2", true)],
    }),
  ).toBe("Live");
});

test("no accounts writes nothing", () => {
  // every() over an empty set is true, which would otherwise derive Ad Account Disabled.
  expect(deriveStatus({ ...healthy, accounts: [] })).toBeNull();
});

test("no attributed campaigns writes nothing", () => {
  expect(deriveStatus({ ...healthy, campaigns: [] })).toBeNull();
});

test("active campaign with no synced ad sets writes nothing", () => {
  // "no ad set is active" is vacuously true here; that is a sync gap, not a delivery state.
  expect(deriveStatus({ ...healthy, adSets: [], ads: [] })).toBeNull();
});

test("active ad sets with no synced ads writes nothing", () => {
  // "every ad is disapproved" is vacuously true here.
  expect(deriveStatus({ ...healthy, ads: [] })).toBeNull();
});

test("ad sets belonging to inactive campaigns do not satisfy the ad-set check", () => {
  const r = deriveStatus({
    accounts: [acct()],
    campaigns: [camp("c1"), camp("c2", false)],
    adSets: [set("s2", "c2")],
    ads: [ad("s2")],
  });
  expect(r).toBeNull(); // c1 is active but has no synced ad sets
});

test("the machine and human value sets are disjoint", () => {
  // The whole design rests on this: the value alone says who owns it.
  for (const h of HUMAN_STATUSES) expect(isMachineStatus(h)).toBe(false);
  for (const m of MACHINE_STATUSES) expect(isMachineStatus(m)).toBe(true);
  expect(MACHINE_STATUSES).toHaveLength(5);
  expect(HUMAN_STATUSES).toHaveLength(4);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test src/lib/delivery-status.test.ts`

Expected: FAIL — `Cannot find module './delivery-status'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/delivery-status.ts`:

```typescript
/**
 * Derives the delivery half of the Notion board's `Account Status` column from Meta.
 *
 * Pure by design: the caller passes already-fetched rows and two pre-computed booleans per account,
 * so this module imports nothing from `sync/`, `db/` or `server/`. `canDeliver` and `accountStatus`
 * stay where they live; pulling them in here would invert the layering.
 *
 * Machine-owned and human-owned values are DISJOINT. That is the load-bearing property of the whole
 * feature: the value sitting on the board says who owns it, so no timestamps, no last-writer column
 * and no provenance bookkeeping are needed. Never add a value to both sets.
 */

/** Delivery states the machine owns and may overwrite. */
export const MACHINE_STATUSES = [
  "Live",
  "Paused",
  "Ad Account Disabled",
  "Ad Account Blocked",
  "All ads rejected",
] as const;

/** Commercial lifecycle states only a human can know. The machine never writes these. */
export const HUMAN_STATUSES = [
  "On Boarding",
  "Not started",
  "Full Budget Finished",
  "Budget Finished - Top Up",
] as const;

export type MachineStatus = (typeof MACHINE_STATUSES)[number];
export type HumanStatus = (typeof HUMAN_STATUSES)[number];

export function isMachineStatus(value: string | null | undefined): value is MachineStatus {
  return value != null && (MACHINE_STATUSES as readonly string[]).includes(value);
}

/** One ad account, reduced to the two facts the ladder needs. */
export interface StatusAccount {
  /** `accountStatus(raw) === "DISABLED"`. */
  disabled: boolean;
  /** `canDeliver(account)` — active AND with prepaid headroom left. */
  deliverable: boolean;
}

export interface StatusCampaign {
  id: string;
  /** `effective_status === "ACTIVE"`. */
  active: boolean;
}

export interface StatusAdSet {
  id: string;
  campaignId: string;
  active: boolean;
}

export interface StatusAd {
  adSetId: string;
  /** `effective_status === "DISAPPROVED"`. WITH_ISSUES and PENDING_REVIEW are different states. */
  disapproved: boolean;
}

export interface StatusInput {
  accounts: StatusAccount[];
  campaigns: StatusCampaign[];
  adSets: StatusAdSet[];
  ads: StatusAd[];
}

/**
 * The ladder. Returns null when the inputs cannot support a verdict — a missing child collection is a
 * sync gap, not a delivery state, and silence is the only honest answer.
 *
 * Account-level rungs precede campaign-level ones because Meta stops delivery at the account level
 * while campaigns keep reporting ACTIVE.
 *
 * Every `every()` and every "none are active" test below is guarded by a non-empty check, because
 * both are vacuously TRUE on an empty collection and would otherwise produce a confident wrong value.
 */
export function deriveStatus(input: StatusInput): MachineStatus | null {
  const { accounts, campaigns, adSets, ads } = input;

  if (accounts.length === 0 || campaigns.length === 0) return null;
  if (accounts.every((a) => a.disabled)) return "Ad Account Disabled";
  if (!accounts.some((a) => a.deliverable)) return "Ad Account Blocked";

  const activeCampaignIds = new Set(campaigns.filter((c) => c.active).map((c) => c.id));
  if (activeCampaignIds.size === 0) return "Paused";

  const setsUnderActive = adSets.filter((s) => activeCampaignIds.has(s.campaignId));
  if (setsUnderActive.length === 0) return null;

  const activeSetIds = new Set(setsUnderActive.filter((s) => s.active).map((s) => s.id));
  if (activeSetIds.size === 0) return "Paused";

  const adsUnderActive = ads.filter((a) => activeSetIds.has(a.adSetId));
  if (adsUnderActive.length === 0) return null;
  if (adsUnderActive.every((a) => a.disapproved)) return "All ads rejected";

  return "Live";
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/lib/delivery-status.test.ts`

Expected: PASS, 16 tests, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/delivery-status.ts src/lib/delivery-status.test.ts
git commit -m "feat: derive delivery status from Meta structure

Pure ladder over accounts, campaigns, ad sets and ads. Missing child
collections return null rather than a verdict, because every() and
'none are active' are vacuously true on an empty collection and would
otherwise report a confident wrong status for an unsynced row."
```

---

## Task 2: Board option constants

`STATUS_PRIORITY` decides which of a client's rows supplies its `activeAccountIds`. An option present
on the board but absent from that map scores 0, loses to `Not started`, and takes the active-account
set from the wrong row — see the comment above the map. This task must therefore land **before** the
options exist on the board.

**Files:**
- Modify: `src/notion/parse.ts`
- Test: `src/notion/parse.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/notion/parse.test.ts`:

```typescript
test("STATUS_PRIORITY ranks every board option, machine states above commercial ones", () => {
  // The map answers "which of a client's rows is the CURRENT engagement". Every machine value
  // describes a current engagement that happens to be broken, so all of them outrank the
  // commercial states.
  const order = Object.entries(STATUS_PRIORITY)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  expect(order).toEqual([
    "Live",
    "All ads rejected",
    "Ad Account Blocked",
    "Ad Account Disabled",
    "Paused",
    "Budget Finished - Top Up",
    "On Boarding",
    "Full Budget Finished",
    "Not started",
  ]);
});

test("every machine and human status is scored", () => {
  for (const s of [...MACHINE_STATUSES, ...HUMAN_STATUSES]) {
    expect(STATUS_PRIORITY[s]).toBeGreaterThan(0);
  }
});

test("LIVE_STATUSES means 'engagement is current', so it holds every machine value", () => {
  for (const s of MACHINE_STATUSES) expect(LIVE_STATUSES).toContain(s);
});

test("LIVE_STATUSES keeps the two human values it already had", () => {
  // Dropping these would silently stop budget maintenance for onboarding and top-up rows.
  expect(LIVE_STATUSES).toContain("On Boarding");
  expect(LIVE_STATUSES).toContain("Budget Finished - Top Up");
});

test("finished and not-started engagements stay outside LIVE_STATUSES", () => {
  expect(LIVE_STATUSES).not.toContain("Full Budget Finished");
  expect(LIVE_STATUSES).not.toContain("Not started");
});
```

Add to that file's existing imports:

```typescript
import { MACHINE_STATUSES, HUMAN_STATUSES } from "@/lib/delivery-status";
```

and add `STATUS_PRIORITY` to the existing `from "./parse"` import list.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test src/notion/parse.test.ts`

Expected: FAIL — `STATUS_PRIORITY` is not exported, and the order assertion does not match.

- [ ] **Step 3: Implement**

In `src/notion/parse.ts`, export the map (it is currently module-private) and replace its body and
`LIVE_STATUSES`:

```typescript
// Highest-priority status wins when a client has multiple board rows. Every option on the board must
// appear here: an unlisted status scores 0 and would lose to "Not started", taking the client's
// active-account set from the wrong row.
//
// The five machine-owned delivery states outrank the commercial ones: each describes an engagement
// that is CURRENT but not delivering, which is a stronger claim to being "today's row" than a
// finished or not-yet-started engagement.
export const STATUS_PRIORITY: Record<string, number> = {
  Live: 9,
  "All ads rejected": 8,
  "Ad Account Blocked": 7,
  "Ad Account Disabled": 6,
  Paused: 5,
  "Budget Finished - Top Up": 4, // still running, just awaiting a top-up
  "On Boarding": 3,
  "Full Budget Finished": 2,
  "Not started": 1,
};

/**
 * Statuses meaning the engagement is CURRENT — keep maintaining this row. Note this is no longer
 * "is delivering": a machine-written `Paused` or `Ad Account Disabled` row is still the client's
 * live engagement, and its pacing columns are still wanted.
 *
 * Every machine-owned value belongs here. That is what stops a machine write from moving `isLive`,
 * which the budget job also uses to assign a shared ad account to whichever row is current.
 */
export const LIVE_STATUSES: readonly string[] = [
  ...MACHINE_STATUSES,
  "Budget Finished - Top Up",
  "On Boarding",
];
```

Add the import at the top of `src/notion/parse.ts` — `delivery-status.ts` imports nothing, so there is
no cycle, and this keeps one list of machine values in the codebase rather than three:

```typescript
import { MACHINE_STATUSES } from "@/lib/delivery-status";
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/notion/parse.test.ts`

Expected: PASS. If a pre-existing test asserted the old `Paused` ranking, update it — the reorder is
intentional and documented in the spec.

- [ ] **Step 5: Typecheck, because `LIVE_STATUSES` is consumed elsewhere**

Run: `bunx tsc --noEmit`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/notion/parse.ts src/notion/parse.test.ts
git commit -m "feat: rank and admit the machine-owned board statuses

LIVE_STATUSES now means 'engagement is current' rather than 'is
delivering', and holds all five machine values, so a machine write can
never move isLive — which the budget job uses to decide which of a
client's rows owns a shared ad account.

Paused therefore moves above Budget Finished - Top Up and On Boarding in
STATUS_PRIORITY. A test pins the full order so the change cannot drift."
```

---

## Task 3: Appending status options through the API

Status options are writable at API version `2025-09-03`, which the client already pins. Groups are
UI-only and option colours cannot be set from the page write, so this appends names and nothing else.

**Files:**
- Modify: `src/notion/client.ts`
- Test: `src/notion/client.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/notion/client.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { NotionClient } from "./client";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch stand-in that records calls and replays queued JSON responses. */
function recorder(responses: unknown[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responses[calls.length - 1] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const schemaWith = (names: string[]) => ({
  properties: {
    "Account Status": {
      id: "biOx",
      name: "Account Status",
      type: "status",
      status: { options: names.map((name, i) => ({ id: `id${i}`, name, color: "default" })) },
    },
  },
});

test("addStatusOptions appends only the missing options and keeps the existing ones", async () => {
  const { calls, impl } = recorder([schemaWith(["Live", "Paused"]), {}]);
  const client = new NotionClient("tok", impl);

  const added = await client.addStatusOptions("ds1", "Account Status", [
    "Live",
    "All ads rejected",
    "Ad Account Blocked",
  ]);

  expect(added).toEqual(["All ads rejected", "Ad Account Blocked"]);
  expect(calls[1].method).toBe("PATCH");
  const sent = calls[1].body as {
    properties: { "Account Status": { status: { options: { name: string }[] } } };
  };
  expect(sent.properties["Account Status"].status.options.map((o) => o.name)).toEqual([
    "Live",
    "Paused",
    "All ads rejected",
    "Ad Account Blocked",
  ]);
});

test("addStatusOptions makes no write when every option already exists", async () => {
  const { calls, impl } = recorder([schemaWith(["Live", "Paused"])]);
  const client = new NotionClient("tok", impl);

  const added = await client.addStatusOptions("ds1", "Account Status", ["Live", "Paused"]);

  expect(added).toEqual([]);
  expect(calls).toHaveLength(1); // read only, no PATCH
});

test("addStatusOptions matches option names case-insensitively", async () => {
  // Notion requires option names to be unique case-insensitively, so "live" is not addable
  // alongside "Live" — attempting it would 400.
  const { calls, impl } = recorder([schemaWith(["Live"])]);
  const client = new NotionClient("tok", impl);

  expect(await client.addStatusOptions("ds1", "Account Status", ["live"])).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("addStatusOptions rejects a name containing a comma", async () => {
  // Commas are not valid in Notion option names; failing loudly beats a 400 from the API.
  const { impl } = recorder([schemaWith(["Live"])]);
  const client = new NotionClient("tok", impl);

  await expect(client.addStatusOptions("ds1", "Account Status", ["a,b"])).rejects.toThrow("comma");
});

test("addStatusOptions throws when the property is not a status property", async () => {
  const { impl } = recorder([
    { properties: { "Account Status": { id: "x", name: "Account Status", type: "select" } } },
  ]);
  const client = new NotionClient("tok", impl);

  await expect(client.addStatusOptions("ds1", "Account Status", ["Live"])).rejects.toThrow("status");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test src/notion/client.test.ts`

Expected: FAIL — `client.addStatusOptions is not a function`.

- [ ] **Step 3: Implement**

Add to the `NotionClient` class in `src/notion/client.ts`, after `createProperty`:

```typescript
  /**
   * Append missing options to an existing `status` property, returning the names actually added.
   *
   * Writable from API version 2025-09-03 onward, which this client pins. Only names are sent:
   * `group` is omitted so existing options keep their current group and new ones inherit the
   * default, and colours are not settable this way. Existing options are always resent unchanged —
   * the array replaces the property's option list, so dropping one would delete it from the board.
   */
  async addStatusOptions(
    dataSourceId: string,
    propName: string,
    names: string[],
  ): Promise<string[]> {
    for (const n of names) {
      if (n.includes(",")) throw new Error(`Notion status option "${n}" cannot contain a comma`);
    }
    const res = await this.req(`/data_sources/${dataSourceId}`);
    const props = (res.properties ?? {}) as Record<string, Record<string, unknown>>;
    const prop = props[propName];
    if (!prop) throw new Error(`No "${propName}" property on data source ${dataSourceId}`);
    if (prop.type !== "status") {
      throw new Error(`"${propName}" is a ${String(prop.type)} property, not a status property`);
    }
    const current = ((prop.status as { options?: { name: string }[] } | undefined)?.options ??
      []) as { name: string }[];
    const have = new Set(current.map((o) => o.name.toLowerCase()));
    const missing = names.filter((n) => !have.has(n.toLowerCase()));
    if (missing.length === 0) return [];
    await this.req(`/data_sources/${dataSourceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          [propName]: {
            status: {
              options: [
                ...current.map((o) => ({ name: o.name })),
                ...missing.map((name) => ({ name })),
              ],
            },
          },
        },
      }),
    });
    return missing;
  }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test src/notion/client.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/notion/client.ts src/notion/client.test.ts
git commit -m "feat: append status options to a Notion status property

Resends existing options unchanged because the array replaces the
property's option list — omitting one deletes it from the board. Matches
names case-insensitively and rejects commas, both of which Notion
enforces and would otherwise surface as an opaque 400."
```

---

## Task 4: The override table

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add the table**

Append to `src/db/schema.ts`:

```typescript
/**
 * Admin-forced `Account Status` for one Notion board row, overriding the derived value.
 *
 * Deliberately NOT foreign-keyed, for the same reason as `campaignClientOverrides`: a cascade would
 * silently erase an operator's correction, and a row pointing at a page that no longer exists is
 * simply ignored. Keyed by page id rather than client id because the Notion sync re-keys client ids.
 *
 * `status` must be one of `MACHINE_STATUSES`. Pinning a human-owned value is just editing Notion,
 * and permitting it here would break the disjoint-set invariant the whole feature rests on.
 */
export const notionStatusOverrides = pgTable("notion_status_overrides", {
  pageId: text("page_id").primaryKey(),
  status: text("status").notNull(),
  setBy: text("set_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`

Expected: clean.

- [ ] **Step 3: Apply the schema — READ THIS FIRST**

`DATABASE_URL` in local dev points at **production** Postgres through an SSH tunnel. There is no
staging copy. Open the tunnel, confirm what you are pointed at, then push:

```bash
# in a second terminal
ssh -N -L 127.0.0.1:5432:127.0.0.1:5432 <droplet>

# then
bunx drizzle-kit push
```

Expected: one `CREATE TABLE notion_status_overrides` statement, and **no** `DROP` or `ALTER` on any
other table. If the plan output touches anything else, abort and investigate — do not accept.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat: add notion_status_overrides table

Keyed by Notion page id, not client id, because the sync re-keys client
ids. No foreign key, matching campaign_client_overrides: a cascade would
erase an operator's correction."
```

---

## Task 5: Override server functions

**Files:**
- Create: `src/server/fns/account-status.ts`

- [ ] **Step 1: Implement**

Follows the established shape in `src/server/fns/settings.ts`: plain exported async functions,
`await requireAdmin()` first, `audit()` on every mutation.

Create `src/server/fns/account-status.ts`:

```typescript
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireAdmin, audit } from "./auth";
import { isMachineStatus, MACHINE_STATUSES, type MachineStatus } from "@/lib/delivery-status";

export interface StatusOverrideView {
  pageId: string;
  status: MachineStatus;
  setBy: string | null;
  createdAt: string;
}

/** Every override currently in force, newest first. Admin-only. */
export async function fetchStatusOverrides(): Promise<StatusOverrideView[]> {
  await requireAdmin();
  const rows = await db.select().from(schema.notionStatusOverrides);
  return rows
    .filter((r): r is typeof r & { status: MachineStatus } => isMachineStatus(r.status))
    .map((r) => ({
      pageId: r.pageId,
      status: r.status,
      setBy: r.setBy,
      createdAt: r.createdAt.toISOString(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Pin one board row to a machine-owned status. Rejects human-owned values: those are set by editing
 * Notion directly, and accepting them here would put a value in both ownership sets.
 */
export async function setStatusOverride(data: {
  pageId: string;
  status: string;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  if (!data.pageId.trim()) return { ok: false, error: "No page id" };
  if (!isMachineStatus(data.status)) {
    return {
      ok: false,
      error: `Only machine-owned statuses can be pinned: ${MACHINE_STATUSES.join(", ")}`,
    };
  }
  await db
    .insert(schema.notionStatusOverrides)
    .values({ pageId: data.pageId, status: data.status, setBy: user.email })
    .onConflictDoUpdate({
      target: schema.notionStatusOverrides.pageId,
      set: { status: data.status, setBy: user.email, createdAt: new Date() },
    });
  await audit("accountStatus.override", `pinned ${data.pageId} to ${data.status}`);
  return { ok: true };
}

/** Hand a row back to the derivation. */
export async function clearStatusOverride(data: {
  pageId: string;
}): Promise<{ ok: true }> {
  await requireAdmin();
  await db
    .delete(schema.notionStatusOverrides)
    .where(eq(schema.notionStatusOverrides.pageId, data.pageId));
  await audit("accountStatus.override", `cleared override on ${data.pageId}`);
  return { ok: true };
}
```

- [ ] **Step 2: Check `requireAdmin`'s return shape**

Run: `bunx tsc --noEmit`

Expected: clean. If `requireAdmin()` does not return a user with `email`, read
`src/server/fns/auth.ts` and use whatever identity it does expose for `setBy`; do not invent a field.

- [ ] **Step 3: Commit**

```bash
git add src/server/fns/account-status.ts
git commit -m "feat: admin server fns for Account Status overrides

Only machine-owned values are pinnable; human-owned values are set by
editing Notion, and accepting them here would put one value in both
ownership sets and break provenance-by-value."
```

---

## Task 6: Derive and write it in the sync job

**Do not start until the PREREQUISITE at the top is satisfied.**

**Files:**
- Modify: `src/sync/jobs/notion-budget.ts`
- Test: `src/sync/jobs/notion-budget.test.ts`

Anchors are given as code to search for, not line numbers — that file is being edited concurrently.

- [ ] **Step 1: Widen the ad-set query**

Find:

```typescript
        .select({ campaignId: schema.adSets.campaignId, dailyBudget: schema.adSets.dailyBudget })
        .from(schema.adSets)
        .where(eq(schema.adSets.effectiveStatus, "ACTIVE")),
```

Replace with:

```typescript
        // Not filtered to ACTIVE: the status ladder must tell "no ad set is active" apart from "no
        // ad set has synced", and only the unfiltered set can. Budget summing filters in memory.
        .select({
          id: schema.adSets.id,
          campaignId: schema.adSets.campaignId,
          dailyBudget: schema.adSets.dailyBudget,
          effectiveStatus: schema.adSets.effectiveStatus,
        })
        .from(schema.adSets),
```

- [ ] **Step 2: Keep `sumDailyBudget` seeing only active ad sets**

`sumDailyBudget` assumes every row it is handed is active. Immediately after the destructuring of the
query results, derive the filtered list and pass **that** to every `sumDailyBudget` call:

```typescript
  // sumDailyBudget assumes its ad sets are live; the ladder needs all of them.
  const activeAdSetRows = adSetRows.filter((s) => s.effectiveStatus === "ACTIVE");
```

Then update all three call sites — search for `sumDailyBudget(` and pass `activeAdSetRows` in place
of `adSetRows`.

- [ ] **Step 3: Run the existing job tests to prove nothing regressed**

Run: `bun test src/sync/jobs/notion-budget.test.ts --timeout 60000`

Expected: PASS. The `sumDailyBudget` tests pass ad sets directly and are unaffected; a failure here
means step 2 missed a call site.

- [ ] **Step 4: Add the ads query**

Beside the existing ads query (the one joined through `adSets` and `adCreatives` and filtered to
`eq(schema.ads.effectiveStatus, "ACTIVE")` — leave it alone, it feeds creative/destination logic),
add a second, narrow one to the same `Promise.all`:

```typescript
      db
        .select({
          adSetId: schema.ads.adSetId,
          effectiveStatus: schema.ads.effectiveStatus,
        })
        .from(schema.ads),
```

Name the destructured result `allAdRows`.

- [ ] **Step 5: Write the failing test for the row-level derivation**

The job is not unit-testable end to end, so test the glue: a helper that turns one row's already
resolved pieces into a status. Add to `src/sync/jobs/notion-budget.test.ts`:

```typescript
test("statusForRow returns null when the row has no override and no verdict", () => {
  expect(
    statusForRow({
      accounts: [],
      campaigns: [],
      adSets: [],
      ads: [],
      current: "Live",
      override: null,
    }),
  ).toBeNull();
});

test("statusForRow never overwrites a human-owned value, even with an override set", () => {
  // The one rule with no exceptions: a human-owned value on the board beats everything.
  expect(
    statusForRow({
      accounts: [{ disabled: false, deliverable: true }],
      campaigns: [{ id: "c1", active: true }],
      adSets: [{ id: "s1", campaignId: "c1", active: true }],
      ads: [{ adSetId: "s1", disapproved: false }],
      current: "Full Budget Finished",
      override: "Paused",
    }),
  ).toBeNull();
});

test("statusForRow prefers the override over the derived value", () => {
  expect(
    statusForRow({
      accounts: [{ disabled: false, deliverable: true }],
      campaigns: [{ id: "c1", active: true }],
      adSets: [{ id: "s1", campaignId: "c1", active: true }],
      ads: [{ adSetId: "s1", disapproved: true }],
      current: "All ads rejected",
      override: "Live",
    }),
  ).toBe("Live");
});

test("statusForRow fills an empty cell", () => {
  expect(
    statusForRow({
      accounts: [{ disabled: false, deliverable: true }],
      campaigns: [{ id: "c1", active: true }],
      adSets: [{ id: "s1", campaignId: "c1", active: true }],
      ads: [{ adSetId: "s1", disapproved: false }],
      current: null,
      override: null,
    }),
  ).toBe("Live");
});

test("statusForRow returns null when the derived value already matches the cell", () => {
  // An unchanged cell is never rewritten, so Last edited time keeps meaning "a human edited this".
  expect(
    statusForRow({
      accounts: [{ disabled: false, deliverable: true }],
      campaigns: [{ id: "c1", active: true }],
      adSets: [{ id: "s1", campaignId: "c1", active: true }],
      ads: [{ adSetId: "s1", disapproved: false }],
      current: "Live",
      override: null,
    }),
  ).toBeNull();
});
```

Add `statusForRow` to that file's existing import from `./notion-budget`.

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test src/sync/jobs/notion-budget.test.ts --timeout 60000`

Expected: FAIL — `statusForRow` is not exported.

- [ ] **Step 7: Implement `statusForRow`**

Add to `src/sync/jobs/notion-budget.ts`, near `planRow`:

```typescript
/**
 * The status to WRITE for one row, or null to leave the cell alone.
 *
 * Ownership is read straight off the current value, which is why the machine and human sets must stay
 * disjoint. This gate is deliberately separate from `notLive`/`isLive`: that one governs the four
 * numeric columns, and `notLive(null)` is true, so reusing it would mean an empty `Account Status`
 * could never be populated.
 */
export function statusForRow(args: {
  accounts: StatusAccount[];
  campaigns: StatusCampaign[];
  adSets: StatusAdSet[];
  ads: StatusAd[];
  current: string | null;
  override: string | null;
}): MachineStatus | null {
  // A human-owned value beats everything, including an override.
  if (args.current !== null && !isMachineStatus(args.current)) return null;
  const next = isMachineStatus(args.override)
    ? args.override
    : deriveStatus({
        accounts: args.accounts,
        campaigns: args.campaigns,
        adSets: args.adSets,
        ads: args.ads,
      });
  if (next === null || next === args.current) return null;
  return next;
}
```

Add the import:

```typescript
import {
  deriveStatus,
  isMachineStatus,
  type MachineStatus,
  type StatusAccount,
  type StatusCampaign,
  type StatusAdSet,
  type StatusAd,
} from "@/lib/delivery-status";
```

- [ ] **Step 8: Run it and watch it pass**

Run: `bun test src/sync/jobs/notion-budget.test.ts --timeout 60000`

Expected: PASS.

- [ ] **Step 9: Commit the derivation glue**

```bash
git add src/sync/jobs/notion-budget.ts src/sync/jobs/notion-budget.test.ts
git commit -m "feat: decide the Account Status to write per board row

Ownership is read off the current cell value, so the gate is separate
from isLive: notLive(null) is true, and reusing it would leave an empty
Account Status permanently unpopulated."
```

- [ ] **Step 10: Resolve the column, without marking it**

Inside the per-data-source loop, beside the `ensureColumn` calls, resolve `Account Status` by name
only — it must never be renamed to a `🤖` name, because humans still own values in it:

```typescript
    // Resolved, never ensured: the 🤖 marker means "machine-written, do not hand-edit", which is
    // false for a column humans still set commercial values in.
    const statusKey = resolvePropertyKey(Object.keys(props), "Account Status");
    const statusCol = statusKey ? props[statusKey] : undefined;
    if (statusCol && !opts.dryRun) {
      await notion.addStatusOptions(dataSourceId, statusKey!, [...MACHINE_STATUSES]);
    }
```

Import `MACHINE_STATUSES` alongside the other `@/lib/delivery-status` imports.

- [ ] **Step 11: Load the overrides once per run**

Before the per-row loop:

```typescript
  const overrideRows = await db.select().from(schema.notionStatusOverrides);
  const overrideByPage = new Map(overrideRows.map((o) => [o.pageId, o.status]));
```

- [ ] **Step 12: Derive in the RowWork loop, not the write loop**

This job computes a plan per row, then writes plans in a second pass. `mine`, `accountById`,
`adSetRows` and `allAdRows` are in scope only in the **first** loop; the write loop has just `w` and
`row`. So the status is derived alongside `budget`/`spend`/`funds`/`end`/`dest` and carried on
`RowWork`.

First extend the `RowWork` interface — add beside its `dest` field:

```typescript
      status: MachineStatus | null;
```

In the orphan-row block (the loop over `orphans` that pushes `RowWork` with `noMapping` skips), add:

```typescript
        status: null,
```

Then in the main per-row block, immediately before the `work.push({ … })` call that carries `dest`,
compute it:

```typescript
        // Not gated on isLive: that governs the four numeric columns, and notLive(null) is true, so
        // reusing it would leave an empty Account Status permanently unpopulated. Ownership is read
        // off the cell's current value instead.
        const statusNext = statusForRow({
          accounts: row.accountIds.flatMap((a) => {
            const acct = accountById.get(a);
            return acct
              ? [
                  {
                    disabled: accountStatus(acct.status) === "DISABLED",
                    deliverable: canDeliver(acct),
                  },
                ]
              : [];
          }),
          campaigns: mine.map((c) => ({ id: c.id, active: c.active })),
          adSets: adSetRows.map((s) => ({
            id: s.id,
            campaignId: s.campaignId,
            active: s.effectiveStatus === "ACTIVE",
          })),
          ads: allAdRows.map((a) => ({
            adSetId: a.adSetId,
            disapproved: a.effectiveStatus === "DISAPPROVED",
          })),
          current: row.status,
          override: overrideByPage.get(row.pageId) ?? null,
        });
```

and add `status: statusNext` to that `work.push({ … })` object.

`row.status` is already the row's current `Account Status` — it is what `detail.status` is set from in
the write loop. Do **not** add a `statusCurrent` field.

- [ ] **Step 13: Report and write it**

Add to the `NotionBudgetRow` interface, following the file's `*Written` naming:

```typescript
  /** Derived delivery status written to `Account Status`, or null when the cell was left alone. */
  statusWritten: MachineStatus | null;
```

In the write loop, destructure `status` from `w`:

```typescript
      const { row, sum, budget, spend, funds, end, dest, status } = w;
```

initialise the detail field beside `status: row.status`:

```typescript
        statusWritten: null,
```

and after the `endCol` write block, add the write itself:

```typescript
      if (status && statusCol) {
        if (!opts.dryRun) {
          await notion.setPageValue(row.pageId, statusCol.id, { status: { name: status } });
          await sleep(WRITE_GAP_MS);
        }
        detail.statusWritten = status;
        result.updated += 1;
      }
```

- [ ] **Step 14: Typecheck and lint**

Run: `bunx tsc --noEmit && bun run lint`

Expected: both clean.

- [ ] **Step 15: Dry run against the live board**

The board is shared with the whole team, so the first real write happens only after this looks right.
With the SSH tunnel open:

```bash
bun -e 'import("./src/sync/jobs/notion-budget").then(m => m.syncNotionDailyBudgets(undefined, { dryRun: true }).then(r => console.log(JSON.stringify(r, null, 2))))'
```

Expected: every `statusWritten` in the per-row detail is either null or one of the five
`MACHINE_STATUSES`; no row whose `status` is a human-owned value has a non-null `statusWritten`; and
`columnsTouched` contains no rename of `Account Status`. Read the output before continuing.

- [ ] **Step 16: Commit**

```bash
git add src/sync/jobs/notion-budget.ts
git commit -m "feat: write the derived Account Status to the Notion board

Bootstraps the three new options first, resolves the column by name
without the 🤖 rename, and writes only when the value changes so Last
edited time keeps meaning a human touched the row."
```

---

## Task 7: Override UI

`ClientDetailView` is **presentational** — it takes `detail`, `budgets`, `isAdmin`, and handler props
(`onMutate`, `onMoveCampaign`), and the route owns the server calls. Follow that: the component gets
data and callbacks, `src/routes/clients.$id.tsx` does the wiring. Do not call a server fn from inside
the component.

`ClientDetail` does not currently expose Notion page ids, and the override is keyed by page id, so
that comes first.

**Files:**
- Modify: `src/server/fns/clients.ts`
- Modify: `src/components/dashboard/ClientDetailView.tsx`
- Modify: `src/routes/clients.$id.tsx`

- [ ] **Step 1: Expose the client's board rows**

`clients.raw` holds the contributing Notion rows as `{ pageId, title }[]` — the same array
`brandTitles` reads. Add a sibling parser in `src/notion/parse.ts`, beside `brandTitles`:

```typescript
/**
 * The contributing Notion rows stored on `clients.raw`, with the page id and each row's OWN
 * `Account Status`. `ClubbedClient.pages` already stores all three, so nothing new has to be synced —
 * and the row's own status is what decides whether an override on it is inert. The clubbed client
 * status is a different thing (the winning row's) and must not be substituted for it.
 */
export function boardRows(raw: unknown): { pageId: string; title: string; status: string | null }[] {
  if (!Array.isArray(raw)) return [];
  const out: { pageId: string; title: string; status: string | null }[] = [];
  for (const p of raw) {
    if (p && typeof p === "object" && typeof (p as { pageId?: unknown }).pageId === "string") {
      const r = p as { pageId: string; title?: unknown; status?: unknown };
      out.push({
        pageId: r.pageId,
        title: typeof r.title === "string" ? r.title : "",
        status: typeof r.status === "string" ? r.status : null,
      });
    }
  }
  return out;
}
```

Test it in `src/notion/parse.test.ts`:

```typescript
test("boardRows keeps page ids and each row's own status", () => {
  expect(
    boardRows([
      { pageId: "p1", title: "Slots.lv", status: "Live" },
      { pageId: "p2", title: "No status" },
      { title: "no id" },
      null,
    ]),
  ).toEqual([
    { pageId: "p1", title: "Slots.lv", status: "Live" },
    { pageId: "p2", title: "No status", status: null },
  ]);
  expect(boardRows(null)).toEqual([]);
  expect(boardRows("not-an-array")).toEqual([]);
});
```

Run: `bun test src/notion/parse.test.ts` — watch it fail on the missing export, implement, watch it
pass.

Then in `src/server/fns/clients.ts`, add to the `ClientDetail` interface:

```typescript
  /** The Notion board rows behind this client, for admin status overrides. */
  notionRows: { pageId: string; title: string; status: string | null }[];
```

and populate it where `brands` is built in the detail fn (the one returning `ClientDetail`, not the
list fn):

```typescript
      notionRows: boardRows(r.raw),
```

importing `boardRows` alongside the existing `brandTitles` import.

- [ ] **Step 2: Add the props to the component**

In `src/components/dashboard/ClientDetailView.tsx`, extend `Props`:

```typescript
  /** Page id -> pinned status, admin only. */
  statusOverrides?: Record<string, string>;
  onSetStatusOverride?: (
    pageId: string,
    status: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
```

and add both to the destructured parameter list.

- [ ] **Step 3: Render the control**

Add this component at the bottom of the file, beside `Kpi`:

Import the value sets rather than restating them — one list in the codebase, not three:

```typescript
import { MACHINE_STATUSES, HUMAN_STATUSES } from "@/lib/delivery-status";
```

```typescript
function StatusOverrideRow({
  pageId,
  title,
  boardStatus,
  override,
  onSet,
}: {
  pageId: string;
  title: string;
  boardStatus: string | null;
  override: string | undefined;
  onSet: (pageId: string, status: string | null) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A human-owned value on the board beats everything, including an override.
  const shadowed = boardStatus !== null && (HUMAN_STATUSES as readonly string[]).includes(boardStatus);

  async function change(value: string) {
    setBusy(true);
    setError(null);
    const res = await onSet(pageId, value === "" ? null : value);
    if (!res.ok) setError(res.error ?? "Failed");
    setBusy(false);
  }

  return (
    <div className="flex items-center gap-3 py-1 text-sm">
      <span className="min-w-0 flex-1 truncate">{title || pageId}</span>
      <span className="text-muted-foreground">{boardStatus ?? "—"}</span>
      <select
        className="rounded border bg-background px-2 py-1"
        value={override ?? ""}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="">No override</option>
        {MACHINE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {shadowed && override && (
        <span className="flex items-center gap-1 text-amber-600" title="A human-owned status on the board takes precedence; this override will not be applied until the board value is a machine-owned one.">
          <AlertTriangle className="h-3.5 w-3.5" />
          inert
        </span>
      )}
      {error && <span className="text-destructive">{error}</span>}
    </div>
  );
}
```

`useState` and `AlertTriangle` are already imported at the top of the file.

Then render the section inside the main component, gated on admin and on the handler being supplied —
the same shape the file already uses for `moveTargets` / `onMoveCampaign`:

```typescript
      {isAdmin && onSetStatusOverride && detail.notionRows.length > 0 && (
        <section className="rounded-lg border p-4">
          <h3 className="mb-2 text-sm font-medium">Account Status overrides</h3>
          <p className="mb-2 text-xs text-muted-foreground">
            The sync derives this column from Meta each hour. Pin a row to hold a value; clear it to
            hand the row back. Rows sitting on a commercial status are never touched by the sync.
          </p>
          {detail.notionRows.map((r) => (
            <StatusOverrideRow
              key={r.pageId}
              pageId={r.pageId}
              title={r.title}
              boardStatus={r.status}
              override={statusOverrides?.[r.pageId]}
              onSet={onSetStatusOverride}
            />
          ))}
        </section>
      )}
```

- [ ] **Step 4: Wire the route**

In `src/routes/clients.$id.tsx`, load the overrides in the same loader that already fetches `detail`
and `budgets`, and pass a handler down beside the existing `onMutate`:

`overrides` below is the result of `fetchStatusOverrides()`, added to whatever the route already calls
in its loader alongside `detail` and `budgets`:

```typescript
        statusOverrides={Object.fromEntries(
          overrides.map((o) => [o.pageId, o.status] as const),
        )}
        onSetStatusOverride={async (pageId, status) => {
          const res =
            status === null
              ? await clearStatusOverride({ data: { pageId } })
              : await setStatusOverride({ data: { pageId, status } });
          await router.invalidate();
          return "ok" in res ? res : { ok: true };
        }}
```

Match the file's existing call convention for server functions exactly — copy how `onMutate` invokes
its server fn, including whether arguments are wrapped in `{ data: … }`, and how it refreshes
afterwards. If `onMutate` uses a different refresh mechanism than `router.invalidate()`, use that one.

- [ ] **Step 5: Typecheck and lint**

Run: `bunx tsc --noEmit && bun run lint`

Expected: both clean.

- [ ] **Step 6: Verify in the browser**

Run `bun run dev`, open a client with several board rows as an admin, set an override, and confirm it
survives a reload. Then set that row's `Account Status` in Notion to `Full Budget Finished`, re-run
the Notion client sync from Settings, and confirm the override renders as `inert`.

- [ ] **Step 7: Commit**

```bash
git add src/notion/parse.ts src/notion/parse.test.ts src/server/fns/clients.ts src/components/dashboard/ClientDetailView.tsx src/routes/clients.$id.tsx
git commit -m "feat: admin control for pinning a row's Account Status

Exposes the client's Notion page ids, which ClientDetail did not carry,
and shows an override as inert when the board sits on a human-owned
status — that value wins over any override, so silently accepting one
would be a lie."
```

---

## Task 8: Rollout

Order is a correctness requirement, not hygiene — an option on the board that `STATUS_PRIORITY` does
not score takes a client's active-account set from the wrong row.

- [ ] **Step 1: Confirm Task 2 is deployed before any option exists on the board**

```bash
git log --oneline -1 origin/feat/meta-integration
ssh <droplet> "cd /opt/meta-dashboard && git rev-parse HEAD"
```

Both must include the Task 2 commit.

- [ ] **Step 2: Deploy**

```bash
git push origin feat/meta-integration && git push droplet feat/meta-integration
ssh <droplet> "EXPECT=$(git rev-parse HEAD) bash /opt/meta-dashboard/deploy/deploy.sh"
```

`meta-sync` must restart, which the script handles — the job only picks up new code on restart.

- [ ] **Step 3: Watch the first real cycle**

```bash
ssh <droplet> "journalctl -u meta-sync -n 200 --no-pager | grep -i notion"
```

Then open the board and confirm: no row previously on a human-owned value has changed, and rows that
changed match what the dry run predicted.

- [ ] **Step 4: Verify the invariant that matters most**

Pick a client with several successive engagement rows (`betonline.ag` and `acrpoker.eu` both have
three) and confirm its `activeAccountIds` did not move after the priority reorder:

```sql
SELECT id, status, notion_active_account_ids FROM clients WHERE id LIKE 'betonline%';
```

Compare against the same query captured before deploying. A change here means the reorder shifted
attribution and must be investigated before the next cycle.
