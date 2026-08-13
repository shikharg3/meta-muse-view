# Infrastructure Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an operator-owned registry of the Meta asset graph (Facebook profiles → Business Managers → ad accounts, plus pixels and pages) with a redundancy risk map, inside MetaConsole.

**Architecture:** Eleven new `infra_`-prefixed Postgres tables with real foreign keys — no sync job writes any of them. Ad-account status is the single exception to manual entry: it is `LEFT JOIN`ed read-only from the existing `accounts` table. Risk is computed by one pure module, called server-side only, so no two screens can disagree. Admin-gated in both the route loader and every server fn.

**Tech Stack:** TanStack Start (React 19, SSR via Nitro) · Drizzle ORM + Postgres · Bun test · Tailwind v4 + shadcn primitives.

**Design spec:** `docs/superpowers/specs/2026-08-13-infrastructure-monitor-design.md`

---

## Deviation from the writing-plans skill, stated up front

Tasks 1–11 carry complete code. Tasks 13–16 (the four list routes after the first) specify exact
columns, form fields, server fns and link editors **without** re-inlining a full component body, because
those four routes are the same shape as Task 12 with different fields, and Task 12's code is the
reference. This is a deliberate, disclosed deviation from "repeat the code" — inlining four ~250-line
near-duplicates would make the plan harder to execute correctly, not easier. Every field, column and
call is still enumerated, so nothing is left to invention.

## Ground rules for every task

- **TDD is mandatory where a test is possible.** Pure logic (Tasks 1–2) and DB behaviour (Task 5) are
  test-first: write the test, run it, watch it fail for the right reason, then implement. Route
  components are verified by browser smoke test (Task 18) — this codebase has zero component tests and
  this feature will not introduce a new testing convention.
- **`bun test` is destructive** and runs against `TEST_DATABASE_URL`. Never point it at production.
- **Local `DATABASE_URL` is production** through an SSH tunnel. The only schema command you run against
  it is the final additive `push` in Task 4, after the test database has proved it.
- **No `any`.** No `pgEnum`. No toasts. No `react-hook-form`. No zod for server-fn payloads. These are
  existing codebase conventions, verified — deviating makes the feature look foreign.
- Commit after every task. Conventional commits. Stage explicitly, never `git add -A`.
- Branch is `feat/infra-monitor`, already created and pushed.

---

## File structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `src/lib/infra-status.ts` | The five status vocabularies + type guards. Pure, client-safe. |
| `src/lib/infra-status.test.ts` | Vocabulary pinning + compile-time exhaustiveness. |
| `src/lib/infra-risk.ts` | Redundancy rule, usability predicates, per-entity risk precedence. Pure. |
| `src/lib/infra-risk.test.ts` | Every boundary and every ordered branch. |
| `src/server/fns/infra/events.ts` | Status-event + audit writer, shared by every mutation. |
| `src/server/fns/infra/risk.ts` | Risk-map read model: 10 selects, risk computed in memory. |
| `src/server/fns/infra/profiles.ts` | Profile reads + mutations. |
| `src/server/fns/infra/bms.ts` | BM reads + mutations + detail view with history. |
| `src/server/fns/infra/ad-accounts.ts` | Ad-account registry reads (joined to `accounts`) + mutations. |
| `src/server/fns/infra/pixels.ts` | Pixel reads + mutations. |
| `src/server/fns/infra/pages.ts` | Page reads + mutations. |
| `src/server/fns/infra/infra.db.test.ts` | DB-backed: cascade, restrict, uniqueness, event writing. |
| `src/lib/api/infrastructure.ts` | The thin `createServerFn` client surface. Import-light. |
| `src/components/infra/LinkChips.tsx` | The M:N link editor shared by five screens. |
| `src/components/infra/RiskBadge.tsx` | Risk level → styled badge. |
| `src/routes/infrastructure.index.tsx` | Counts + risk map. |
| `src/routes/infrastructure.profiles.tsx` | Profiles list. |
| `src/routes/infrastructure.business-managers.tsx` | BMs list. |
| `src/routes/infrastructure.business-managers.$id.tsx` | BM detail: access chain + status history. |
| `src/routes/infrastructure.ad-accounts.tsx` | Ad-account registry with joined live status. |
| `src/routes/infrastructure.pixels.tsx` | Pixels list. |
| `src/routes/infrastructure.pages.tsx` | Pages list. |

**Modify:**

| Path | Change |
| --- | --- |
| `src/db/schema.ts` | Append eleven tables at the end. |
| `src/components/dashboard/StatusPill.tsx` | Extend `styles` and `dots` maps with the new statuses. |
| `src/components/layout/AppSidebar.tsx` | Add a third `<SidebarGroup>` labelled "Infrastructure", admin-gated. |

---

## Task 1: Status vocabularies

**Files:**
- Create: `src/lib/infra-status.ts`
- Test: `src/lib/infra-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/infra-status.test.ts
import { describe, expect, test } from "bun:test";
import {
  PROFILE_STATUSES,
  BM_STATUSES,
  PIXEL_STATUSES,
  PAGE_STATUSES,
  AD_ACCOUNT_USAGE,
  isProfileStatus,
  isBmStatus,
  isPixelStatus,
  isPageStatus,
  isAdAccountUsage,
} from "./infra-status";

describe("vocabularies", () => {
  // Pinned so a reorder or a silent removal is a test failure, not a surprise in the UI.
  test("profile statuses are exactly the six agreed values", () => {
    expect([...PROFILE_STATUSES]).toEqual([
      "new",
      "active",
      "in_review",
      "suspended",
      "banned",
      "retired",
    ]);
  });

  test("bm statuses are exactly the five agreed values", () => {
    expect([...BM_STATUSES]).toEqual([
      "pending_verification",
      "active",
      "in_review",
      "restricted",
      "banned",
    ]);
  });

  test("pixel statuses are exactly the three agreed values", () => {
    expect([...PIXEL_STATUSES]).toEqual(["active", "inactive", "restricted"]);
  });

  test("page statuses are exactly the five agreed values", () => {
    expect([...PAGE_STATUSES]).toEqual([
      "active",
      "in_review",
      "restricted",
      "banned",
      "unpublished",
    ]);
  });

  test("ad account usage states are exactly the three agreed values", () => {
    expect([...AD_ACCOUNT_USAGE]).toEqual(["in_use", "spare", "retired"]);
  });
});

describe("guards", () => {
  test("each guard accepts its own vocabulary and nothing else", () => {
    for (const s of PROFILE_STATUSES) expect(isProfileStatus(s)).toBe(true);
    for (const s of BM_STATUSES) expect(isBmStatus(s)).toBe(true);
    for (const s of PIXEL_STATUSES) expect(isPixelStatus(s)).toBe(true);
    for (const s of PAGE_STATUSES) expect(isPageStatus(s)).toBe(true);
    for (const s of AD_ACCOUNT_USAGE) expect(isAdAccountUsage(s)).toBe(true);
  });

  test("guards reject foreign values, empty string, null and undefined", () => {
    expect(isProfileStatus("pending_verification")).toBe(false); // a BM status, not a profile one
    expect(isBmStatus("suspended")).toBe(false); // a profile status, not a BM one
    expect(isPixelStatus("banned")).toBe(false); // pixels are never banned
    expect(isPageStatus("inactive")).toBe(false);
    expect(isAdAccountUsage("active")).toBe(false);
    expect(isProfileStatus("")).toBe(false);
    expect(isProfileStatus(null)).toBe(false);
    expect(isProfileStatus(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/infra-status.test.ts`
Expected: FAIL — `Cannot find module './infra-status'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/infra-status.ts
/**
 * Status vocabularies for the infrastructure registry.
 *
 * Pure and client-safe: imports nothing, so route components and server fns share one definition.
 *
 * Per-entity vocabularies rather than one shared enum, because the words differ in kind — Facebook
 * *suspends* profiles and *restricts* BMs, and a pixel is never banned. The rule that keeps this from
 * sprawling: EVERY value must participate in at least one rule in `infra-risk.ts`. A status that
 * classifies nothing is invisible everywhere except its own badge, which is worse than not having it.
 *
 * `text` columns plus these guards, deliberately not `pgEnum`: migrations here are push-only, which
 * makes an enum change a manual `ALTER TYPE`.
 */

/** A Facebook personal profile used to administer BMs. */
export const PROFILE_STATUSES = [
  "new",
  "active",
  "in_review",
  "suspended",
  "banned",
  "retired",
] as const;

export const BM_STATUSES = [
  "pending_verification",
  "active",
  "in_review",
  "restricted",
  "banned",
] as const;

export const PIXEL_STATUSES = ["active", "inactive", "restricted"] as const;

export const PAGE_STATUSES = [
  "active",
  "in_review",
  "restricted",
  "banned",
  "unpublished",
] as const;

/** Operator-owned lifecycle for a registered ad account. Not a Meta concept. */
export const AD_ACCOUNT_USAGE = ["in_use", "spare", "retired"] as const;

export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export type BmStatus = (typeof BM_STATUSES)[number];
export type PixelStatus = (typeof PIXEL_STATUSES)[number];
export type PageStatus = (typeof PAGE_STATUSES)[number];
export type AdAccountUsage = (typeof AD_ACCOUNT_USAGE)[number];

/** The kinds addressable by `infra_status_events.kind`. */
export const INFRA_KINDS = ["profile", "bm", "ad_account", "pixel", "page"] as const;
export type InfraKind = (typeof INFRA_KINDS)[number];

function member<T extends readonly string[]>(
  vocab: T,
  value: string | null | undefined,
): value is T[number] {
  return value != null && (vocab as readonly string[]).includes(value);
}

export const isProfileStatus = (v: string | null | undefined): v is ProfileStatus =>
  member(PROFILE_STATUSES, v);
export const isBmStatus = (v: string | null | undefined): v is BmStatus => member(BM_STATUSES, v);
export const isPixelStatus = (v: string | null | undefined): v is PixelStatus =>
  member(PIXEL_STATUSES, v);
export const isPageStatus = (v: string | null | undefined): v is PageStatus =>
  member(PAGE_STATUSES, v);
export const isAdAccountUsage = (v: string | null | undefined): v is AdAccountUsage =>
  member(AD_ACCOUNT_USAGE, v);
export const isInfraKind = (v: string | null | undefined): v is InfraKind => member(INFRA_KINDS, v);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/infra-status.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/infra-status.ts src/lib/infra-status.test.ts
git commit -m "feat(infra): status vocabularies and guards"
```

---

## Task 2: Risk model

The redundancy rule is the product thesis: an asset with fewer than two independent access paths is one
ban away from unreachable.

**Files:**
- Create: `src/lib/infra-risk.ts`
- Test: `src/lib/infra-risk.test.ts`

- [ ] **Step 1: Write the failing test**

Note the two exhaustiveness tables. They are typed `Record<PixelStatus, ...>` / `Record<PageStatus, ...>`
so that adding a status without classifying it is a **compile error**, not a silent dead value. That is
the mechanism the spec promises; do not loosen those types to `Record<string, ...>`.

```ts
// src/lib/infra-risk.test.ts
import { describe, expect, test } from "bun:test";
import {
  BM_STATUSES,
  PROFILE_STATUSES,
  type PageStatus,
  type PixelStatus,
} from "./infra-status";
import {
  VERIFICATION_OVERDUE_DAYS,
  adAccountRisk,
  bmRisk,
  isVerificationOverdue,
  pageRisk,
  pixelRisk,
  redundancy,
  usableBm,
  usableProfile,
} from "./infra-risk";

describe("redundancy", () => {
  test("zero access paths is critical", () => {
    expect(redundancy(0)).toEqual({ level: "critical", label: "No backup" });
  });

  test("exactly one access path is a warning", () => {
    expect(redundancy(1)).toEqual({ level: "warning", label: "Single access" });
  });

  test("two access paths is safe — this is the threshold the whole feature exists for", () => {
    expect(redundancy(2)).toEqual({ level: "safe", label: "Redundant" });
  });

  test("more than two stays safe", () => {
    expect(redundancy(7)).toEqual({ level: "safe", label: "Redundant" });
  });
});

describe("usableProfile", () => {
  test("only active and new profiles provide access", () => {
    const expected: Record<(typeof PROFILE_STATUSES)[number], boolean> = {
      new: true,
      active: true,
      in_review: false,
      suspended: false,
      banned: false,
      retired: false,
    };
    for (const s of PROFILE_STATUSES) expect(usableProfile(s)).toBe(expected[s]);
  });
});

describe("usableBm", () => {
  test("only active and pending_verification BMs are access paths", () => {
    const expected: Record<(typeof BM_STATUSES)[number], boolean> = {
      pending_verification: true,
      active: true,
      in_review: false,
      restricted: false,
      banned: false,
    };
    for (const s of BM_STATUSES) expect(usableBm(s)).toBe(expected[s]);
  });
});

describe("bmRisk", () => {
  test("a BM whose only three profiles are unusable reads critical", () => {
    const profiles = ["suspended", "banned", "in_review"] as const;
    expect(bmRisk(profiles.filter(usableProfile).length)).toEqual({
      level: "critical",
      label: "No backup",
    });
  });
});

describe("adAccountRisk", () => {
  test("an account reachable only through a banned BM is critical, not safe", () => {
    // The bug this rule fixes: counting raw links scores this account safe.
    const linked = ["banned"] as const;
    expect(adAccountRisk(linked.filter(usableBm).length)).toEqual({
      level: "critical",
      label: "No backup",
    });
  });

  test("two live BMs is safe", () => {
    const linked = ["active", "pending_verification"] as const;
    expect(adAccountRisk(linked.filter(usableBm).length)).toEqual({
      level: "safe",
      label: "Redundant",
    });
  });
});

describe("pixelRisk precedence", () => {
  test("an unusable root BM beats every other signal", () => {
    expect(pixelRisk({ status: "active", rootBmStatus: "banned", shareCount: 5 })).toEqual({
      level: "critical",
      label: "Root BM unusable",
    });
  });

  test("restricted beats not-shared", () => {
    expect(pixelRisk({ status: "restricted", rootBmStatus: "active", shareCount: 0 })).toEqual({
      level: "warning",
      label: "Restricted",
    });
  });

  test("zero shares is a warning even when everything else is healthy", () => {
    expect(pixelRisk({ status: "active", rootBmStatus: "active", shareCount: 0 })).toEqual({
      level: "warning",
      label: "Not shared",
    });
  });

  test("every pixel status is classified — a new status cannot become dead", () => {
    const expected: Record<PixelStatus, { level: string; label: string }> = {
      active: { level: "safe", label: "Shared" },
      inactive: { level: "warning", label: "Inactive" },
      restricted: { level: "warning", label: "Restricted" },
    };
    for (const status of Object.keys(expected) as PixelStatus[]) {
      expect(pixelRisk({ status, rootBmStatus: "active", shareCount: 1 })).toEqual(expected[status]);
    }
  });
});

describe("pageRisk precedence", () => {
  test("an unusable owner beats a banned page", () => {
    expect(
      pageRisk({ status: "banned", ownerStatus: "suspended", bmCount: 3, profileCount: 3 }),
    ).toEqual({ level: "critical", label: "No active owner" });
  });

  test("no added access is a warning when the page itself is healthy", () => {
    expect(
      pageRisk({ status: "active", ownerStatus: "active", bmCount: 0, profileCount: 0 }),
    ).toEqual({ level: "warning", label: "No added access" });
  });

  test("one additional profile and no BM still counts as added access", () => {
    expect(
      pageRisk({ status: "active", ownerStatus: "active", bmCount: 0, profileCount: 1 }),
    ).toEqual({ level: "safe", label: "Added" });
  });

  test("every page status is classified — a new status cannot become dead", () => {
    const expected: Record<PageStatus, { level: string; label: string }> = {
      active: { level: "safe", label: "Added" },
      in_review: { level: "warning", label: "In review" },
      restricted: { level: "warning", label: "Restricted" },
      banned: { level: "critical", label: "Banned" },
      unpublished: { level: "warning", label: "Unpublished" },
    };
    for (const status of Object.keys(expected) as PageStatus[]) {
      expect(pageRisk({ status, ownerStatus: "active", bmCount: 1, profileCount: 0 })).toEqual(
        expected[status],
      );
    }
  });
});

describe("isVerificationOverdue", () => {
  const now = new Date("2026-08-13T12:00:00Z");

  test("never verified is overdue", () => {
    expect(isVerificationOverdue(null, now)).toBe(true);
  });

  test("verified exactly at the threshold is not yet overdue", () => {
    const at = new Date(now.getTime() - VERIFICATION_OVERDUE_DAYS * 86_400_000);
    expect(isVerificationOverdue(at, now)).toBe(false);
  });

  test("a day past the threshold is overdue", () => {
    const at = new Date(now.getTime() - (VERIFICATION_OVERDUE_DAYS + 1) * 86_400_000);
    expect(isVerificationOverdue(at, now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/infra-risk.test.ts`
Expected: FAIL — `Cannot find module './infra-risk'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/infra-risk.ts
/**
 * Risk classification for the infrastructure registry.
 *
 * Pure: takes already-fetched shapes, imports only the vocabularies. The read model in
 * `server/fns/infra/risk.ts` is the ONLY caller, so the dashboard counts and the risk map cannot
 * disagree — they are the same computation. Never re-derive risk in a component.
 *
 * Note what the foreign keys removed from this module: `rootBmStatus` and `ownerStatus` are not
 * nullable, because `infra_pixels.root_bm_id` and `infra_pages.owner_profile_id` are NOT NULL with
 * RESTRICT. There is no "missing root BM" case to classify.
 */
import { type BmStatus, type PageStatus, type PixelStatus, type ProfileStatus } from "./infra-status";

export type RiskLevel = "critical" | "warning" | "safe";
export interface Risk {
  level: RiskLevel;
  label: string;
}

/** A BM unverified for longer than this shows an overdue marker. Not configurable by design. */
export const VERIFICATION_OVERDUE_DAYS = 30;

/** Sort order for risk-first lists. */
export const RISK_ORDER: Record<RiskLevel, number> = { critical: 0, warning: 1, safe: 2 };

/**
 * The product thesis, in three lines. Two independent paths means one ban cannot lock you out.
 */
export function redundancy(paths: number): Risk {
  if (paths === 0) return { level: "critical", label: "No backup" };
  if (paths === 1) return { level: "warning", label: "Single access" };
  return { level: "safe", label: "Redundant" };
}

/** A profile provides access only while it can actually log in. */
export function usableProfile(status: ProfileStatus): boolean {
  return status === "active" || status === "new";
}

/**
 * A BM counts as an access path only while it is usable. `pending_verification` still works;
 * `in_review`, `restricted` and `banned` are not paths you can rely on as a backup.
 */
export function usableBm(status: BmStatus): boolean {
  return status === "active" || status === "pending_verification";
}

export const bmRisk = (usableProfileCount: number): Risk => redundancy(usableProfileCount);

export const adAccountRisk = (usableBmCount: number): Risk => redundancy(usableBmCount);

/** Ordered; first match wins. */
export function pixelRisk(input: {
  status: PixelStatus;
  rootBmStatus: BmStatus;
  shareCount: number;
}): Risk {
  if (!usableBm(input.rootBmStatus)) return { level: "critical", label: "Root BM unusable" };
  if (input.status === "restricted") return { level: "warning", label: "Restricted" };
  if (input.status === "inactive") return { level: "warning", label: "Inactive" };
  if (input.shareCount === 0) return { level: "warning", label: "Not shared" };
  return { level: "safe", label: "Shared" };
}

/** Ordered; first match wins. */
export function pageRisk(input: {
  status: PageStatus;
  ownerStatus: ProfileStatus;
  bmCount: number;
  profileCount: number;
}): Risk {
  if (!usableProfile(input.ownerStatus)) return { level: "critical", label: "No active owner" };
  if (input.status === "banned") return { level: "critical", label: "Banned" };
  if (input.status === "restricted") return { level: "warning", label: "Restricted" };
  if (input.status === "in_review") return { level: "warning", label: "In review" };
  if (input.status === "unpublished") return { level: "warning", label: "Unpublished" };
  if (input.bmCount === 0 && input.profileCount === 0) {
    return { level: "warning", label: "No added access" };
  }
  return { level: "safe", label: "Added" };
}

export function isVerificationOverdue(verifiedAt: Date | null, now: Date): boolean {
  if (!verifiedAt) return true;
  const days = (now.getTime() - verifiedAt.getTime()) / 86_400_000;
  return days > VERIFICATION_OVERDUE_DAYS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/infra-risk.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/infra-risk.ts src/lib/infra-risk.test.ts
git commit -m "feat(infra): redundancy risk model

Counts only live BMs as ad-account access paths. Counting raw links scores an
account reachable solely through a banned BM as safe, which is the defect in the
reference implementation."
```

---

## Task 3: Schema

**Files:**
- Modify: `src/db/schema.ts` (append at end of file)

- [ ] **Step 1: Append the eleven tables**

`boolean` is already imported at `src/db/schema.ts:10` but is not needed here; do not add imports —
`pgTable`, `text`, `timestamp`, `primaryKey`, `index` are all already imported at lines 1–13.

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure registry (Track N).
//
// OPERATOR-OWNED: no sync job writes any `infra_` table. That is the invariant the whole feature
// rests on — it is why an operator's entry can never be silently overwritten, and it is forced by
// the permission ceiling (the system-user token lacks `business_management`, so every BM-level Graph
// edge 403s; see the design spec).
//
// These are the only tables in this schema with real foreign keys besides the chat pair. The reason
// the rest avoid them — external syncs re-key ids and a cascade would erase operator corrections —
// does not apply: we own these row lifetimes end to end and nothing external touches them.
// ─────────────────────────────────────────────────────────────────────────────

export const infraProfiles = pgTable("infra_profiles", {
  id: text("id").primaryKey(), // crypto.randomUUID() at the insert site
  name: text("name").notNull(),
  status: text("status").notNull().default("new"), // ProfileStatus; guarded in the server fn
  geo: text("geo"),
  browser: text("browser"), // antidetect tool in use. Non-secret.
  proxyProvider: text("proxy_provider"), // provider NAME only — never an address or credential
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraBusinessManagers = pgTable("infra_business_managers", {
  id: text("id").primaryKey(),
  // Unique: two rows for one Meta BM would silently split its access graph in half.
  bmId: text("bm_id").notNull().unique(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"), // BmStatus
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Operator-owned facts about a registered ad account. Deliberately has NO status column: live status,
 * disable_reason, spend cap and balance are LEFT JOINed from `accounts`, which syncs them hourly.
 *
 * No foreign key to `accounts.id` on purpose — a registry row may exist before the account appears in
 * sync, or outlive its departure from the book. An unmatched row renders a "not in sync" badge.
 */
export const infraAdAccounts = pgTable("infra_ad_accounts", {
  id: text("id").primaryKey(), // act_<digits>, format-checked in the server fn
  label: text("label"), // optional operator alias; the real name comes from `accounts`
  usageState: text("usage_state").notNull().default("in_use"), // AdAccountUsage
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraPixels = pgTable("infra_pixels", {
  id: text("id").primaryKey(), // the Meta pixel id
  name: text("name").notNull(),
  // RESTRICT, not CASCADE: a pixel without a root BM is meaningless, so the delete is refused rather
  // than the pixel silently vanishing. This is also what removes the "missing root BM" case entirely.
  rootBmId: text("root_bm_id")
    .notNull()
    .references(() => infraBusinessManagers.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("active"), // PixelStatus
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraPages = pgTable("infra_pages", {
  id: text("id").primaryKey(), // randomUUID — the Meta page id is optional so it cannot be the key
  pageId: text("page_id"),
  pageUrl: text("page_url").notNull(),
  name: text("name").notNull(),
  ownerProfileId: text("owner_profile_id")
    .notNull()
    .references(() => infraProfiles.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("active"), // PageStatus
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Link tables. Membership cascades: removing a profile removes its BM memberships, never the BM.

export const infraProfileBm = pgTable(
  "infra_profile_bm",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => infraProfiles.id, { onDelete: "cascade" }),
    bmId: text("bm_id")
      .notNull()
      .references(() => infraBusinessManagers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.bmId] })],
);

export const infraBmAdAccount = pgTable(
  "infra_bm_ad_account",
  {
    bmId: text("bm_id")
      .notNull()
      .references(() => infraBusinessManagers.id, { onDelete: "cascade" }),
    adAccountId: text("ad_account_id")
      .notNull()
      .references(() => infraAdAccounts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bmId, t.adAccountId] })],
);

/** Pixel shares only. The root BM lives on `infra_pixels.root_bm_id` and is never also a share. */
export const infraPixelBm = pgTable(
  "infra_pixel_bm",
  {
    pixelId: text("pixel_id")
      .notNull()
      .references(() => infraPixels.id, { onDelete: "cascade" }),
    bmId: text("bm_id")
      .notNull()
      .references(() => infraBusinessManagers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pixelId, t.bmId] })],
);

export const infraPageBm = pgTable(
  "infra_page_bm",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => infraPages.id, { onDelete: "cascade" }),
    bmId: text("bm_id")
      .notNull()
      .references(() => infraBusinessManagers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.bmId] })],
);

/** Additional page access. The owner lives on `infra_pages.owner_profile_id`, never also here. */
export const infraPageProfile = pgTable(
  "infra_page_profile",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => infraPages.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => infraProfiles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.profileId] })],
);

/**
 * Status and verification history. Records old → new AND the acting user, which is what makes
 * "how long has this been banned" and "how many suspensions this quarter" answerable.
 *
 * `entity_id` is plain text with NO foreign key, deliberately: the history of a deleted asset is
 * exactly when you most want to read it.
 */
export const infraStatusEvents = pgTable(
  "infra_status_events",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // InfraKind
    entityId: text("entity_id").notNull(),
    event: text("event").notNull(), // "status_change" | "verify"
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    reason: text("reason"),
    actorEmail: text("actor_email").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("infra_status_events_entity_idx").on(t.kind, t.entityId, t.at)],
);
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(infra): eleven registry tables with real foreign keys"
```

---

## Task 4: Push the schema, test database first

**Files:** none — this is a database operation.

- [ ] **Step 1: Confirm the tunnel is up**

Run: `node -e "const s=require('net').connect(5432,'127.0.0.1');s.on('connect',()=>{console.log('up');s.destroy()});s.on('error',e=>console.log('down',e.code))"`
Expected: `up`. If `down`, open the tunnel: `ssh -N -L 127.0.0.1:5432:127.0.0.1:5432 <droplet>`.

- [ ] **Step 2: Push to the test database and verify**

Read `TEST_DATABASE_URL` from `.env`, then:

```bash
DATABASE_URL="$TEST_DATABASE_URL" bunx drizzle-kit push
```

Expected: eleven `CREATE TABLE` statements applied, no destructive prompts. If drizzle-kit offers to
**drop or rename** anything, abort — that means an unrelated schema drift, not this change.

Verify the constraints actually landed (this is the point of pushing to test first):

```bash
psql "$TEST_DATABASE_URL" -c "\d infra_pixels" -c "\d infra_profile_bm"
```

Expected: `infra_pixels_root_bm_id_fkey` with `ON DELETE RESTRICT`; `infra_profile_bm` with a composite
primary key and two `ON DELETE CASCADE` foreign keys.

- [ ] **Step 3: Push to production**

The change is purely additive — new tables only, no column drops, no renames — so this is safe.

```bash
bunx drizzle-kit push
```

Expected: the same eleven tables created. No task after this one touches production schema.

---

## Task 5: Event writer + risk read model, with DB-backed tests

**Files:**
- Create: `src/server/fns/infra/events.ts`
- Create: `src/server/fns/infra/risk.ts`
- Test: `src/server/fns/infra/infra.db.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/server/fns/infra/infra.db.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { logInfraEvent } from "./events";
import { fetchRiskMap } from "./risk";

// Destructive: truncate in dependency order. `bun test` redirects DATABASE_URL to TEST_DATABASE_URL
// via test-setup.ts, so this can never reach real synced data.
async function reset() {
  await db.execute(sql`truncate table
    infra_page_profile, infra_page_bm, infra_pixel_bm, infra_bm_ad_account, infra_profile_bm,
    infra_pages, infra_pixels, infra_ad_accounts, infra_business_managers, infra_profiles,
    infra_status_events cascade`);
}

const bm = async (name: string, status = "active") => {
  const id = randomUUID();
  await db
    .insert(schema.infraBusinessManagers)
    .values({ id, bmId: `bm-${id.slice(0, 8)}`, name, status });
  return id;
};

const profile = async (name: string, status = "active") => {
  const id = randomUUID();
  await db.insert(schema.infraProfiles).values({ id, name, status });
  return id;
};

beforeEach(reset);
afterAll(reset);

describe("referential integrity", () => {
  test("deleting a profile cascades its BM memberships away", async () => {
    const p = await profile("p1");
    const b = await bm("bm1");
    await db.insert(schema.infraProfileBm).values({ profileId: p, bmId: b });

    await db.delete(schema.infraProfiles).where(eq(schema.infraProfiles.id, p));

    const links = await db.select().from(schema.infraProfileBm);
    expect(links).toHaveLength(0);
    // The BM itself survives — membership cascades, the asset does not.
    expect(await db.select().from(schema.infraBusinessManagers)).toHaveLength(1);
  });

  test("deleting a BM that roots a pixel is refused", async () => {
    const b = await bm("root-bm");
    await db
      .insert(schema.infraPixels)
      .values({ id: "px-1", name: "Main pixel", rootBmId: b });

    let threw = false;
    try {
      await db.delete(schema.infraBusinessManagers).where(eq(schema.infraBusinessManagers.id, b));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await db.select().from(schema.infraPixels)).toHaveLength(1);
  });

  test("deleting a profile that owns a page is refused", async () => {
    const p = await profile("owner");
    await db.insert(schema.infraPages).values({
      id: randomUUID(),
      name: "Brand page",
      pageUrl: "https://facebook.com/brand",
      ownerProfileId: p,
    });

    let threw = false;
    try {
      await db.delete(schema.infraProfiles).where(eq(schema.infraProfiles.id, p));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("two BM rows cannot share one Meta bm_id", async () => {
    await db
      .insert(schema.infraBusinessManagers)
      .values({ id: randomUUID(), bmId: "999", name: "First" });

    let threw = false;
    try {
      await db
        .insert(schema.infraBusinessManagers)
        .values({ id: randomUUID(), bmId: "999", name: "Duplicate" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("logInfraEvent", () => {
  test("a status change records both values and the actor", async () => {
    const b = await bm("bm-x");
    await logInfraEvent({
      kind: "bm",
      entityId: b,
      event: "status_change",
      fromStatus: "active",
      toStatus: "banned",
      reason: "policy violation",
      actorEmail: "op@dot.test",
    });

    const rows = await db
      .select()
      .from(schema.infraStatusEvents)
      .where(
        and(eq(schema.infraStatusEvents.kind, "bm"), eq(schema.infraStatusEvents.entityId, b)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].fromStatus).toBe("active");
    expect(rows[0].toStatus).toBe("banned");
    expect(rows[0].reason).toBe("policy violation");
    expect(rows[0].actorEmail).toBe("op@dot.test");
  });

  test("history survives the deletion of its entity", async () => {
    const p = await profile("doomed");
    await logInfraEvent({
      kind: "profile",
      entityId: p,
      event: "status_change",
      fromStatus: "active",
      toStatus: "banned",
      actorEmail: "op@dot.test",
    });

    await db.delete(schema.infraProfiles).where(eq(schema.infraProfiles.id, p));

    const rows = await db
      .select()
      .from(schema.infraStatusEvents)
      .where(eq(schema.infraStatusEvents.entityId, p));
    expect(rows).toHaveLength(1);
  });
});

describe("fetchRiskMap", () => {
  test("a BM with two usable profiles is redundant; one is a warning; zero is critical", async () => {
    const redundantBm = await bm("redundant");
    const singleBm = await bm("single");
    const orphanBm = await bm("orphan");
    const p1 = await profile("p1");
    const p2 = await profile("p2");
    const banned = await profile("gone", "banned");

    await db.insert(schema.infraProfileBm).values([
      { profileId: p1, bmId: redundantBm },
      { profileId: p2, bmId: redundantBm },
      { profileId: p1, bmId: singleBm },
      { profileId: banned, bmId: orphanBm },
    ]);

    const map = await fetchRiskMap();
    const byName = new Map(map.bms.map((r) => [r.name, r.risk.level]));
    expect(byName.get("redundant")).toBe("safe");
    expect(byName.get("single")).toBe("warning");
    // A banned profile is not an access path, so this BM has none.
    expect(byName.get("orphan")).toBe("critical");
  });

  test("an ad account reachable only through a banned BM is critical", async () => {
    const deadBm = await bm("dead", "banned");
    await db.insert(schema.infraAdAccounts).values({ id: "act_1", label: "Acct one" });
    await db.insert(schema.infraBmAdAccount).values({ bmId: deadBm, adAccountId: "act_1" });

    const map = await fetchRiskMap();
    expect(map.adAccounts).toHaveLength(1);
    expect(map.adAccounts[0].risk.level).toBe("critical");
  });

  test("retired ad accounts are excluded from the risk map", async () => {
    await db
      .insert(schema.infraAdAccounts)
      .values({ id: "act_retired", label: "Old", usageState: "retired" });

    const map = await fetchRiskMap();
    expect(map.adAccounts).toHaveLength(0);
    // Still counted as registered — excluded from risk, not from existence.
    expect(map.counts.adAccounts).toBe(1);
  });

  test("counts and atRisk reflect the whole registry", async () => {
    const b = await bm("only");
    await profile("lonely");
    await db.insert(schema.infraPixels).values({ id: "px", name: "Px", rootBmId: b });

    const map = await fetchRiskMap();
    expect(map.counts).toEqual({ profiles: 1, bms: 1, adAccounts: 0, pixels: 1, pages: 0 });
    // BM has no usable profile (critical) and the pixel has no shares (warning).
    expect(map.atRisk).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/fns/infra/infra.db.test.ts --timeout 60000`
Expected: FAIL — `Cannot find module './events'`. The `--timeout 60000` is required: DB tests run over
the SSH tunnel and latency alone fails the default timeout, which looks exactly like a real failure.

- [ ] **Step 3: Write the event writer**

```ts
// src/server/fns/infra/events.ts
import { randomUUID } from "node:crypto";
import { db, schema } from "@/db/client";
import { type InfraKind } from "@/lib/infra-status";

export interface InfraEventInput {
  kind: InfraKind;
  entityId: string;
  event: "status_change" | "verify";
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  actorEmail: string;
}

/**
 * Append one history row.
 *
 * Records old → new and the real acting user. The reference implementation logs changed field NAMES
 * with no values and hardcodes every actor as "Admin", which is the exact spreadsheet failure it was
 * built to replace — so this is the one piece of bookkeeping worth being strict about.
 */
export async function logInfraEvent(input: InfraEventInput): Promise<void> {
  await db.insert(schema.infraStatusEvents).values({
    id: randomUUID(),
    kind: input.kind,
    entityId: input.entityId,
    event: input.event,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    reason: input.reason ?? null,
    actorEmail: input.actorEmail,
  });
}
```

- [ ] **Step 4: Write the risk read model**

```ts
// src/server/fns/infra/risk.ts
import { db, schema } from "@/db/client";
import {
  RISK_ORDER,
  adAccountRisk,
  bmRisk,
  isVerificationOverdue,
  pageRisk,
  pixelRisk,
  usableBm,
  usableProfile,
  type Risk,
} from "@/lib/infra-risk";
import {
  isBmStatus,
  isPageStatus,
  isPixelStatus,
  isProfileStatus,
  type BmStatus,
  type ProfileStatus,
} from "@/lib/infra-status";
import { requireAdmin } from "../auth";

export interface InfraRiskRow {
  id: string;
  name: string;
  /** The entity's own status, shown alongside its risk. */
  status: string;
  risk: Risk;
  /** Human summary of the access paths behind the verdict. */
  detail: string;
  /** BMs only: verification is overdue. */
  overdue?: boolean;
}

export interface InfraRiskMap {
  counts: { profiles: number; bms: number; adAccounts: number; pixels: number; pages: number };
  atRisk: number;
  bms: InfraRiskRow[];
  adAccounts: InfraRiskRow[];
  pixels: InfraRiskRow[];
  pages: InfraRiskRow[];
}

const byRisk = (a: InfraRiskRow, b: InfraRiskRow) =>
  RISK_ORDER[a.risk.level] - RISK_ORDER[b.risk.level] || a.name.localeCompare(b.name);

/**
 * The whole registry, classified. Ten selects joined in memory — the registry is a few hundred rows,
 * so this is simpler and easier to test than clever SQL, and it keeps the risk rules in one pure
 * module. If this ever exceeds a few thousand rows, push the counting into SQL before paginating.
 *
 * A status that fails its guard falls back to the most alarming interpretation rather than being
 * dropped: a row with a corrupt status is exactly what an operator needs to see.
 */
export async function fetchRiskMap(): Promise<InfraRiskMap> {
  await requireAdmin();

  const [profiles, bms, adAccounts, pixels, pages] = await Promise.all([
    db.select().from(schema.infraProfiles),
    db.select().from(schema.infraBusinessManagers),
    db.select().from(schema.infraAdAccounts),
    db.select().from(schema.infraPixels),
    db.select().from(schema.infraPages),
  ]);
  const [profileBm, bmAccount, pixelBm, pageBm, pageProfile] = await Promise.all([
    db.select().from(schema.infraProfileBm),
    db.select().from(schema.infraBmAdAccount),
    db.select().from(schema.infraPixelBm),
    db.select().from(schema.infraPageBm),
    db.select().from(schema.infraPageProfile),
  ]);

  const profileStatus = new Map<string, ProfileStatus>(
    profiles.map((p) => [p.id, isProfileStatus(p.status) ? p.status : "banned"]),
  );
  const bmStatus = new Map<string, BmStatus>(
    bms.map((b) => [b.id, isBmStatus(b.status) ? b.status : "banned"]),
  );
  const bmName = new Map(bms.map((b) => [b.id, b.name]));

  const usableProfilesPerBm = new Map<string, number>();
  for (const link of profileBm) {
    const s = profileStatus.get(link.profileId);
    if (s && usableProfile(s)) {
      usableProfilesPerBm.set(link.bmId, (usableProfilesPerBm.get(link.bmId) ?? 0) + 1);
    }
  }

  const usableBmsPerAccount = new Map<string, number>();
  const bmNamesPerAccount = new Map<string, string[]>();
  for (const link of bmAccount) {
    const s = bmStatus.get(link.bmId);
    const names = bmNamesPerAccount.get(link.adAccountId) ?? [];
    names.push(bmName.get(link.bmId) ?? link.bmId);
    bmNamesPerAccount.set(link.adAccountId, names);
    if (s && usableBm(s)) {
      usableBmsPerAccount.set(
        link.adAccountId,
        (usableBmsPerAccount.get(link.adAccountId) ?? 0) + 1,
      );
    }
  }

  const sharesPerPixel = new Map<string, number>();
  for (const link of pixelBm) {
    sharesPerPixel.set(link.pixelId, (sharesPerPixel.get(link.pixelId) ?? 0) + 1);
  }
  const bmsPerPage = new Map<string, number>();
  for (const link of pageBm) bmsPerPage.set(link.pageId, (bmsPerPage.get(link.pageId) ?? 0) + 1);
  const profilesPerPage = new Map<string, number>();
  for (const link of pageProfile) {
    profilesPerPage.set(link.pageId, (profilesPerPage.get(link.pageId) ?? 0) + 1);
  }

  const now = new Date();

  const bmRows: InfraRiskRow[] = bms
    .map((b) => {
      const usable = usableProfilesPerBm.get(b.id) ?? 0;
      return {
        id: b.id,
        name: b.name,
        status: b.status,
        risk: bmRisk(usable),
        detail: `${usable} usable profile${usable === 1 ? "" : "s"}`,
        overdue: isVerificationOverdue(b.verifiedAt, now),
      };
    })
    .sort(byRisk);

  // `retired` accounts are excluded: a retired account with no access path is not a problem to solve.
  const accountRows: InfraRiskRow[] = adAccounts
    .filter((a) => a.usageState !== "retired")
    .map((a) => {
      const usable = usableBmsPerAccount.get(a.id) ?? 0;
      const names = bmNamesPerAccount.get(a.id) ?? [];
      return {
        id: a.id,
        name: a.label?.trim() || a.id,
        status: a.usageState,
        risk: adAccountRisk(usable),
        detail: names.length ? `via ${names.join(", ")}` : "no BM linked",
      };
    })
    .sort(byRisk);

  const pixelRows: InfraRiskRow[] = pixels
    .map((p) => {
      const shares = sharesPerPixel.get(p.id) ?? 0;
      const root = bmStatus.get(p.rootBmId) ?? "banned";
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        risk: pixelRisk({
          status: isPixelStatus(p.status) ? p.status : "restricted",
          rootBmStatus: root,
          shareCount: shares,
        }),
        detail: `root ${bmName.get(p.rootBmId) ?? p.rootBmId} · ${shares} share${shares === 1 ? "" : "s"}`,
      };
    })
    .sort(byRisk);

  const pageRows: InfraRiskRow[] = pages
    .map((p) => {
      const owner = profileStatus.get(p.ownerProfileId) ?? "banned";
      const bmCount = bmsPerPage.get(p.id) ?? 0;
      const profileCount = profilesPerPage.get(p.id) ?? 0;
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        risk: pageRisk({
          status: isPageStatus(p.status) ? p.status : "restricted",
          ownerStatus: owner,
          bmCount,
          profileCount,
        }),
        detail: `${bmCount} BM${bmCount === 1 ? "" : "s"} · ${profileCount} extra profile${profileCount === 1 ? "" : "s"}`,
      };
    })
    .sort(byRisk);

  const all = [...bmRows, ...accountRows, ...pixelRows, ...pageRows];
  return {
    counts: {
      profiles: profiles.length,
      bms: bms.length,
      adAccounts: adAccounts.length,
      pixels: pixels.length,
      pages: pages.length,
    },
    atRisk: all.filter((r) => r.risk.level !== "safe").length,
    bms: bmRows,
    adAccounts: accountRows,
    pixels: pixelRows,
    pages: pageRows,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

`fetchRiskMap` calls `requireAdmin()`, which reads a session cookie that does not exist in a test
process. Before running, confirm how `src/server/fns/auth.ts` behaves without a request context: if
`requireAdmin()` throws outside a request, split the function so the test can call the unguarded
inner read — export `fetchRiskMap` as the guarded wrapper and `buildRiskMap()` as the pure-DB inner
function, and point the test at `buildRiskMap`. Do not weaken the guard to make a test pass.

Run: `bun test src/server/fns/infra/infra.db.test.ts --timeout 60000`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/fns/infra/events.ts src/server/fns/infra/risk.ts src/server/fns/infra/infra.db.test.ts
git commit -m "feat(infra): status-event writer and risk read model"
```

---

## Task 6: Profile server fns

**Files:**
- Create: `src/server/fns/infra/profiles.ts`

Every mutation follows the canonical shape from `src/server/fns/account-status.ts:46-68`: gate with
`requireAdmin()`, validate, mutate, `audit()`. Status changes additionally call `logInfraEvent`.

- [ ] **Step 1: Write the implementation**

```ts
// src/server/fns/infra/profiles.ts
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { PROFILE_STATUSES, isProfileStatus } from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";
import { logInfraEvent } from "./events";

export interface ProfileView {
  id: string;
  name: string;
  status: string;
  geo: string | null;
  browser: string | null;
  proxyProvider: string | null;
  notes: string | null;
  bmIds: string[];
  statusChangedAt: string;
}

export async function fetchProfiles(): Promise<ProfileView[]> {
  await requireAdmin();
  const [rows, links] = await Promise.all([
    db.select().from(schema.infraProfiles),
    db.select().from(schema.infraProfileBm),
  ]);
  const bmsByProfile = new Map<string, string[]>();
  for (const l of links) {
    const list = bmsByProfile.get(l.profileId) ?? [];
    list.push(l.bmId);
    bmsByProfile.set(l.profileId, list);
  }
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      geo: r.geo,
      browser: r.browser,
      proxyProvider: r.proxyProvider,
      notes: r.notes,
      bmIds: bmsByProfile.get(r.id) ?? [],
      statusChangedAt: r.statusChangedAt.toISOString(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SaveProfileInput {
  id?: string | null;
  name: string;
  status: string;
  geo?: string | null;
  browser?: string | null;
  proxyProvider?: string | null;
  notes?: string | null;
}

export async function saveProfile(
  input: SaveProfileInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const user = await requireAdmin();
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required" };
  if (!isProfileStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PROFILE_STATUSES.join(", ")}` };
  }

  const fields = {
    name,
    geo: input.geo?.trim() || null,
    browser: input.browser?.trim() || null,
    proxyProvider: input.proxyProvider?.trim() || null,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  };

  if (input.id) {
    const [existing] = await db
      .select()
      .from(schema.infraProfiles)
      .where(eq(schema.infraProfiles.id, input.id));
    if (!existing) return { ok: false, error: "Profile not found" };

    const statusChanged = existing.status !== input.status;
    await db
      .update(schema.infraProfiles)
      .set({
        ...fields,
        status: input.status,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
      })
      .where(eq(schema.infraProfiles.id, input.id));

    if (statusChanged) {
      await logInfraEvent({
        kind: "profile",
        entityId: input.id,
        event: "status_change",
        fromStatus: existing.status,
        toStatus: input.status,
        actorEmail: user.email,
      });
    }
    await audit("infra.profile.update", `${name} (${input.id})`);
    return { ok: true, id: input.id };
  }

  const id = randomUUID();
  await db.insert(schema.infraProfiles).values({ ...fields, id, status: input.status });
  await audit("infra.profile.create", `${name} (${id})`);
  return { ok: true, id };
}

/**
 * Change status on its own, with a reason. Separate from `saveProfile` because a status change is the
 * event worth recording precisely, and the list screen changes it without opening the form.
 */
export async function setProfileStatus(input: {
  id: string;
  status: string;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  if (!isProfileStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PROFILE_STATUSES.join(", ")}` };
  }
  const [existing] = await db
    .select()
    .from(schema.infraProfiles)
    .where(eq(schema.infraProfiles.id, input.id));
  if (!existing) return { ok: false, error: "Profile not found" };
  if (existing.status === input.status) return { ok: true };

  await db
    .update(schema.infraProfiles)
    .set({ status: input.status, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraProfiles.id, input.id));
  await logInfraEvent({
    kind: "profile",
    entityId: input.id,
    event: "status_change",
    fromStatus: existing.status,
    toStatus: input.status,
    reason: input.reason?.trim() || null,
    actorEmail: user.email,
  });
  await audit("infra.profile.status", `${existing.name}: ${existing.status} → ${input.status}`);
  return { ok: true };
}

/**
 * Delete a profile. Refused by the database when the profile owns a page, so the Postgres error is
 * translated into a message naming the blocker rather than surfacing a constraint name.
 */
export async function deleteProfile(input: {
  id: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const owned = await db
    .select({ id: schema.infraPages.id, name: schema.infraPages.name })
    .from(schema.infraPages)
    .where(eq(schema.infraPages.ownerProfileId, input.id));
  if (owned.length > 0) {
    return {
      ok: false,
      error: `Owns ${owned.length} page(s): ${owned.map((p) => p.name).join(", ")}. Reassign them first.`,
    };
  }
  await db.delete(schema.infraProfiles).where(eq(schema.infraProfiles.id, input.id));
  await audit("infra.profile.delete", input.id);
  return { ok: true };
}

export async function linkProfileBm(input: {
  profileId: string;
  bmId: string;
  action: "add" | "remove";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  if (input.action === "add") {
    await db
      .insert(schema.infraProfileBm)
      .values({ profileId: input.profileId, bmId: input.bmId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.infraProfileBm)
      .where(
        and(
          eq(schema.infraProfileBm.profileId, input.profileId),
          eq(schema.infraProfileBm.bmId, input.bmId),
        ),
      );
  }
  await audit("infra.profile.link", `${input.action} ${input.profileId} ↔ ${input.bmId}`);
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/fns/infra/profiles.ts
git commit -m "feat(infra): profile server fns"
```

---

## Task 7: Business Manager server fns

**Files:**
- Create: `src/server/fns/infra/bms.ts`

- [ ] **Step 1: Write the implementation**

```ts
// src/server/fns/infra/bms.ts
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { BM_STATUSES, isBmStatus } from "@/lib/infra-status";
import { usableProfile } from "@/lib/infra-risk";
import { isProfileStatus } from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";
import { logInfraEvent } from "./events";

export interface BmView {
  id: string;
  bmId: string;
  name: string;
  status: string;
  verifiedAt: string | null;
  notes: string | null;
  profileIds: string[];
  adAccountIds: string[];
}

export async function fetchBms(): Promise<BmView[]> {
  await requireAdmin();
  const [rows, profileLinks, accountLinks] = await Promise.all([
    db.select().from(schema.infraBusinessManagers),
    db.select().from(schema.infraProfileBm),
    db.select().from(schema.infraBmAdAccount),
  ]);
  const profilesByBm = new Map<string, string[]>();
  for (const l of profileLinks) {
    const list = profilesByBm.get(l.bmId) ?? [];
    list.push(l.profileId);
    profilesByBm.set(l.bmId, list);
  }
  const accountsByBm = new Map<string, string[]>();
  for (const l of accountLinks) {
    const list = accountsByBm.get(l.bmId) ?? [];
    list.push(l.adAccountId);
    accountsByBm.set(l.bmId, list);
  }
  return rows
    .map((r) => ({
      id: r.id,
      bmId: r.bmId,
      name: r.name,
      status: r.status,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      notes: r.notes,
      profileIds: profilesByBm.get(r.id) ?? [],
      adAccountIds: accountsByBm.get(r.id) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface BmHistoryEntry {
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  actorEmail: string;
  at: string;
}

export interface BmDetail {
  bm: BmView;
  /** Profiles administering this BM, with usability resolved. */
  profiles: { id: string; name: string; status: string; usable: boolean }[];
  adAccounts: { id: string; label: string | null }[];
  history: BmHistoryEntry[];
}

export async function fetchBmDetail(id: string): Promise<BmDetail | null> {
  await requireAdmin();
  const [row] = await db
    .select()
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, id));
  if (!row) return null;

  const [profileRows, accountRows, historyRows] = await Promise.all([
    db
      .select({
        id: schema.infraProfiles.id,
        name: schema.infraProfiles.name,
        status: schema.infraProfiles.status,
      })
      .from(schema.infraProfileBm)
      .innerJoin(schema.infraProfiles, eq(schema.infraProfiles.id, schema.infraProfileBm.profileId))
      .where(eq(schema.infraProfileBm.bmId, id)),
    db
      .select({ id: schema.infraAdAccounts.id, label: schema.infraAdAccounts.label })
      .from(schema.infraBmAdAccount)
      .innerJoin(
        schema.infraAdAccounts,
        eq(schema.infraAdAccounts.id, schema.infraBmAdAccount.adAccountId),
      )
      .where(eq(schema.infraBmAdAccount.bmId, id)),
    db
      .select()
      .from(schema.infraStatusEvents)
      .where(and(eq(schema.infraStatusEvents.kind, "bm"), eq(schema.infraStatusEvents.entityId, id)))
      .orderBy(desc(schema.infraStatusEvents.at))
      .limit(100),
  ]);

  return {
    bm: {
      id: row.id,
      bmId: row.bmId,
      name: row.name,
      status: row.status,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      notes: row.notes,
      profileIds: profileRows.map((p) => p.id),
      adAccountIds: accountRows.map((a) => a.id),
    },
    profiles: profileRows.map((p) => ({
      ...p,
      usable: isProfileStatus(p.status) ? usableProfile(p.status) : false,
    })),
    adAccounts: accountRows,
    history: historyRows.map((h) => ({
      event: h.event,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      reason: h.reason,
      actorEmail: h.actorEmail,
      at: h.at.toISOString(),
    })),
  };
}

export async function saveBm(input: {
  id?: string | null;
  bmId: string;
  name: string;
  status: string;
  notes?: string | null;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  const user = await requireAdmin();
  const name = input.name.trim();
  const bmId = input.bmId.trim();
  if (!name) return { ok: false, error: "Name is required" };
  if (!bmId) return { ok: false, error: "BM ID is required" };
  if (!isBmStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${BM_STATUSES.join(", ")}` };
  }

  // Checked explicitly so the operator gets a sentence, not a unique-violation stack trace.
  const [clash] = await db
    .select({ id: schema.infraBusinessManagers.id, name: schema.infraBusinessManagers.name })
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.bmId, bmId));
  if (clash && clash.id !== input.id) {
    return { ok: false, error: `BM ID ${bmId} is already registered as "${clash.name}"` };
  }

  const fields = { bmId, name, notes: input.notes?.trim() || null, updatedAt: new Date() };

  if (input.id) {
    const [existing] = await db
      .select()
      .from(schema.infraBusinessManagers)
      .where(eq(schema.infraBusinessManagers.id, input.id));
    if (!existing) return { ok: false, error: "Business Manager not found" };
    const statusChanged = existing.status !== input.status;
    await db
      .update(schema.infraBusinessManagers)
      .set({
        ...fields,
        status: input.status,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
      })
      .where(eq(schema.infraBusinessManagers.id, input.id));
    if (statusChanged) {
      await logInfraEvent({
        kind: "bm",
        entityId: input.id,
        event: "status_change",
        fromStatus: existing.status,
        toStatus: input.status,
        actorEmail: user.email,
      });
    }
    await audit("infra.bm.update", `${name} (${bmId})`);
    return { ok: true, id: input.id };
  }

  const id = randomUUID();
  await db
    .insert(schema.infraBusinessManagers)
    .values({ ...fields, id, status: input.status, verifiedAt: new Date() });
  await audit("infra.bm.create", `${name} (${bmId})`);
  return { ok: true, id };
}

/**
 * Impact preview for a ban. Reports paths lost, which is the true statement under a flat access list —
 * there is no "primary BM" to re-point, so claiming accounts need reassignment would be a lie.
 */
export async function previewBmBan(input: {
  id: string;
}): Promise<{ accountsLosingAPath: number; accountsLeftWithNone: number; profiles: number }> {
  await requireAdmin();
  const [accountLinks, allLinks, bms, profileLinks] = await Promise.all([
    db
      .select()
      .from(schema.infraBmAdAccount)
      .where(eq(schema.infraBmAdAccount.bmId, input.id)),
    db.select().from(schema.infraBmAdAccount),
    db.select().from(schema.infraBusinessManagers),
    db.select().from(schema.infraProfileBm).where(eq(schema.infraProfileBm.bmId, input.id)),
  ]);
  const status = new Map(bms.map((b) => [b.id, b.status]));
  const affected = new Set(accountLinks.map((l) => l.adAccountId));
  let leftWithNone = 0;
  for (const accountId of affected) {
    const remaining = allLinks.filter(
      (l) =>
        l.adAccountId === accountId &&
        l.bmId !== input.id &&
        isBmStatus(status.get(l.bmId) ?? "") &&
        usableBmStatus(status.get(l.bmId) ?? ""),
    );
    if (remaining.length === 0) leftWithNone++;
  }
  return {
    accountsLosingAPath: affected.size,
    accountsLeftWithNone: leftWithNone,
    profiles: profileLinks.length,
  };
}

function usableBmStatus(status: string): boolean {
  return status === "active" || status === "pending_verification";
}

export async function setBmStatus(input: {
  id: string;
  status: string;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  if (!isBmStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${BM_STATUSES.join(", ")}` };
  }
  const [existing] = await db
    .select()
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, input.id));
  if (!existing) return { ok: false, error: "Business Manager not found" };
  if (existing.status === input.status) return { ok: true };

  await db
    .update(schema.infraBusinessManagers)
    .set({ status: input.status, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraBusinessManagers.id, input.id));
  await logInfraEvent({
    kind: "bm",
    entityId: input.id,
    event: "status_change",
    fromStatus: existing.status,
    toStatus: input.status,
    reason: input.reason?.trim() || null,
    actorEmail: user.email,
  });
  await audit("infra.bm.status", `${existing.name}: ${existing.status} → ${input.status}`);
  return { ok: true };
}

/** Human attestation: records that someone looked, as history rather than an overwritten stamp. */
export async function verifyBm(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const [existing] = await db
    .select()
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, input.id));
  if (!existing) return { ok: false, error: "Business Manager not found" };
  await db
    .update(schema.infraBusinessManagers)
    .set({ verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraBusinessManagers.id, input.id));
  await logInfraEvent({
    kind: "bm",
    entityId: input.id,
    event: "verify",
    actorEmail: user.email,
  });
  await audit("infra.bm.verify", `${existing.name} (${existing.bmId})`);
  return { ok: true };
}

export async function deleteBm(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const rooted = await db
    .select({ id: schema.infraPixels.id, name: schema.infraPixels.name })
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.rootBmId, input.id));
  if (rooted.length > 0) {
    return {
      ok: false,
      error: `Roots ${rooted.length} pixel(s): ${rooted.map((p) => p.name).join(", ")}. Re-root them first.`,
    };
  }
  await db
    .delete(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, input.id));
  await audit("infra.bm.delete", input.id);
  return { ok: true };
}

export async function linkBmAdAccount(input: {
  bmId: string;
  adAccountId: string;
  action: "add" | "remove";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  if (input.action === "add") {
    await db
      .insert(schema.infraBmAdAccount)
      .values({ bmId: input.bmId, adAccountId: input.adAccountId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.infraBmAdAccount)
      .where(
        and(
          eq(schema.infraBmAdAccount.bmId, input.bmId),
          eq(schema.infraBmAdAccount.adAccountId, input.adAccountId),
        ),
      );
  }
  await audit("infra.bm.account_link", `${input.action} ${input.bmId} ↔ ${input.adAccountId}`);
  return { ok: true };
}
```

- [ ] **Step 2: Remove the duplicated usability helper**

`previewBmBan` above defines a local `usableBmStatus`, duplicating `usableBm` from
`@/lib/infra-risk`. Delete the local function and use the imported `usableBm` with an `isBmStatus`
guard instead — one definition of "is this BM an access path", per the design's single-selector rule.

- [ ] **Step 3: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no errors.

```bash
git add src/server/fns/infra/bms.ts
git commit -m "feat(infra): business manager server fns with ban impact preview"
```

---

## Task 8: Ad account, pixel and page server fns

**Files:**
- Create: `src/server/fns/infra/ad-accounts.ts`
- Create: `src/server/fns/infra/pixels.ts`
- Create: `src/server/fns/infra/pages.ts`

- [ ] **Step 1: Write `ad-accounts.ts`**

The `LEFT JOIN` is the whole point of this file: registry fields are operator-owned, everything else is
read from `accounts`, which syncs hourly.

```ts
// src/server/fns/infra/ad-accounts.ts
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { AD_ACCOUNT_USAGE, isAdAccountUsage } from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";

/** `act_` followed by digits. The join key across every system, per the CLAUDE.md invariant. */
const AD_ACCOUNT_ID = /^act_\d+$/;

export interface AdAccountView {
  id: string;
  label: string | null;
  usageState: string;
  notes: string | null;
  bmIds: string[];
  /** Null when the account is not (yet) in the synced book — rendered as a "not in sync" badge. */
  synced: {
    name: string;
    status: string | null;
    disableReason: number | null;
    spendCap: number | null;
    balance: number | null;
    currency: string;
  } | null;
}

export async function fetchAdAccounts(): Promise<AdAccountView[]> {
  await requireAdmin();
  const [rows, links] = await Promise.all([
    db
      .select({
        id: schema.infraAdAccounts.id,
        label: schema.infraAdAccounts.label,
        usageState: schema.infraAdAccounts.usageState,
        notes: schema.infraAdAccounts.notes,
        syncedName: schema.accounts.name,
        syncedStatus: schema.accounts.status,
        disableReason: schema.accounts.disableReason,
        spendCap: schema.accounts.spendCap,
        balance: schema.accounts.balance,
        currency: schema.accounts.currency,
      })
      .from(schema.infraAdAccounts)
      .leftJoin(schema.accounts, eq(schema.accounts.id, schema.infraAdAccounts.id)),
    db.select().from(schema.infraBmAdAccount),
  ]);
  const bmsByAccount = new Map<string, string[]>();
  for (const l of links) {
    const list = bmsByAccount.get(l.adAccountId) ?? [];
    list.push(l.bmId);
    bmsByAccount.set(l.adAccountId, list);
  }
  return rows
    .map((r) => ({
      id: r.id,
      label: r.label,
      usageState: r.usageState,
      notes: r.notes,
      bmIds: bmsByAccount.get(r.id) ?? [],
      synced: r.syncedName
        ? {
            name: r.syncedName,
            status: r.syncedStatus,
            disableReason: r.disableReason,
            spendCap: r.spendCap,
            balance: r.balance,
            currency: r.currency ?? "USD",
          }
        : null,
    }))
    .sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));
}

/** Accounts in the synced book that are not yet registered — the pick list for "add". */
export async function fetchUnregisteredAccounts(): Promise<{ id: string; name: string }[]> {
  await requireAdmin();
  const [synced, registered] = await Promise.all([
    db.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts),
    db.select({ id: schema.infraAdAccounts.id }).from(schema.infraAdAccounts),
  ]);
  const have = new Set(registered.map((r) => r.id));
  return synced.filter((a) => !have.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveAdAccount(input: {
  id: string;
  label?: string | null;
  usageState: string;
  notes?: string | null;
  isNew?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const id = input.id.trim();
  if (!AD_ACCOUNT_ID.test(id)) {
    return { ok: false, error: "Ad account id must look like act_1234567890" };
  }
  if (!isAdAccountUsage(input.usageState)) {
    return { ok: false, error: `Usage must be one of: ${AD_ACCOUNT_USAGE.join(", ")}` };
  }
  const fields = {
    label: input.label?.trim() || null,
    usageState: input.usageState,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.infraAdAccounts)
    .values({ id, ...fields })
    .onConflictDoUpdate({ target: schema.infraAdAccounts.id, set: fields });
  await audit("infra.account.save", `${id} (${input.usageState})`);
  return { ok: true };
}

export async function deleteAdAccount(input: {
  id: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  // BM memberships cascade; nothing else depends on an account row.
  await db.delete(schema.infraAdAccounts).where(eq(schema.infraAdAccounts.id, input.id));
  await audit("infra.account.delete", input.id);
  return { ok: true };
}

export async function linkAdAccountBm(input: {
  adAccountId: string;
  bmId: string;
  action: "add" | "remove";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  if (input.action === "add") {
    await db
      .insert(schema.infraBmAdAccount)
      .values({ bmId: input.bmId, adAccountId: input.adAccountId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.infraBmAdAccount)
      .where(
        and(
          eq(schema.infraBmAdAccount.bmId, input.bmId),
          eq(schema.infraBmAdAccount.adAccountId, input.adAccountId),
        ),
      );
  }
  await audit("infra.account.link", `${input.action} ${input.adAccountId} ↔ ${input.bmId}`);
  return { ok: true };
}
```

- [ ] **Step 2: Write `pixels.ts`**

The one invariant enforced here: a pixel's root BM is never also a share. Enforced once, on write —
not at four layers as in the reference implementation.

```ts
// src/server/fns/infra/pixels.ts
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { PIXEL_STATUSES, isPixelStatus } from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";
import { logInfraEvent } from "./events";

export interface PixelView {
  id: string;
  name: string;
  rootBmId: string;
  status: string;
  verifiedAt: string | null;
  notes: string | null;
  sharedBmIds: string[];
}

export async function fetchPixels(): Promise<PixelView[]> {
  await requireAdmin();
  const [rows, links] = await Promise.all([
    db.select().from(schema.infraPixels),
    db.select().from(schema.infraPixelBm),
  ]);
  const sharesByPixel = new Map<string, string[]>();
  for (const l of links) {
    const list = sharesByPixel.get(l.pixelId) ?? [];
    list.push(l.bmId);
    sharesByPixel.set(l.pixelId, list);
  }
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      rootBmId: r.rootBmId,
      status: r.status,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      notes: r.notes,
      sharedBmIds: sharesByPixel.get(r.id) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function savePixel(input: {
  id: string;
  name: string;
  rootBmId: string;
  status: string;
  notes?: string | null;
  isNew?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id) return { ok: false, error: "Pixel ID is required" };
  if (!name) return { ok: false, error: "Name is required" };
  if (!isPixelStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PIXEL_STATUSES.join(", ")}` };
  }
  const [rootBm] = await db
    .select({ id: schema.infraBusinessManagers.id })
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, input.rootBmId));
  if (!rootBm) return { ok: false, error: "Root BM must be a registered Business Manager" };

  const [existing] = await db
    .select()
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.id, id));
  const fields = {
    name,
    rootBmId: input.rootBmId,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  };

  if (existing) {
    const statusChanged = existing.status !== input.status;
    await db
      .update(schema.infraPixels)
      .set({
        ...fields,
        status: input.status,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
      })
      .where(eq(schema.infraPixels.id, id));
    if (statusChanged) {
      await logInfraEvent({
        kind: "pixel",
        entityId: id,
        event: "status_change",
        fromStatus: existing.status,
        toStatus: input.status,
        actorEmail: user.email,
      });
    }
  } else {
    await db
      .insert(schema.infraPixels)
      .values({ ...fields, id, status: input.status, verifiedAt: new Date() });
  }

  // The invariant: the root BM is never also a share. Enforced once, here.
  await db
    .delete(schema.infraPixelBm)
    .where(
      and(eq(schema.infraPixelBm.pixelId, id), eq(schema.infraPixelBm.bmId, input.rootBmId)),
    );

  await audit(existing ? "infra.pixel.update" : "infra.pixel.create", `${name} (${id})`);
  return { ok: true };
}

export async function setPixelStatus(input: {
  id: string;
  status: string;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  if (!isPixelStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PIXEL_STATUSES.join(", ")}` };
  }
  const [existing] = await db
    .select()
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.id, input.id));
  if (!existing) return { ok: false, error: "Pixel not found" };
  if (existing.status === input.status) return { ok: true };
  await db
    .update(schema.infraPixels)
    .set({ status: input.status, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraPixels.id, input.id));
  await logInfraEvent({
    kind: "pixel",
    entityId: input.id,
    event: "status_change",
    fromStatus: existing.status,
    toStatus: input.status,
    reason: input.reason?.trim() || null,
    actorEmail: user.email,
  });
  await audit("infra.pixel.status", `${existing.name}: ${existing.status} → ${input.status}`);
  return { ok: true };
}

export async function verifyPixel(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const [existing] = await db
    .select()
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.id, input.id));
  if (!existing) return { ok: false, error: "Pixel not found" };
  await db
    .update(schema.infraPixels)
    .set({ verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraPixels.id, input.id));
  await logInfraEvent({
    kind: "pixel",
    entityId: input.id,
    event: "verify",
    actorEmail: user.email,
  });
  await audit("infra.pixel.verify", `${existing.name} (${input.id})`);
  return { ok: true };
}

export async function deletePixel(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  await db.delete(schema.infraPixels).where(eq(schema.infraPixels.id, input.id));
  await audit("infra.pixel.delete", input.id);
  return { ok: true };
}

export async function linkPixelBm(input: {
  pixelId: string;
  bmId: string;
  action: "add" | "remove";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const [pixel] = await db
    .select({ rootBmId: schema.infraPixels.rootBmId })
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.id, input.pixelId));
  if (!pixel) return { ok: false, error: "Pixel not found" };
  if (input.action === "add") {
    if (pixel.rootBmId === input.bmId) {
      return { ok: false, error: "The root BM is already the owner and cannot also be a share" };
    }
    await db
      .insert(schema.infraPixelBm)
      .values({ pixelId: input.pixelId, bmId: input.bmId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.infraPixelBm)
      .where(
        and(
          eq(schema.infraPixelBm.pixelId, input.pixelId),
          eq(schema.infraPixelBm.bmId, input.bmId),
        ),
      );
  }
  await audit("infra.pixel.link", `${input.action} ${input.pixelId} ↔ ${input.bmId}`);
  return { ok: true };
}
```

- [ ] **Step 3: Write `pages.ts`**

Same shape as `pixels.ts`, with two link tables instead of one and the owner invariant in place of the
root invariant. Complete surface to implement:

```ts
export interface PageView {
  id: string; pageId: string | null; pageUrl: string; name: string;
  ownerProfileId: string; status: string; verifiedAt: string | null; notes: string | null;
  bmIds: string[]; profileIds: string[];
}
export async function fetchPages(): Promise<PageView[]>
export async function savePage(input: {
  id?: string | null; pageId?: string | null; pageUrl: string; name: string;
  ownerProfileId: string; status: string; notes?: string | null;
}): Promise<{ ok: boolean; error?: string; id?: string }>
export async function setPageStatus(input: { id: string; status: string; reason?: string | null }): Promise<{ ok: boolean; error?: string }>
export async function verifyPage(input: { id: string }): Promise<{ ok: boolean; error?: string }>
export async function deletePage(input: { id: string }): Promise<{ ok: boolean; error?: string }>
export async function linkPageBm(input: { pageId: string; bmId: string; action: "add" | "remove" }): Promise<{ ok: boolean; error?: string }>
export async function linkPageProfile(input: { pageId: string; profileId: string; action: "add" | "remove" }): Promise<{ ok: boolean; error?: string }>
```

Rules, all enforced server-side:
- `name` and `pageUrl` are required and trimmed; `pageId` is optional (may be null).
- `status` guarded with `isPageStatus`, error lists `PAGE_STATUSES`.
- `ownerProfileId` must resolve to an existing `infra_profiles` row → else
  `{ ok: false, error: "Owner must be a registered profile" }`.
- **Owner invariant:** on save, delete any `infra_page_profile` row pairing this page with its owner.
  In `linkPageProfile`, adding the owner returns
  `{ ok: false, error: "The owner already has access and cannot also be an additional profile" }`.
- New rows get `id: randomUUID()` and `verifiedAt: new Date()`.
- Status change → `logInfraEvent({ kind: "page", event: "status_change", ... })` plus
  `statusChangedAt`. Verify → `logInfraEvent({ kind: "page", event: "verify", ... })`.
- `audit()` actions: `infra.page.create`, `infra.page.update`, `infra.page.status`,
  `infra.page.verify`, `infra.page.delete`, `infra.page.link`.
- `deletePage` needs no dependency check — both link tables cascade and nothing references a page.

- [ ] **Step 4: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no errors.

```bash
git add src/server/fns/infra/ad-accounts.ts src/server/fns/infra/pixels.ts src/server/fns/infra/pages.ts
git commit -m "feat(infra): ad account, pixel and page server fns"
```

---

## Task 9: The API layer

**Files:**
- Create: `src/lib/api/infrastructure.ts`

This file ships to the client, so it stays pure plumbing — no `db`, no `node:crypto`, no business logic.

- [ ] **Step 1: Write the wrappers**

```ts
// src/lib/api/infrastructure.ts
import { createServerFn } from "@tanstack/react-start";
import { fetchRiskMap } from "@/server/fns/infra/risk";
import {
  deleteProfile,
  fetchProfiles,
  linkProfileBm,
  saveProfile,
  setProfileStatus,
} from "@/server/fns/infra/profiles";
import {
  deleteBm,
  fetchBmDetail,
  fetchBms,
  linkBmAdAccount,
  previewBmBan,
  saveBm,
  setBmStatus,
  verifyBm,
} from "@/server/fns/infra/bms";
import {
  deleteAdAccount,
  fetchAdAccounts,
  fetchUnregisteredAccounts,
  linkAdAccountBm,
  saveAdAccount,
} from "@/server/fns/infra/ad-accounts";
import {
  deletePixel,
  fetchPixels,
  linkPixelBm,
  savePixel,
  setPixelStatus,
  verifyPixel,
} from "@/server/fns/infra/pixels";
import {
  deletePage,
  fetchPages,
  linkPageBm,
  linkPageProfile,
  savePage,
  setPageStatus,
  verifyPage,
} from "@/server/fns/infra/pages";

// ── Reads

export const getInfraRiskMap = createServerFn({ method: "GET" }).handler(() => fetchRiskMap());
export const listInfraProfiles = createServerFn({ method: "GET" }).handler(() => fetchProfiles());
export const listInfraBms = createServerFn({ method: "GET" }).handler(() => fetchBms());
export const listInfraAdAccounts = createServerFn({ method: "GET" }).handler(() =>
  fetchAdAccounts(),
);
export const listUnregisteredAccounts = createServerFn({ method: "GET" }).handler(() =>
  fetchUnregisteredAccounts(),
);
export const listInfraPixels = createServerFn({ method: "GET" }).handler(() => fetchPixels());
export const listInfraPages = createServerFn({ method: "GET" }).handler(() => fetchPages());

export const getInfraBmDetail = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => fetchBmDetail(data));

// ── Profiles

export const saveInfraProfile = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id?: string | null;
      name: string;
      status: string;
      geo?: string | null;
      browser?: string | null;
      proxyProvider?: string | null;
      notes?: string | null;
    }) => d,
  )
  .handler(({ data }) => saveProfile(data));

export const setInfraProfileStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => setProfileStatus(data));

export const deleteInfraProfile = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteProfile(data));

export const linkInfraProfileBm = createServerFn({ method: "POST" })
  .inputValidator((d: { profileId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkProfileBm(data));

// ── Business Managers

export const saveInfraBm = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id?: string | null;
      bmId: string;
      name: string;
      status: string;
      notes?: string | null;
    }) => d,
  )
  .handler(({ data }) => saveBm(data));

export const setInfraBmStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => setBmStatus(data));

export const getInfraBmBanPreview = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => previewBmBan(data));

export const verifyInfraBm = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => verifyBm(data));

export const deleteInfraBm = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteBm(data));

export const linkInfraBmAdAccount = createServerFn({ method: "POST" })
  .inputValidator((d: { bmId: string; adAccountId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkBmAdAccount(data));

// ── Ad accounts

export const saveInfraAdAccount = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id: string;
      label?: string | null;
      usageState: string;
      notes?: string | null;
      isNew?: boolean;
    }) => d,
  )
  .handler(({ data }) => saveAdAccount(data));

export const deleteInfraAdAccount = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deleteAdAccount(data));

export const linkInfraAdAccountBm = createServerFn({ method: "POST" })
  .inputValidator((d: { adAccountId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkAdAccountBm(data));

// ── Pixels

export const saveInfraPixel = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id: string;
      name: string;
      rootBmId: string;
      status: string;
      notes?: string | null;
      isNew?: boolean;
    }) => d,
  )
  .handler(({ data }) => savePixel(data));

export const setInfraPixelStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => setPixelStatus(data));

export const verifyInfraPixel = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => verifyPixel(data));

export const deleteInfraPixel = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deletePixel(data));

export const linkInfraPixelBm = createServerFn({ method: "POST" })
  .inputValidator((d: { pixelId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkPixelBm(data));

// ── Pages

export const saveInfraPage = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id?: string | null;
      pageId?: string | null;
      pageUrl: string;
      name: string;
      ownerProfileId: string;
      status: string;
      notes?: string | null;
    }) => d,
  )
  .handler(({ data }) => savePage(data));

export const setInfraPageStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; reason?: string | null }) => d)
  .handler(({ data }) => setPageStatus(data));

export const verifyInfraPage = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => verifyPage(data));

export const deleteInfraPage = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => deletePage(data));

export const linkInfraPageBm = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string; bmId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkPageBm(data));

export const linkInfraPageProfile = createServerFn({ method: "POST" })
  .inputValidator((d: { pageId: string; profileId: string; action: "add" | "remove" }) => d)
  .handler(({ data }) => linkPageProfile(data));
```

- [ ] **Step 2: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no errors.

```bash
git add src/lib/api/infrastructure.ts
git commit -m "feat(infra): server fn api surface"
```

---

## Task 10: Extend StatusPill

**Files:**
- Modify: `src/components/dashboard/StatusPill.tsx:3-18`

- [ ] **Step 1: Add the new statuses to both maps**

Extend, do not replace — the existing six keys are used by the campaign and account tables. Append
these entries inside the existing `styles` object:

```ts
  // Infrastructure registry statuses.
  NEW: "bg-primary/10 text-primary ring-primary/20",
  IN_REVIEW: "bg-warning/10 text-warning ring-warning/20",
  PENDING_VERIFICATION: "bg-warning/10 text-warning ring-warning/20",
  SUSPENDED: "bg-destructive/10 text-destructive ring-destructive/20",
  RESTRICTED: "bg-destructive/10 text-destructive ring-destructive/20",
  BANNED: "bg-destructive/20 text-destructive ring-destructive/30",
  RETIRED: "bg-muted text-muted-foreground ring-border",
  INACTIVE: "bg-muted text-muted-foreground ring-border",
  UNPUBLISHED: "bg-warning/10 text-warning ring-warning/20",
  IN_USE: "bg-success/10 text-success ring-success/20",
  SPARE: "bg-primary/10 text-primary ring-primary/20",
```

And the matching entries inside `dots`:

```ts
  NEW: "bg-primary",
  IN_REVIEW: "bg-warning",
  PENDING_VERIFICATION: "bg-warning",
  SUSPENDED: "bg-destructive",
  RESTRICTED: "bg-destructive",
  BANNED: "bg-destructive",
  RETIRED: "bg-muted-foreground",
  INACTIVE: "bg-muted-foreground",
  UNPUBLISHED: "bg-warning",
  IN_USE: "bg-success",
  SPARE: "bg-primary",
```

`StatusPill` already does `status.toUpperCase()` and renders `s.toLowerCase()` with underscores intact,
so `in_review` displays as `in_review`. That matches the existing pill behaviour; leave it.

- [ ] **Step 2: Commit**

```bash
git add src/components/dashboard/StatusPill.tsx
git commit -m "feat(infra): status pill styles for registry statuses"
```

---

## Task 11: Shared components

**Files:**
- Create: `src/components/infra/RiskBadge.tsx`
- Create: `src/components/infra/LinkChips.tsx`

- [ ] **Step 1: Write `RiskBadge.tsx`**

```tsx
// src/components/infra/RiskBadge.tsx
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Risk } from "@/lib/infra-risk";

const tone: Record<Risk["level"], string> = {
  critical: "bg-destructive/10 text-destructive ring-destructive/20",
  warning: "bg-warning/10 text-warning ring-warning/20",
  safe: "bg-success/10 text-success ring-success/20",
};

const icon: Record<Risk["level"], typeof AlertTriangle> = {
  critical: ShieldAlert,
  warning: AlertTriangle,
  safe: CheckCircle2,
};

export function RiskBadge({ risk, className }: { risk: Risk; className?: string }) {
  const Icon = icon[risk.level];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 uppercase tracking-wider",
        tone[risk.level],
        className,
      )}
    >
      <Icon className="size-3" />
      {risk.label}
    </span>
  );
}
```

- [ ] **Step 2: Write `LinkChips.tsx`**

The universal M:N editor, used by all five list screens. Unlike the reference implementation's version,
it surfaces server-side rejections instead of writing blindly.

```tsx
// src/components/infra/LinkChips.tsx
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LinkOption {
  id: string;
  label: string;
  /** Rendered dimmed with a marker — e.g. a banned BM, which is a real link but not an access path. */
  unusable?: boolean;
}

/**
 * Chips for the linked set plus a `+` popover of the unlinked options.
 *
 * `onChange` returns the server's verdict so a refused link (root BM as a share, owner as an
 * additional profile) shows its reason rather than silently doing nothing.
 */
export function LinkChips({
  linked,
  options,
  onChange,
  emptyLabel = "none",
}: {
  linked: string[];
  options: LinkOption[];
  onChange: (id: string, action: "add" | "remove") => Promise<{ ok: boolean; error?: string }>;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = new Map(options.map((o) => [o.id, o]));
  const linkedSet = new Set(linked);
  const available = options.filter((o) => !linkedSet.has(o.id));

  const apply = async (id: string, action: "add" | "remove") => {
    setBusy(true);
    setError(null);
    const res = await onChange(id, action);
    setBusy(false);
    if (!res.ok) setError(res.error ?? "Failed");
    else setOpen(false);
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {linked.length === 0 && (
          <span className="text-[11px] text-muted-foreground">{emptyLabel}</span>
        )}
        {linked.map((id) => {
          const opt = byId.get(id);
          return (
            <span
              key={id}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px]",
                opt?.unusable && "opacity-60 line-through",
              )}
            >
              {opt?.label ?? id}
              <button
                type="button"
                disabled={busy}
                onClick={() => apply(id, "remove")}
                className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                aria-label={`Unlink ${opt?.label ?? id}`}
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        {available.length > 0 && (
          <div className="relative">
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              aria-label="Add link"
            >
              <Plus className="size-3" />
            </button>
            {open && (
              <div className="absolute z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
                {available.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    disabled={busy}
                    onClick={() => apply(o.id, "add")}
                    className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent disabled:opacity-40"
                  >
                    {o.label}
                    {o.unusable && <span className="ml-1 text-muted-foreground">(unusable)</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no errors.

```bash
git add src/components/infra/RiskBadge.tsx src/components/infra/LinkChips.tsx
git commit -m "feat(infra): risk badge and link chip editor"
```

---

## Task 12: Sidebar group and the risk map page

**Files:**
- Modify: `src/components/layout/AppSidebar.tsx`
- Create: `src/routes/infrastructure.index.tsx`

- [ ] **Step 1: Add the nav group**

In `AppSidebar.tsx`, add to the lucide import: `Network, IdCard, Building, CreditCard, Crosshair, Flag`.
Then declare the array beside the existing `main` (around line 55):

```tsx
const infrastructure = [
  { title: "Risk Map", url: "/infrastructure", icon: Network },
  { title: "Profiles", url: "/infrastructure/profiles", icon: IdCard },
  { title: "Business Managers", url: "/infrastructure/business-managers", icon: Building },
  { title: "Ad Accounts", url: "/infrastructure/ad-accounts", icon: CreditCard },
  { title: "Pixels", url: "/infrastructure/pixels", icon: Crosshair },
  { title: "Pages", url: "/infrastructure/pages", icon: Flag },
];
```

In the component body, render a third `<SidebarGroup>` between the Intelligence and System groups,
gated on `isAdmin(user.role)`, mirroring the existing group markup exactly:

```tsx
{isAdmin(user.role) && (
  <SidebarGroup>
    <SidebarGroupLabel>Infrastructure</SidebarGroupLabel>
    <SidebarGroupContent>
      <SidebarMenu>
        {infrastructure.map((item) => (
          <NavLink key={item.url} item={item} isActive={isActive(item.url)} />
        ))}
      </SidebarMenu>
    </SidebarGroupContent>
  </SidebarGroup>
)}
```

Read the existing groups first and copy their exact component structure and prop names — `NavLink`'s
signature is local to this file and must not be guessed.

**Important:** `isActive` uses `pathname.startsWith(url)`, so `/infrastructure` matches every child
route and would stay lit on all of them. Make the Risk Map entry exact-match:
`item.url === "/infrastructure" ? pathname === "/infrastructure" : pathname.startsWith(item.url)`.

- [ ] **Step 2: Write the risk map route**

```tsx
// src/routes/infrastructure.index.tsx
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { getCurrentUser } from "@/lib/api/auth";
import { getInfraRiskMap } from "@/lib/api/infrastructure";
import { isAdmin } from "@/lib/auth/roles";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PagePendingSkeleton } from "@/components/dashboard/PagePendingSkeleton";
import { RiskBadge } from "@/components/infra/RiskBadge";
import { StatusPill } from "@/components/dashboard/StatusPill";
import type { InfraRiskRow } from "@/server/fns/infra/risk";

export const Route = createFileRoute("/infrastructure/")({
  head: () => ({
    meta: [
      { title: "Infrastructure — MetaConsole" },
      {
        name: "description",
        content: "Access-path risk across profiles, Business Managers, ad accounts, pixels and pages.",
      },
    ],
  }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    return await getInfraRiskMap();
  },
  component: InfrastructurePage,
  pendingComponent: () => <PagePendingSkeleton rows={8} kpis={5} />,
});

function Section({ title, rows, hrefBase }: { title: string; rows: InfraRiskRow[]; hrefBase?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-[11px] text-muted-foreground font-mono">
          {rows.filter((r) => r.risk.level !== "safe").length} at risk of {rows.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
              <th className="text-left px-5 py-2.5">Name</th>
              <th className="text-left px-3 py-2.5">Status</th>
              <th className="text-left px-3 py-2.5">Risk</th>
              <th className="text-left px-5 py-2.5">Access</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-accent/40 transition-colors">
                <td className="px-5 py-3">
                  {hrefBase ? (
                    <Link to={`${hrefBase}/${r.id}`} className="hover:text-primary">
                      {r.name}
                    </Link>
                  ) : (
                    r.name
                  )}
                  {r.overdue && (
                    <span className="ml-2 text-[10px] text-warning">verification overdue</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-3 py-3">
                  <RiskBadge risk={r.risk} />
                </td>
                <td className="px-5 py-3 text-[11px] text-muted-foreground">{r.detail}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-8 text-center text-sm text-muted-foreground">
                  Nothing registered yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InfrastructurePage() {
  const map = Route.useLoaderData();
  const { counts } = map;

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Infrastructure"
        description={
          map.atRisk === 0
            ? "Every asset has redundant access."
            : `${map.atRisk} asset${map.atRisk === 1 ? "" : "s"} with fewer than two independent access paths.`
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Profiles", value: counts.profiles, to: "/infrastructure/profiles" },
          { label: "Business Managers", value: counts.bms, to: "/infrastructure/business-managers" },
          { label: "Ad Accounts", value: counts.adAccounts, to: "/infrastructure/ad-accounts" },
          { label: "Pixels", value: counts.pixels, to: "/infrastructure/pixels" },
          { label: "Pages", value: counts.pages, to: "/infrastructure/pages" },
        ].map((c) => (
          <Link
            key={c.label}
            to={c.to}
            className="rounded-xl border border-border bg-card px-4 py-3 hover:bg-accent/40 transition-colors"
          >
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {c.label}
            </div>
            <div className="text-2xl font-semibold tabular-nums">{c.value}</div>
          </Link>
        ))}
      </div>

      <Section title="Business Managers" rows={map.bms} hrefBase="/infrastructure/business-managers" />
      <Section title="Ad Accounts" rows={map.adAccounts} />
      <Section title="Pixels" rows={map.pixels} />
      <Section title="Pages" rows={map.pages} />
    </div>
  );
}
```

Check the real export names of `PageHeader` and `PagePendingSkeleton` before writing the imports, and
confirm `getCurrentUser` lives in `@/lib/api/auth` — read `src/routes/sync.tsx:1-20` for the exact
import lines used by an existing admin-gated page.

- [ ] **Step 3: Verify the route renders**

Run: `bun run dev`, then open `http://localhost:3000/infrastructure` as an admin.
Expected: empty-state risk map with five zero counters and "Every asset has redundant access."

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/AppSidebar.tsx src/routes/infrastructure.index.tsx
git commit -m "feat(infra): infrastructure nav group and risk map page"
```

---

## Task 13: Profiles route

**Files:**
- Create: `src/routes/infrastructure.profiles.tsx`

This is the reference list page. Tasks 14–17 follow its exact structure.

- [ ] **Step 1: Write the route**

Structure, mirroring `src/routes/accounts.index.tsx` and `src/routes/users.tsx`:

```tsx
export const Route = createFileRoute("/infrastructure/profiles")({
  head: () => ({ meta: [{ title: "Profiles — MetaConsole" }] }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    const [profiles, bms] = await Promise.all([listInfraProfiles(), listInfraBms()]);
    return { profiles, bms };
  },
  component: ProfilesPage,
  pendingComponent: () => <PagePendingSkeleton rows={10} kpis={0} />,
});
```

Component requirements:

- **State:** `useState` for the search string, the status filter (`"all"` plus `PROFILE_STATUSES`), the
  form-dialog target (`ProfileView | "new" | null`) and an inline `msg` string. Local state, not URL
  state — matches `accounts.index.tsx:44-48`.
- **Search** matches, case-insensitively: profile `name`, `geo`, `notes`, **and the name or `bmId` of
  any linked BM**. That last clause is the multi-hop search the design calls for; lowercase both sides.
- **Table** in the standard markup (see Task 12's `Section` for the exact classes), sorted with
  `useSort` from `@/components/dashboard/SortableTable` with accessors
  `{ name: r => r.name, status: r => r.status, bms: r => r.bmIds.length }`, initial key `"name"`,
  initial dir `"asc"`. Columns:
  | Column | Content |
  | --- | --- |
  | Name | `r.name` |
  | Status | `<StatusPill status={r.status} />` |
  | Assigned BMs | `<LinkChips linked={r.bmIds} options={bmOptions} onChange={...} emptyLabel="spare" />` where `bmOptions` maps every BM to `{ id, label: bm.name, unusable: !usableBm(bm.status) }` and `onChange` calls `linkInfraProfileBm({ data: { profileId: r.id, bmId: id, action } })` then `router.invalidate()` |
  | Geo | `r.geo ?? "—"` |
  | Browser | `r.browser ?? "—"` |
  | Proxy | `r.proxyProvider ?? "—"` |
  | Actions | Edit button (opens the dialog) and Delete button guarded by `window.confirm` |
- **Footer row:** `{filtered.length} of {profiles.length} profiles` in
  `px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono`.
- **Empty state:** a single `<tr><td colSpan={7} …>No profiles match your filters.</td></tr>`.
- **Form dialog** using `Dialog`/`DialogContent`/`DialogTitle` from `@/components/ui/dialog` (the
  pattern in `CampaignTable.tsx`'s `AdCreativeDialog`). Fields: Name (required), Status (`<select>` over
  `PROFILE_STATUSES`), Geo, Browser, Proxy provider, Notes. One `useState` object for the form, updated
  with `setForm({ ...form, field: v })`. Submit calls
  `saveInfraProfile({ data: { ...form, id: target === "new" ? null : target.id } })`; on `{ ok: false }`
  render `res.error` inside the dialog; on success close it and `await router.invalidate()`.
- **Delete:** `window.confirm(\`Delete ${r.name}?\`)`, then `deleteInfraProfile({ data: { id: r.id } })`.
  A refusal (the profile owns a page) sets `msg` to `res.error` — surface it, never swallow it.
- **No toasts.** Feedback is the inline `msg` string plus `window.confirm`, per the codebase.

- [ ] **Step 2: Verify in the browser**

Run: `bun run dev`. Create a profile, edit it, link it to a BM, try deleting a profile that owns a page.
Expected: create and edit persist across reload; the delete refusal shows the page name.

- [ ] **Step 3: Commit**

```bash
git add src/routes/infrastructure.profiles.tsx
git commit -m "feat(infra): profiles registry page"
```

---

## Task 14: Business Managers route and detail page

**Files:**
- Create: `src/routes/infrastructure.business-managers.tsx`
- Create: `src/routes/infrastructure.business-managers.$id.tsx`

- [ ] **Step 1: Write the list route**

Same skeleton as Task 13. Loader: `Promise.all([listInfraBms(), listInfraProfiles(), listInfraAdAccounts()])`.

- **Search** matches BM `name`, `bmId`, `notes`, and the name of any linked profile or ad account.
  Lowercase both sides — the reference implementation compares `bmId` case-sensitively, which is a bug.
- **Sort accessors:** `{ name, status, profiles: r => r.profileIds.length, accounts: r => r.adAccountIds.length, verified: r => r.verifiedAt ?? "" }`.
- **Columns:** Name (link to `/infrastructure/business-managers/$id`) · BM ID with a copy button
  (`setCopied(true); setTimeout(() => setCopied(false), 2000)`, per `accounts.index.tsx:97-99`) ·
  Status pill · Profiles `LinkChips` (options = all profiles, `unusable: !usableProfile(p.status)`,
  `onChange` → `linkInfraProfileBm`) · Ad Accounts `LinkChips` (options = all registered accounts,
  `onChange` → `linkInfraBmAdAccount`) · Last verified as relative time via `fmtRelTime` from
  `@/lib/format`, with an amber "overdue" marker when `isVerificationOverdue(new Date(r.verifiedAt), new Date())` ·
  Actions: Verify, Edit, Delete.
- **Verify** calls `verifyInfraBm({ data: { id } })` then `router.invalidate()`. Hide it when
  `r.status === "banned"`.
- **Ban confirmation.** When the status `<select>` moves to `banned` from anything else, do **not**
  write immediately. Call `getInfraBmBanPreview({ data: { id } })` and show an `AlertDialog`
  (`@/components/ui/alert-dialog`) reading:
  `"{accountsLosingAPath} ad account(s) lose an access path; {accountsLeftWithNone} would be left with none. {profiles} profile(s) are assigned."`
  Confirm calls `setInfraBmStatus({ data: { id, status: "banned", reason } })` with a reason captured
  from a text input in the dialog. Cancel leaves the status untouched.
  Phrase it as paths lost — under a flat access list there is no primary BM to re-point, so any wording
  about accounts "needing reassignment" would be false.
- **Form dialog** fields: Name (required), BM ID (required), Status, Notes. Submit → `saveInfraBm`.
  A duplicate `bmId` returns `{ ok: false, error }`; render it in the dialog.

- [ ] **Step 2: Write the detail route**

```tsx
export const Route = createFileRoute("/infrastructure/business-managers/$id")({
  loader: async ({ params }) => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    const detail = await getInfraBmDetail({ data: params.id });
    if (!detail) throw notFound();
    return detail;
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.bm.name ?? "Business Manager"} — MetaConsole` }],
  }),
  component: BmDetailPage,
  notFoundComponent: () => (
    <div className="p-6 md:p-8 space-y-4 max-w-[1100px]">
      <Link to="/infrastructure/business-managers" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-3.5" /> All Business Managers
      </Link>
      <p className="text-sm text-muted-foreground">Business Manager not found.</p>
    </div>
  ),
});
```

Page content, `max-w-[1100px]`:
1. Back link to the list, exactly as `clients.$id.tsx:117-122`.
2. `PageHeader` with the BM name; description `BM {bmId}`; right-side children: `StatusPill` and
   `RiskBadge` computed as `bmRisk(profiles.filter(p => p.usable).length)`.
3. **Access chain** card: `Business Manager → profiles`, listing each profile with its status pill,
   unusable ones dimmed, and a red "No usable profile — this BM is unreachable" line when none are.
4. **Ad accounts** card listing `detail.adAccounts` with `label ?? id`.
5. **History** card: a table of `detail.history` — `at` formatted with `fmtRelTime`, `event`,
   `fromStatus → toStatus` (or "verified" for a `verify` event), `reason`, `actorEmail`. Empty state
   "No recorded changes yet."

- [ ] **Step 3: Verify in the browser and commit**

Create a BM, link two profiles, verify it, ban it and confirm the preview counts are right, then open
the detail page and confirm the history shows the ban with both statuses, the reason and your email.

```bash
git add src/routes/infrastructure.business-managers.tsx src/routes/infrastructure.business-managers.\$id.tsx
git commit -m "feat(infra): business manager pages with ban preview and history"
```

---

## Task 15: Ad accounts route

**Files:**
- Create: `src/routes/infrastructure.ad-accounts.tsx`

- [ ] **Step 1: Write the route**

Loader: `Promise.all([listInfraAdAccounts(), listInfraBms(), listUnregisteredAccounts()])`.

- **Search** matches `id`, `label`, `notes`, `synced.name`, and any linked BM's name.
- **Sort accessors:** `{ name: r => r.label ?? r.id, usage: r => r.usageState, bms: r => r.bmIds.length, spend: r => r.synced?.spendCap ?? 0 }`.
- **Columns:**
  | Column | Content |
  | --- | --- |
  | Name | `r.label ?? r.synced?.name ?? r.id` |
  | Account ID | `r.id` in `font-mono text-[10px] text-muted-foreground` with a copy button |
  | Live status | **Read-only, from sync.** `r.synced` null → a muted "not in sync" badge. Otherwise `<StatusPill status={accountStatus(r.synced.status)} />` using `accountStatus()` from `@/server/agg` — never compare raw codes, per the CLAUDE.md invariant. Append `disableReasonLabel(r.synced.disableReason)` from `@/lib/format` when the reason is non-zero |
  | Usage | `<StatusPill status={r.usageState} />` |
  | BMs | `LinkChips` over all BMs, `unusable: !usableBm(bm.status)`, `onChange` → `linkInfraAdAccountBm` |
  | Spend cap | `fmtCurrency(r.synced.spendCap, r.synced.currency)` right-aligned `font-mono`, `"—"` when unsynced |
  | Balance | same treatment |
  | Actions | Edit, Delete |
- **Register dialog:** a `<select>` of `unregistered` accounts (`{id, name}`) plus a free-text id field
  for an account not in sync yet, then Label, Usage (`<select>` over `AD_ACCOUNT_USAGE`) and Notes.
  Submit → `saveInfraAdAccount`. An id failing `/^act_\d+$/` returns an error; render it.
- **No status field in the form.** This is the design's decision 2 — the account's status comes from
  sync and must not be typed. Do not add one.
- Check `accountStatus`'s exact import path and signature before use (`src/server/agg.ts`). If it is
  server-only, map the raw code in the server fn instead and return a display string from
  `fetchAdAccounts` — do not import server code into a route component.

- [ ] **Step 2: Verify and commit**

Register an account that exists in sync and confirm its live status and disable reason match `/accounts`.
Register a made-up `act_999` and confirm it renders "not in sync".

```bash
git add src/routes/infrastructure.ad-accounts.tsx
git commit -m "feat(infra): ad account registry with joined live status"
```

---

## Task 16: Pixels route

**Files:**
- Create: `src/routes/infrastructure.pixels.tsx`

- [ ] **Step 1: Write the route**

Loader: `Promise.all([listInfraPixels(), listInfraBms()])`.

- **Search** matches pixel `name`, `id`, `notes`, and the name or `bmId` of the root BM or any share.
- **Sort accessors:** `{ name, status, shares: r => r.sharedBmIds.length }`.
- **Columns:** Name · Pixel ID with copy · Status pill · Root BM (the BM's name, dimmed with an
  "unusable" marker when `!usableBm(status)`) · Shared BMs `LinkChips` where **options exclude the root
  BM** · Risk via `RiskBadge` computed with `pixelRisk({ status, rootBmStatus, shareCount })` · Verified
  relative time · Actions: Verify, Edit, Delete.
- **Form dialog** fields: Pixel ID (required, disabled when editing — it is the primary key), Name
  (required), Root BM (`<select>` of registered BMs, required), Status, Notes. Submit → `saveInfraPixel`.
- Attempting to add the root BM as a share is refused server-side; `LinkChips` renders the reason.

- [ ] **Step 2: Verify and commit**

Create a pixel with a root BM and no shares; confirm it reads `warning "Not shared"`. Add a share and
confirm `safe "Shared"`. Ban the root BM and confirm `critical "Root BM unusable"`.

```bash
git add src/routes/infrastructure.pixels.tsx
git commit -m "feat(infra): pixels registry page"
```

---

## Task 17: Pages route

**Files:**
- Create: `src/routes/infrastructure.pages.tsx`

- [ ] **Step 1: Write the route**

Loader: `Promise.all([listInfraPages(), listInfraBms(), listInfraProfiles()])`.

- **Search** matches page `name`, `pageId`, `pageUrl`, `notes`, the owner profile's name, any additional
  profile's name, and any linked BM's name or `bmId`.
- **Sort accessors:** `{ name, status, bms: r => r.bmIds.length }`.
- **Columns:** Name · Identifier — `pageUrl` as an `<a target="_blank" rel="noreferrer">` with a
  `https://` prefix added when it does not match `/^https?:\/\//i`, else `pageId`, plus a copy button ·
  Status pill · Owner (profile name; when the owner is unusable render "no active owner" in
  `text-destructive`) · Linked BMs `LinkChips` → `linkInfraPageBm` · Additional Profiles `LinkChips`
  with **the owner excluded from options** → `linkInfraPageProfile` · Risk via `pageRisk` · Actions:
  Verify, Edit, Delete.
- **Form dialog** fields: Name (required), Page URL (required), Page ID (optional), Owner Profile
  (`<select>`, required — list usable profiles plus the current owner even if unusable, so an existing
  record stays editable), Status, Notes. Submit → `saveInfraPage`.
- Adding the owner as an additional profile is refused server-side; render the reason.

- [ ] **Step 2: Verify and commit**

Create a page with an owner and no BMs; confirm `warning "No added access"`. Link a BM; confirm
`safe "Added"`. Suspend the owner; confirm `critical "No active owner"`.

```bash
git add src/routes/infrastructure.pages.tsx
git commit -m "feat(infra): pages registry page"
```

---

## Task 18: Full verification

**Files:** none.

- [ ] **Step 1: Typecheck and lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean. Fix anything reported; do not suppress with `eslint-disable` unless the existing
codebase already does so for that rule in a comparable place.

- [ ] **Step 2: Run the feature's tests**

Run: `bun test src/lib/infra-status.test.ts src/lib/infra-risk.test.ts`
Expected: PASS, 24 tests.

Run: `bun test src/server/fns/infra/infra.db.test.ts --timeout 60000`
Expected: PASS, 9 tests.

Do not run the whole suite — it is slow over the tunnel, and the roadmap's guidance is to run what
covers the change.

- [ ] **Step 3: End-to-end smoke test, in the browser**

This is the verification that matters — a passing unit test does not prove a screen works. With
`bun run dev`, as an admin:

1. Create two profiles, `alpha` and `beta`, both `active`.
2. Create a BM `Main BM`. Confirm the risk map shows it `critical "No backup"`.
3. Link `alpha`. Confirm `warning "Single access"`.
4. Link `beta`. Confirm `safe "Redundant"`.
5. Set `beta` to `suspended`. Confirm the BM returns to `warning` — a suspended profile is not a path.
6. Register an ad account that exists in sync, link it to `Main BM`, and confirm its live status and
   disable reason match what `/accounts` shows for the same account.
7. Ban `Main BM` via the confirmation dialog with a reason. Confirm the preview counted the account,
   the ad account now reads `critical "No backup"`, and the BM detail page's history shows
   `active → banned` with your email and the reason.
8. Try to delete `alpha` while it owns a page — confirm the refusal names the page.
9. Sign in as a `member` and confirm `/infrastructure` redirects to `/` and the sidebar group is absent.

- [ ] **Step 4: Confirm no sync job touches the registry**

Run: `grep -rn "infra" src/sync/`
Expected: **no matches.** This is the feature's core invariant; a match means something writes the
registry from a sync path and must be removed.

- [ ] **Step 5: Merge and deploy**

```bash
git checkout feat/meta-integration
git pull --rebase origin feat/meta-integration
git merge --no-ff feat/infra-monitor
bunx tsc --noEmit && bun run lint
git push origin feat/meta-integration
git push droplet feat/meta-integration
ssh <droplet> "EXPECT=$(git rev-parse HEAD) bash /opt/meta-dashboard/deploy/deploy.sh"
```

`EXPECT` is mandatory — forgetting the `droplet` push otherwise deploys stale code while reporting
success. Then confirm `systemctl is-active meta-web` is `active` and
`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/` returns 200/3xx.

`meta-sync` does **not** need restarting: this change adds no sync code. The schema is already pushed
(Task 4), so the deploy is code-only.

---

## Self-review

**Spec coverage:** every §-section of the design maps to a task — boundary (docs, already committed) →
Task 3 comments; data model → Task 3; risk model → Task 2; routes/UI → Tasks 12–17; server layer →
Tasks 5–9; verification/attestation → Tasks 7, 16, 17; failure modes → the error paths in Tasks 6–8;
out-of-scope items appear in no task, which is the point.

**Known gaps, deliberately left to the implementer:**
- Task 5 Step 5 flags that `requireAdmin()` may throw outside a request context and tells the
  implementer to split the fn rather than weaken the guard. That is a real unknown about
  `src/server/fns/auth.ts` behaviour in tests, and guessing would be worse than naming it.
- Tasks 12, 15 tell the implementer to confirm export names and paths (`PageHeader`,
  `PagePendingSkeleton`, `getCurrentUser`, `accountStatus`) before writing imports, because those were
  read from a summary rather than the file.

**Type consistency:** `Risk`, `RiskLevel`, `InfraRiskRow`, `InfraRiskMap`, `ProfileView`, `BmView`,
`BmDetail`, `AdAccountView`, `PixelView`, `PageView`, `LinkOption` are each defined once and referenced
with the same names throughout. Vocabulary constants are `PROFILE_STATUSES`, `BM_STATUSES`,
`PIXEL_STATUSES`, `PAGE_STATUSES`, `AD_ACCOUNT_USAGE`, `INFRA_KINDS`. Predicates are `usableProfile`,
`usableBm`. Table exports are `infraProfiles`, `infraBusinessManagers`, `infraAdAccounts`,
`infraPixels`, `infraPages`, `infraProfileBm`, `infraBmAdAccount`, `infraPixelBm`, `infraPageBm`,
`infraPageProfile`, `infraStatusEvents`.
