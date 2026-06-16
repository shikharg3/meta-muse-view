import { eq, notInArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getNotionCredentials } from "@/lib/credentials";
import { NotionClient } from "@/notion/client";
import { parseClientRow, clubClients, type ParsedClientRow } from "@/notion/parse";

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
  const clubbed = clubClients(rows);

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
    };
    await db
      .insert(schema.clients)
      .values(vals)
      .onConflictDoUpdate({ target: schema.clients.id, set: vals });
  }

  // Drop clients that vanished from the board — unless the UI added accounts
  // to them, in which case the manual state is the only copy and must stay.
  const ids = clubbed.map((c) => c.id);
  await db
    .delete(schema.clients)
    .where(
      ids.length
        ? sql`${notInArray(schema.clients.id, ids)} and coalesce(jsonb_array_length(${schema.clients.manualAddIds}), 0) = 0`
        : sql`coalesce(jsonb_array_length(${schema.clients.manualAddIds}), 0) = 0`,
    );

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
