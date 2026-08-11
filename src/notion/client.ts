// Minimal Notion API client (no SDK; one endpoint family, fetch is enough).
// Uses API version 2025-09-03: the client board is a multi-source database,
// which older versions reject outright.
const BASE = "https://api.notion.com/v1";
const VERSION = "2025-09-03";

export interface NotionPage {
  id: string;
  properties: Record<string, NotionProp>;
}

export interface NotionProp {
  type: string;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  status?: { name: string } | null;
  [k: string]: unknown;
}

/** One column's schema entry: its stable id (rename-proof) and value type. */
export interface NotionPropSchema {
  id: string;
  type: string;
}

export class NotionClient {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async req(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": VERSION,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `Notion ${res.status}: ${(body as { message?: string }).message ?? "request failed"}`,
      );
    }
    return body;
  }

  /** Data source ids of a database (multi-source boards have several). */
  async getDataSourceIds(databaseId: string): Promise<string[]> {
    const db = await this.req(`/databases/${databaseId}`);
    return ((db.data_sources as { id: string }[] | undefined) ?? []).map((d) => d.id);
  }

  /**
   * The data source a relation property points at, read from the property's schema. Lets the
   * campaign sync discover the linked Clients board without any extra configuration.
   */
  async getRelationTargetDataSource(
    dataSourceId: string,
    propName: string,
  ): Promise<string | undefined> {
    const ds = await this.req(`/data_sources/${dataSourceId}`);
    const props = ds.properties as
      | Record<string, { type?: string; relation?: { data_source_id?: string } }>
      | undefined;
    const rel = props?.[propName];
    return rel?.type === "relation" ? rel.relation?.data_source_id : undefined;
  }

  /** All pages of a data source, following cursor pagination. */
  async queryDataSource(dataSourceId: string): Promise<NotionPage[]> {
    const out: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const body = await this.req(`/data_sources/${dataSourceId}/query`, {
        method: "POST",
        body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      out.push(...((body.results as NotionPage[] | undefined) ?? []));
      cursor = body.has_more ? (body.next_cursor as string) : undefined;
    } while (cursor);
    return out;
  }

  /** Column schema of a data source, keyed by its EXACT Notion column name. */
  async getProperties(dataSourceId: string): Promise<Record<string, NotionPropSchema>> {
    const ds = await this.req(`/data_sources/${dataSourceId}`);
    const props = (ds.properties ?? {}) as Record<string, { id?: unknown; type?: unknown }>;
    const out: Record<string, NotionPropSchema> = {};
    for (const [name, def] of Object.entries(props)) {
      out[name] = { id: String(def.id ?? ""), type: String(def.type ?? "") };
    }
    return out;
  }

  /** Rename a column. Notion references properties by id inside formulas/rollups/views, so this only
   *  changes the label — board logic is untouched. */
  async renameProperty(dataSourceId: string, currentName: string, newName: string): Promise<void> {
    await this.req(`/data_sources/${dataSourceId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { [currentName]: { name: newName } } }),
    });
  }

  /**
   * Create a column and return its schema entry. `fallback` is tried when the primary config is
   * rejected — Notion refuses an unknown number `format` on some workspaces.
   */
  async createProperty(
    dataSourceId: string,
    name: string,
    config: Record<string, unknown>,
    fallback?: Record<string, unknown>,
  ): Promise<NotionPropSchema | null> {
    const patch = async (c: Record<string, unknown>): Promise<Record<string, unknown>> =>
      this.req(`/data_sources/${dataSourceId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: { [name]: c } }),
      });
    let body: Record<string, unknown>;
    try {
      body = await patch(config);
    } catch (e) {
      if (!fallback) throw e;
      body = await patch(fallback);
    }
    const props = (body.properties ?? {}) as Record<string, { id?: unknown; type?: unknown }>;
    const def = props[name];
    return def ? { id: String(def.id ?? ""), type: String(def.type ?? "") } : null;
  }

  /**
   * Append missing options to an existing `status` property, returning the names actually added.
   *
   * Writable from API version 2025-09-03 onward, which this client pins. Only names are sent:
   * `group` is omitted so existing options keep their current group and new ones inherit the
   * default, and colours are not settable this way. Existing options are always resent unchanged —
   * the array replaces the property's option list, so dropping one would delete it from the board,
   * along with every row's value in it. Hence: if the read does not show the current options, this
   * throws rather than PATCHing. A response we cannot interpret is not a licence to replace the list.
   */
  async addStatusOptions(
    dataSourceId: string,
    propName: string,
    names: string[],
  ): Promise<string[]> {
    const seen = new Set<string>();
    for (const n of names) {
      if (n.includes(",")) throw new Error(`Notion status option "${n}" cannot contain a comma`);
      // Notion names are unique case-insensitively, so a case-equal pair would 400 the whole PATCH.
      if (seen.has(n.toLowerCase())) throw new Error(`duplicate status option requested: "${n}"`);
      seen.add(n.toLowerCase());
    }
    const res = await this.req(`/data_sources/${dataSourceId}`);
    const props = (res.properties ?? {}) as Record<string, Record<string, unknown>>;
    const prop = props[propName];
    if (!prop) throw new Error(`No "${propName}" property on data source ${dataSourceId}`);
    if (prop.type !== "status") {
      throw new Error(`"${propName}" is a ${String(prop.type)} property, not a status property`);
    }
    const listed = (prop.status as { options?: unknown } | undefined)?.options;
    if (!Array.isArray(listed)) {
      throw new Error(
        `"${propName}" returned no status.options array; refusing to PATCH, which would replace the board's option list`,
      );
    }
    const current = listed as { name: string }[];
    const have = new Set(current.map((o) => o.name.toLowerCase()));
    const missing = names.filter((n) => !have.has(n.toLowerCase()));
    if (missing.length === 0) return [];
    await this.req(`/data_sources/${dataSourceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          [propName]: {
            status: {
              options: [
                ...current.map((o) => ({ name: o.name })),
                ...missing.map((name) => ({ name })),
              ],
            },
          },
        },
      }),
    });
    return missing;
  }

  /**
   * Write one cell. Addressed by property ID, not name, so renaming the column (or someone else
   * adding a similarly-named one) can never redirect the write. `value` is the Notion property value
   * object, e.g. `{ number: 12 }` or `{ date: { start: "2026-08-20" } }`.
   */
  async setPageValue(
    pageId: string,
    propertyId: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    await this.req(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { [propertyId]: value } }),
    });
  }
}

/** Extract a Notion database id (32 hex chars, optionally dashed) from a URL or raw id. */
export function parseNotionDbId(input: string): string | null {
  const m = input.replace(/-/g, "").match(/[0-9a-f]{32}/i);
  if (!m) return null;
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
