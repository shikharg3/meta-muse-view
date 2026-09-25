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
