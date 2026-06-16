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

export interface ParsedClientRow {
  pageId: string;
  title: string;
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
  pages: { pageId: string; title: string }[];
  budget: number | null;
  startDate: string | null;
  endDate: string | null;
}

const plain = (p: NotionProp | undefined): string =>
  (p?.title ?? p?.rich_text ?? []).map((t) => t.plain_text).join("");

/** Pull the columns we care about out of a Notion page; null when not a client row. */
export function parseClientRow(page: NotionPage): ParsedClientRow | null {
  const title = plain(page.properties?.["Client"]).trim();
  if (!title) return null;
  return {
    pageId: page.id,
    title,
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

// Highest-priority status wins when a client has multiple board rows.
const STATUS_PRIORITY: Record<string, number> = {
  Live: 5,
  "On Boarding": 4,
  Paused: 3,
  "Full Budget Finished": 2,
  "Not started": 1,
};

/**
 * Group rows by normalized client name; each client gets the union of every
 * ad account that ever appeared on any of its rows (active and old alike).
 */
export function clubClients(rows: ParsedClientRow[]): ClubbedClient[] {
  const byKey = new Map<string, ClubbedClient>();
  for (const row of rows) {
    const key = clientKey(row.title);
    const display = row.title.split("(")[0].replace(/\s+/g, " ").trim();
    let c = byKey.get(key);
    if (!c) {
      c = {
        id: clientSlug(key),
        name: display,
        status: row.status,
        accountIds: [],
        pages: [],
        budget: null,
        startDate: null,
        endDate: null,
      };
      byKey.set(key, c);
    }
    c.accountIds = [...new Set([...c.accountIds, ...row.activeIds, ...row.otherIds])];
    c.pages.push({ pageId: row.pageId, title: row.title });
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
  return [...byKey.values()];
}
