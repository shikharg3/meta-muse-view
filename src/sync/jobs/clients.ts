import { and, eq, isNull, notInArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getNotionCredentials } from "@/lib/credentials";
import { NotionClient } from "@/notion/client";
import {
  parseClientRow,
  clubClients,
  type ParsedClientRow,
  type ClubbedClient,
} from "@/notion/parse";

/**
 * Pull the client ↔ ad-account board from Notion and upsert the clients table.
 * Only Notion-owned columns are written; manual_add_ids / manual_remove_ids are
 * UI state and survive every sync. Returns the number of clients, or null when
 * Notion is not configured.
 */
export async function syncClients(client?: NotionClient): Promise<number | null> {
  const creds = await getNotionCredentials();
  if (!creds) return null;
  const notion = client ?? new NotionClient(creds.token);

  const rows: ParsedClientRow[] = [];
  for (const dsId of await notion.getDataSourceIds(creds.dbId)) {
    for (const page of await notion.queryDataSource(dsId)) {
      const row = parseClientRow(page);
      if (row) rows.push(row);
    }
  }
  return reconcileClients(clubClients(rows));
}

/**
 * Upsert the board snapshot into the clients table and retain churned clients. A client that
 * dropped off the Notion board is marked `removedAt` (and kept) rather than deleted — this DB is
 * the source of truth for all historical clients, so its mapping/budget/history must persist.
 * A re-appearing client is un-marked (`removedAt` reset to null). The removal sweep only runs when
 * we actually got a board snapshot, so a transient empty/failed Notion pull never flags live
 * clients as gone. Returns the number of clients currently on the board.
 */
export async function reconcileClients(clubbed: ClubbedClient[]): Promise<number> {
  for (const c of clubbed) {
    const vals = {
      id: c.id,
      name: c.name,
      status: c.status,
      notionAccountIds: c.accountIds,
      raw: c.pages,
      budget: c.budget,
      startDate: c.startDate,
      endDate: c.endDate,
      syncedAt: new Date(),
      removedAt: null,
    };
    await db
      .insert(schema.clients)
      .values(vals)
      .onConflictDoUpdate({ target: schema.clients.id, set: vals });
  }

  const ids = clubbed.map((c) => c.id);
  if (ids.length) {
    await db
      .update(schema.clients)
      .set({ removedAt: new Date() })
      .where(and(notInArray(schema.clients.id, ids), isNull(schema.clients.removedAt)));
  }

  return clubbed.length;
}

/** Effective account list for one client row: (notion ∪ manualAdd) − manualRemove. */
export function effectiveAccountIds(row: {
  notionAccountIds: unknown;
  manualAddIds: unknown;
  manualRemoveIds: unknown;
}): string[] {
  const notion = (row.notionAccountIds as string[] | null) ?? [];
  const add = (row.manualAddIds as string[] | null) ?? [];
  const remove = new Set((row.manualRemoveIds as string[] | null) ?? []);
  return [...new Set([...notion, ...add])].filter((id) => !remove.has(id));
}

/** Lookup a client row by id or null. */
export async function getClientRow(id: string) {
  const [row] = await db.select().from(schema.clients).where(eq(schema.clients.id, id));
  return row ?? null;
}
