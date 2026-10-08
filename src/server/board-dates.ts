import { getNotionCredentials } from "@/lib/credentials";
import { isYmd } from "@/lib/range";
import { NotionClient } from "@/notion/client";
import { parseCampaignRow } from "@/notion/parse";

/** One board row's engagement window and contract, as the Campaigns board states them. */
export interface RowDates {
  /** `Actual Start Date`, else `Ideal Start Date` — YYYY-MM-DD, or null when neither is set. */
  startDate: string | null;
  /** `End Date (Estimated)`: what was PLANNED. Shown for context; never used to cut spend off. */
  endDate: string | null;
  /** `Budget ($)`, the contracted figure. */
  budget: number | null;
}

export interface BoardDates {
  byPage: ReadonlyMap<string, RowDates>;
  /** When the board was read; null when it never has been. */
  asOf: string | null;
  /** Why there are no dates at all. A stale snapshot is served without one — see `read`. */
  error: string | null;
}

/**
 * Every board row's own start date, planned end and budget, read live off Notion.
 *
 * Why not `clients.raw`: the sync clubs a client's rows and keeps only the LATEST row's dates, on the
 * client — each page in `raw` carries its accounts but no window. Splitting a reused ad account
 * between a brand's monthly engagements needs every row's start, and the only writer of `raw` is the
 * live sync worker, which this API does not deploy. The board is ~100 rows in two pages of results
 * (≈1.3s), so one read serves every client for ten minutes.
 */
const TTL_MS = 10 * 60_000;
/** After a failed read, how long the last good snapshot is served before Notion is asked again. */
const RETRY_MS = 60_000;

let snapshot: { readAt: number; servedUntil: number; byPage: Map<string, RowDates> } | null = null;
let pending: Promise<BoardDates> | null = null;

const ymd = (value: string | null): string | null => {
  const day = value?.slice(0, 10) ?? null;
  return day && isYmd(day) ? day : null;
};

async function read(): Promise<BoardDates> {
  try {
    const creds = await getNotionCredentials();
    if (!creds) {
      return { byPage: new Map(), asOf: null, error: "Notion is not configured." };
    }
    const notion = new NotionClient(creds.token);
    const byPage = new Map<string, RowDates>();
    for (const dataSource of await notion.getDataSourceIds(creds.dbId)) {
      for (const page of await notion.queryDataSource(dataSource)) {
        const row = parseCampaignRow(page);
        // A date cell can carry a time ("2026-09-24T10:00:00+02:00"); a window is whole days.
        if (row)
          byPage.set(row.pageId, {
            startDate: ymd(row.startDate),
            endDate: ymd(row.endDate),
            budget: row.budget,
          });
      }
    }
    const now = Date.now();
    snapshot = { readAt: now, servedUntil: now + TTL_MS, byPage };
    return { byPage, asOf: new Date(now).toISOString(), error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[board-dates] Notion read failed:", message);
    // Engagement dates change once a month and a Notion outage lasts minutes, so the last good read
    // is the better answer — `asOf` says how old it is. Without one there is nothing to split by.
    if (snapshot) {
      snapshot.servedUntil = Date.now() + RETRY_MS;
      return {
        byPage: snapshot.byPage,
        asOf: new Date(snapshot.readAt).toISOString(),
        error: null,
      };
    }
    return { byPage: new Map(), asOf: null, error: `Notion did not answer: ${message}` };
  }
}

/** The cached board dates, read once per ten minutes however many requests ask at once. */
export async function boardDates(): Promise<BoardDates> {
  if (snapshot && Date.now() < snapshot.servedUntil) {
    return {
      byPage: snapshot.byPage,
      asOf: new Date(snapshot.readAt).toISOString(),
      error: null,
    };
  }
  pending ??= read().finally(() => {
    pending = null;
  });
  return pending;
}
