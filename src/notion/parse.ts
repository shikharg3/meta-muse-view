import type { NotionPage, NotionProp } from "./client";

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

export interface ParsedCampaignRow {
  pageId: string;
  title: string;
  clientRelationIds: string[];
  activeIds: string[];
  otherIds: string[];
  status: string | null;
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
  pages: { pageId: string; title: string; status: string | null; accountIds: string[] }[];
  budget: number | null;
  startDate: string | null;
  endDate: string | null;
}

const plain = (p: NotionProp | undefined): string =>
  (p?.title ?? p?.rich_text ?? []).map((t) => t.plain_text).join("");

const relationIds = (p: NotionProp | undefined): string[] =>
  ((p?.relation as { id: string }[] | undefined) ?? []).map((r) => r.id);

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
    status: page.properties?.["Account Status"]?.status?.name ?? null,
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
const STATUS_PRIORITY: Record<string, number> = {
  Live: 6,
  "Budget Finished - Top Up": 5, // still running, just awaiting a top-up
  "On Boarding": 4,
  Paused: 3,
  "Full Budget Finished": 2,
  "Not started": 1,
};

/** Statuses meaning the engagement is (or should be) delivering right now. */
export const LIVE_STATUSES: readonly string[] = ["Live", "Budget Finished - Top Up", "On Boarding"];

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
