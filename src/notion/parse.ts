import type { NotionPage, NotionProp } from "./client";
import { MACHINE_STATUSES } from "@/lib/delivery-status";

/**
 * Extract act_ ids from a free-text cell. Separators are commas and newlines
 * (newlines are treated as commas); each token may carry junk (URLs, labels),
 * so we take the digit run (10+ digits) inside it and ignore the rest.
 */
export function parseAccountIds(text: string): string[] {
  const out: string[] = [];
  for (const token of text.replace(/\r?\n/g, ",").split(",")) {
    const m = token.match(/\d{10,}/);
    if (m) out.push(`act_${m[0]}`);
  }
  return [...new Set(out)];
}

/**
 * Canonical grouping key for a client title. Rows like
 * "wildcasino.ag (June/July 2026)" and "wildcasino.ag (May/June 2026))"
 * must club together, so everything from the first "(" is dropped.
 */
export function clientKey(title: string): string {
  return title.split("(")[0].replace(/\s+/g, " ").trim().toLowerCase();
}

/** URL-safe stable id from a client key. */
export function clientSlug(key: string): string {
  return key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

/** Collapse a column name to a comparable form: case, spacing, punctuation and any emoji marker are
 *  cosmetic in Notion and DO drift ("Ads Platform ", " Meta URL", "🤖 Daily Budget ($)"). */
const keyShape = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The real column name for `want` among `keys`, ignoring cosmetic drift (stray spaces, an emoji
 * marker, punctuation). Returns null when the board genuinely has no such column, so a caller can
 * report a missing column instead of silently reading undefined.
 */
export function resolvePropertyKey(keys: Iterable<string>, want: string): string | null {
  const target = keyShape(want);
  for (const k of keys) if (k === want) return k; // exact match wins
  for (const k of keys) if (keyShape(k) === target) return k;
  return null;
}

/**
 * Distinct campaign-row (brand) titles from a client's stored `raw` pages
 * (`[{ pageId, title }]`). Agency clients group several brand rows under one
 * Client-Account entity, so these titles are the brand aliases users search by.
 */
export function brandTitles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const p of raw) {
    const t = (p as { title?: unknown }).title;
    if (typeof t === "string" && t.trim()) out.push(t.trim());
  }
  return [...new Set(out)];
}

/**
 * The contributing Notion rows stored on `clients.raw`, with the page id and each row's OWN
 * `Account Status`. The clubbed client status is a DIFFERENT thing (the winning row's) and must not be
 * substituted for it: whether an override on a row is inert depends on that row's own value.
 */
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
      // Rows stored before owners were captured have none; the next Notion sync fills them in. The
      // id test is the same one `peopleIds` applies on the way in: jsonb is the LESS trusted side, so
      // it must not be the more permissive one.
      ownerIds: Array.isArray(owners)
        ? owners.filter((x): x is string => typeof x === "string" && x.length > 0)
        : [],
    });
  }
  return out;
}

/**
 * The same board rows with the owner ids stripped, for callers that ship them off the server.
 * `boardRows` carries each row's Notion `Owners` person UUIDs, and `ClientDetail.notionRows` is
 * serialised verbatim by a `createServerFn` with no output schema — those ids exist for the daily
 * check-in and have no business on the wire to every authenticated viewer. Derived from `boardRows`
 * so the two shapes cannot drift apart.
 */
export function boardRowsWithoutOwners(
  raw: unknown,
): { pageId: string; title: string; status: string | null }[] {
  return boardRows(raw).map(({ pageId, title, status }) => ({ pageId, title, status }));
}

export interface ParsedCampaignRow {
  pageId: string;
  title: string;
  clientRelationIds: string[];
  activeIds: string[];
  otherIds: string[];
  status: string | null;
  /** Notion `Owners` person ids for this row — the daily check-in's recipient list. */
  ownerIds: string[];
  budget: number | null;
  startDate: string | null;
  endDate: string | null;
}

export interface ClubbedClient {
  id: string;
  name: string;
  status: string | null;
  accountIds: string[];
  activeAccountIds: string[]; // subset from the "Active Account ID" column ("Other ad accounts" excluded)
  /** Contributing Notion rows. Each keeps ITS OWN account mapping so a brand/engagement can be
   * reported at row grain (not just merged client totals). */
  pages: {
    pageId: string;
    title: string;
    status: string | null;
    accountIds: string[];
    /** Notion `Owners` person ids for this row — the daily check-in's recipient list. */
    ownerIds: string[];
  }[];
  budget: number | null;
  startDate: string | null;
  endDate: string | null;
}

const plain = (p: NotionProp | undefined): string =>
  (p?.title ?? p?.rich_text ?? []).map((t) => t.plain_text).join("");

const relationIds = (p: NotionProp | undefined): string[] =>
  ((p?.relation as { id: string }[] | undefined) ?? []).map((r) => r.id);

const peopleIds = (p: NotionProp | undefined): string[] =>
  ((p?.people as { id?: string }[] | undefined) ?? [])
    .map((x) => x.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

/**
 * The board column holding the delivery/lifecycle status. Named here because the READ side owns the
 * canonical spelling — the write side resolves it fuzzily and may stamp the 🤖 marker onto it.
 */
export const ACCOUNT_STATUS_COLUMN = "Account Status";

/** The board's `Account Status` cell, found whether or not the 🤖 marker has been stamped on it. */
function statusOf(page: NotionPage): string | null {
  const key = resolvePropertyKey(Object.keys(page.properties ?? {}), ACCOUNT_STATUS_COLUMN);
  return key ? (page.properties?.[key]?.status?.name ?? null) : null;
}

/** Pull the columns we care about out of a campaign page; null when it has no Campaign title. */
export function parseCampaignRow(page: NotionPage): ParsedCampaignRow | null {
  const title = plain(page.properties?.["Campaign"]).trim();
  if (!title) return null;
  return {
    pageId: page.id,
    title,
    clientRelationIds: relationIds(page.properties?.["Client Account"]),
    activeIds: parseAccountIds(plain(page.properties?.["Active Account ID"])),
    otherIds: parseAccountIds(plain(page.properties?.["Other ad accounts"])),
    // Resolved rather than read by exact name: the write side stamps 🤖 onto this column, and an
    // exact-name miss here would return null for every row — making them all non-live, which stops
    // every other column, nulls `clients.status` and leaves STATUS_PRIORITY scoring every row 0.
    status: statusOf(page),
    // The board's `Owners` people column. Person ids, not names: names drift, ids do not.
    ownerIds: peopleIds(page.properties?.["Owners"]),
    budget: (page.properties?.["Budget ($)"]?.number as number | null) ?? null,
    startDate:
      (page.properties?.["Actual Start Date"]?.date as { start?: string } | null)?.start ??
      (page.properties?.["Ideal Start Date"]?.date as { start?: string } | null)?.start ??
      null,
    endDate:
      (page.properties?.["End Date (Estimated)"]?.date as { start?: string } | null)?.start ?? null,
  };
}

/** Display name of a client entity from the linked Clients board ("" when unnamed). */
export function parseClientName(page: NotionPage): string {
  return plain(page.properties?.["Client Name"]).trim();
}

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

/**
 * Group campaigns into clients. A campaign groups by its linked Clients-board entity (the
 * "Client Account" relation, name resolved via `clientNames`); an unlinked campaign falls back to
 * grouping by its own title. Each client gets the union of every ad account across its campaigns
 * (`accountIds`), the strongest status, and the current engagement's budget/dates (latest end date).
 * `activeAccountIds` is the "Active Account ID" from ONLY the rows matching the client's winning
 * status, so a finished row's stale active account never overrides the currently-live one.
 */
export function clubClients(
  rows: ParsedCampaignRow[],
  clientNames: Map<string, string>,
): ClubbedClient[] {
  const clubKey = (row: ParsedCampaignRow): string => {
    const relId = row.clientRelationIds[0];
    const linkedName = relId ? clientNames.get(relId) : undefined;
    return linkedName && relId ? relId : clientKey(row.title);
  };
  const byKey = new Map<string, ClubbedClient>();
  for (const row of rows) {
    const key = clubKey(row);
    const relId = row.clientRelationIds[0];
    const linkedName = relId ? clientNames.get(relId) : undefined;
    const name = (linkedName ?? row.title.split("(")[0]).replace(/\s+/g, " ").trim();
    let c = byKey.get(key);
    if (!c) {
      c = {
        id: clientSlug(clientKey(name)),
        name,
        status: row.status,
        accountIds: [],
        activeAccountIds: [],
        pages: [],
        budget: null,
        startDate: null,
        endDate: null,
      };
      byKey.set(key, c);
    }
    c.accountIds = [...new Set([...c.accountIds, ...row.activeIds, ...row.otherIds])];
    c.pages.push({
      pageId: row.pageId,
      title: row.title,
      status: row.status,
      accountIds: [...new Set([...row.activeIds, ...row.otherIds])],
      ownerIds: row.ownerIds,
    });
    if ((STATUS_PRIORITY[row.status ?? ""] ?? 0) > (STATUS_PRIORITY[c.status ?? ""] ?? 0)) {
      c.status = row.status;
    }
    // Budget + dates reflect the current engagement: the row with the latest end date.
    const later = row.endDate && (!c.endDate || row.endDate > c.endDate);
    if (later) {
      c.endDate = row.endDate;
      c.startDate = row.startDate;
      c.budget = row.budget;
    } else if (c.endDate == null && c.budget == null && row.budget != null) {
      c.budget = row.budget;
      c.startDate = row.startDate;
    }
  }
  // Second pass: the active account(s) come ONLY from rows whose status matches the client's final
  // winning status — an old "Full Budget Finished" row must not contribute a stale Active Account ID.
  for (const row of rows) {
    const c = byKey.get(clubKey(row));
    if (c && row.status === c.status)
      c.activeAccountIds = [...new Set([...c.activeAccountIds, ...row.activeIds])];
  }
  return [...byKey.values()];
}
