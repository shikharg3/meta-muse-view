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
  pages: { pageId: string; title: string }[];
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

// Highest-priority status wins when a client has multiple board rows.
const STATUS_PRIORITY: Record<string, number> = {
  Live: 5,
  "On Boarding": 4,
  Paused: 3,
  "Full Budget Finished": 2,
  "Not started": 1,
};

/**
 * Group campaigns into clients. A campaign groups by its linked Clients-board entity (the
 * "Client Account" relation, name resolved via `clientNames`); an unlinked campaign falls back to
 * grouping by its own title. Each client gets the union of every ad account across its campaigns,
 * the strongest status, and the current engagement's budget/dates (the latest-end-date campaign).
 */
export function clubClients(
  rows: ParsedCampaignRow[],
  clientNames: Map<string, string>,
): ClubbedClient[] {
  const byKey = new Map<string, ClubbedClient>();
  for (const row of rows) {
    // Prefer the linked client entity; fall back to the campaign title when unlinked.
    const relId = row.clientRelationIds[0];
    const linkedName = relId ? clientNames.get(relId) : undefined;
    const key = linkedName && relId ? relId : clientKey(row.title);
    const name = (linkedName ?? row.title.split("(")[0]).replace(/\s+/g, " ").trim();
    let c = byKey.get(key);
    if (!c) {
      c = {
        id: clientSlug(clientKey(name)),
        name,
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
