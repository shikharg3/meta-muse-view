import { effectiveAccountIds } from "@/sync/jobs/clients";

/**
 * Which ad accounts a brand covers — derived, not hand-maintained.
 *
 * The Notion client board already answers this. Each board row is one engagement ("a project") and
 * `clients.raw` keeps every row with ITS OWN account mapping, which the sync stores at row grain
 * precisely so a brand can be resolved from it rather than typed in again. Asking an operator to
 * re-pick the accounts would mean maintaining the same fact in two places, and the copy would go
 * stale the moment a new month's engagement appeared on the board.
 *
 * ## The stored rule, not a snapshot
 *
 * `brands.project_ids` is the whole configuration:
 *
 * - **`null` — follow the client.** Every project it has now and every project it gains later. This
 *   is the default, and it is what makes a new engagement appear in the portal by itself: the
 *   accounts are recomputed on read, so nothing has to be re-saved when Notion changes.
 * - **an array of Notion page ids — those engagements only.** For a client whose board rows are not
 *   all the same commercial brand. Unknown ids are ignored rather than failing, because a board row
 *   can be deleted.
 *
 * Storing the resolved account list instead would have been simpler to read and wrong: it is a
 * cache of a fact that changes upstream on someone else's schedule.
 */

/** One Notion board row, as `clients.raw` stores it. */
export interface ClientProject {
  pageId: string;
  title: string;
  status: string | null;
  accountIds: string[];
  ownerIds: string[];
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Parse `clients.raw` into projects.
 *
 * Tolerant by design: `raw` is a mirror of a Notion board that people edit by hand, so a row
 * missing its accounts or its title is normal and must not take the whole client down with it.
 * A row with no `pageId` is dropped, because the page id is what a selection refers to.
 */
export function clientProjects(raw: unknown): ClientProject[] {
  if (!Array.isArray(raw)) return [];
  const out: ClientProject[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const pageId = typeof r.pageId === "string" ? r.pageId : null;
    if (!pageId) continue;
    out.push({
      pageId,
      title: typeof r.title === "string" ? r.title : "",
      status: typeof r.status === "string" ? r.status : null,
      accountIds: asStrings(r.accountIds),
      ownerIds: asStrings(r.ownerIds),
    });
  }
  return out;
}

/** The client columns this module needs. Narrow on purpose so callers can select only these. */
export interface ClientAccountSource {
  notionAccountIds: unknown;
  manualAddIds: unknown;
  manualRemoveIds: unknown;
  raw: unknown;
}

/**
 * Read `brands.project_ids` as a selection.
 *
 * `null` is meaningful — "follow the client" — so it must survive intact rather than collapsing to
 * an empty array, which would mean the opposite: a brand covering no projects and therefore no
 * accounts. Every caller that reads the column goes through this so the two cannot be confused.
 */
export function projectSelection(value: unknown): string[] | null {
  return value === null || value === undefined ? null : asStrings(value);
}

/** The projects a brand covers: every one of the client's when it follows the client, else its selection. */
export function coveredProjects(projectIds: unknown, raw: unknown): ClientProject[] {
  const selection = projectSelection(projectIds);
  const all = clientProjects(raw);
  if (selection === null) return all;
  const wanted = new Set(selection);
  return all.filter((p) => wanted.has(p.pageId));
}

/**
 * Which project each account counts under, for per-project settings and per-project access.
 *
 * Boards reuse ad accounts across rows — one owner adds a row per monthly engagement on the same
 * accounts — so an account can sit on several projects while a campaign belongs to exactly one
 * account. The rule is: the NEWEST project listing the account wins, and newest is board order.
 * The sync stores rows in the order Notion returns them, newest-created first (every multi-row
 * board observed on 2026-09-25 reads that way: "betonline.ag (September/October)" before
 * "(August/September)" …), so the first row listing an account is its current engagement.
 *
 * Only `accountIds` count — the brand's resolved accounts — so an account an operator removed, or
 * one outside a brand's narrowing, is attributed to nothing. An account the brand reaches without
 * any project listing it (a manual addition) has no entry, and its campaigns simply inherit the
 * brand's own settings.
 */
export function projectOfAccount(
  projects: readonly ClientProject[],
  accountIds: Iterable<string>,
): Map<string, string> {
  const usable = new Set(accountIds);
  const owner = new Map<string, string>();
  for (const p of projects) {
    for (const a of p.accountIds) if (usable.has(a) && !owner.has(a)) owner.set(a, p.pageId);
  }
  return owner;
}

// ── Brands: groups of board rows ────────────────────────────────────────────────────────────────

/** URL scheme, then `www.`: a title typed as a link ("https://playquack.com/") names its site. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The automatic group key of a board row title: its first word, lowercased, without a URL scheme,
 * `www.` or domain ending.
 *
 * Boards add a row per engagement and title each one after the brand plus whatever tells them
 * apart: "betonline.ag (August/September)", "betonline.ag (June 2026)", "Watt2Trade Renewal May
 * 2026" beside "watt2trade.com", "Farside (2)" beside "farside.app", "BSpin August 2026" beside
 * "bspin.io (April 2026)". The first word is the part they share; stripping only a trailing bracket
 * would merge the first pair and miss the rest (measured on the live board, 2026-09-25). Two
 * genuinely different brands of one owner that start with the same word are rarer, and an admin can
 * move a row (`portal_project_settings.group_key`). Empty when the title has no letters or digits.
 */
export function autoGroupKey(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(SCHEME, "")
    .replace(/^www\./, "");
  return s.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/u)?.[0] ?? "";
}

/**
 * A row title as a Brand name: without trailing "( … )" groups — repeatedly, so a stray extra
 * bracket goes too — URL scheme, `www.` and trailing slashes. "wildcasino.ag (May/June 2026))" →
 * "wildcasino.ag", "https://playquack.com/" → "playquack.com".
 */
export function baseTitle(title: string): string {
  let s = title.trim();
  for (;;) {
    const next = s.replace(/\s*\([^()]*\)+\s*$/, "").trim();
    if (next === s) break;
    s = next;
  }
  return s
    .replace(SCHEME, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .trim();
}

/** The key of a Brand an admin named by hand. Prefixed so it can never collide with an automatic key. */
export const manualGroupKey = (name: string): string =>
  `n:${name.trim().toLowerCase().replace(/\s+/g, " ")}`;

/** A group's global id — owner plus key, because keys are only unique within one owner's board. */
export const groupId = (clientId: string, key: string): string => `${clientId}:${key}`;

/** One Brand: an owner's board rows that are the same brand, newest row first. */
export interface ProjectGroup {
  key: string;
  /** The admin's name when set, else `autoName`. */
  name: string;
  /** The shortest `baseTitle` of its rows (ties → the newest). */
  autoName: string;
  named: boolean;
  projects: ClientProject[];
  /** Page ids an admin moved into this group, rather than the title putting them here. */
  moved: Set<string>;
}

/**
 * Group an owner's board rows into Brands.
 *
 * `overrides` is page id → group key for rows an admin moved; `names` is group key → admin-set name.
 * Groups come out ordered by their newest row, rows inside a group in board order — so the first
 * group is the owner's current engagement and the first row of a group its current month.
 */
export function projectGroups(
  projects: readonly ClientProject[],
  overrides: ReadonlyMap<string, string> = new Map(),
  names: ReadonlyMap<string, string> = new Map(),
): ProjectGroup[] {
  const byKey = new Map<string, ProjectGroup>();
  for (const p of projects) {
    const override = overrides.get(p.pageId);
    const key = override || autoGroupKey(p.title) || `row:${p.pageId}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, name: "", autoName: "", named: false, projects: [], moved: new Set() };
      byKey.set(key, group);
    }
    group.projects.push(p);
    if (override) group.moved.add(p.pageId);
  }
  for (const group of byKey.values()) {
    let auto = "";
    for (const p of group.projects) {
      const b = baseTitle(p.title);
      if (b && (!auto || b.length < auto.length)) auto = b;
    }
    group.autoName = auto || group.projects[0]?.title.trim() || "Untitled brand";
    const named = names.get(group.key)?.trim();
    group.named = Boolean(named);
    group.name = named || group.autoName;
  }
  return [...byKey.values()];
}

/**
 * The accounts a brand covers.
 *
 * Two rules compose, and both can only ever NARROW:
 *
 * 1. The project selection picks accounts out of the client's board rows.
 * 2. `brand_accounts`, when it has any rows for this brand, intersects that down further. It exists
 *    for the client running two commercial brands out of one engagement — the rare case that
 *    project grain cannot express. It is an allowlist, never an addition: widening here could pull
 *    in an account the client does not own, which is the one mistake that leaks across clients.
 *
 * Everything is finally intersected with `effectiveAccountIds()` — (Notion ∪ manually added) minus
 * manually removed — so an account an operator has explicitly removed from the client stays removed
 * no matter what a stale board row still lists.
 */
export function brandAccountIds(
  projectIds: unknown,
  client: ClientAccountSource,
  overrideAccountIds: readonly string[] = [],
): string[] {
  const effective = new Set(effectiveAccountIds(client));
  if (effective.size === 0) return [];

  const selection = projectIds === null || projectIds === undefined ? null : asStrings(projectIds);

  let candidates: Set<string>;
  if (selection === null) {
    candidates = effective;
  } else {
    const wanted = new Set(selection);
    candidates = new Set<string>();
    for (const p of clientProjects(client.raw)) {
      if (!wanted.has(p.pageId)) continue;
      for (const id of p.accountIds) if (effective.has(id)) candidates.add(id);
    }
  }

  if (overrideAccountIds.length === 0) return [...candidates];
  const allow = new Set(overrideAccountIds);
  return [...candidates].filter((id) => allow.has(id));
}
