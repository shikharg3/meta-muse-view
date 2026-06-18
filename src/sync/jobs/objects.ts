import { db, schema } from "@/db/client";
import type { GraphNode, InsightsClient } from "@/meta/types";

const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Account-level reference edges captured into meta_objects. Each is isolated (skipped on error). */
export const EDGE_SYNCS: { type: string; edge: string; fields: string[] }[] = [
  {
    type: "custom_audience",
    edge: "customaudiences",
    fields: [
      "id",
      "name",
      "subtype",
      "description",
      "approximate_count_lower_bound",
      "approximate_count_upper_bound",
      "operation_status",
      "time_created",
      "time_updated",
      "data_source",
      "retention_days",
      "rule",
    ],
  },
  {
    type: "saved_audience",
    edge: "saved_audiences",
    fields: ["id", "name", "description", "approximate_count", "time_created", "targeting"],
  },
  {
    type: "pixel",
    edge: "adspixels",
    fields: [
      "id",
      "name",
      "last_fired_time",
      "creation_time",
      "is_unavailable",
      "data_use_setting",
    ],
  },
  {
    type: "custom_conversion",
    edge: "customconversions",
    fields: [
      "id",
      "name",
      "custom_event_type",
      "rule",
      "default_conversion_value",
      "creation_time",
      "data_sources",
    ],
  },
  {
    type: "ad_image",
    edge: "adimages",
    fields: ["id", "name", "hash", "url", "width", "height", "status", "created_time"],
  },
  {
    type: "ad_video",
    edge: "advideos",
    fields: ["id", "title", "description", "length", "created_time"],
  },
  { type: "ad_label", edge: "adlabels", fields: ["id", "name"] },
  {
    type: "ad_rule",
    edge: "adrules_library",
    fields: ["id", "name", "status", "evaluation_spec", "execution_spec", "schedule_spec"],
  },
  {
    type: "instagram_account",
    edge: "connected_instagram_accounts",
    fields: ["id", "username", "profile_pic"],
  },
  { type: "conversion_goal", edge: "conversion_goals", fields: ["id", "name"] },
];

/**
 * Pull every reference edge into meta_objects (raw-complete). The edges are fetched in ONE batched
 * request (Graph caps a batch at 50; there are ~11) instead of one GET each, cutting per-account
 * round-trips ~10x. A sub-request that fails (e.g. permission-gated) comes back as null and is
 * skipped; the rare edge with more than one page falls back to a full paged fetch. Returns rows
 * written.
 */
export async function syncEdges(client: InsightsClient, accountId: string): Promise<number> {
  const bodies = await client.batchGet(
    EDGE_SYNCS.map((c) => `${accountId}/${c.edge}?fields=${c.fields.join(",")}&limit=200`),
  );
  let written = 0;
  for (let i = 0; i < EDGE_SYNCS.length; i++) {
    const cfg = EDGE_SYNCS[i];
    const body = bodies[i];
    if (!body) continue; // failed/permission-gated sub-request — skip silently
    let rows = Array.isArray(body.data) ? (body.data as GraphNode[]) : [];
    const paging = body.paging as { next?: unknown } | undefined;
    if (paging?.next) {
      // Overflowed one page (rare for reference edges): fetch the rest paged.
      try {
        rows = await client.getChildren(accountId, cfg.edge, cfg.fields, { limit: 200 });
      } catch (e) {
        console.error(
          `[edges] ${cfg.edge} paging fallback skipped:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    for (const r of rows) {
      const vals = {
        objectType: cfg.type,
        id: String(r.id),
        accountId,
        name: str(r.name) ?? str((r as GraphNode).title) ?? str((r as GraphNode).username),
        raw: r,
        syncedAt: new Date(),
      };
      await db
        .insert(schema.metaObjects)
        .values(vals)
        .onConflictDoUpdate({
          target: [schema.metaObjects.objectType, schema.metaObjects.id],
          set: vals,
        });
      written++;
    }
  }
  return written;
}

const ACTIVITY_FIELDS = [
  "event_type",
  "translated_event_type",
  "extra_data",
  "actor_name",
  "actor_id",
  "event_time",
  "object_id",
  "object_name",
];

/** Pull the account change-history (activities) into meta_activities, deduped by time+type+object. */
export async function syncActivities(
  client: InsightsClient,
  accountId: string,
  opts: { days: number; today?: Date } = { days: 90 },
): Promise<number> {
  const today = opts.today ?? new Date();
  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - opts.days);
  const rows = await client.getChildren(accountId, "activities", ACTIVITY_FIELDS, {
    limit: 500,
    since: since.toISOString().slice(0, 10),
  });
  let written = 0;
  for (const r of rows) {
    const eventTime = r.event_time ? new Date(String(r.event_time)) : null;
    const eventType = str(r.event_type) ?? "unknown";
    const objectId = str(r.object_id);
    const id = `${accountId}|${r.event_time ?? ""}|${eventType}|${objectId ?? ""}`;
    const vals = {
      id,
      accountId,
      eventTime: eventTime && !Number.isNaN(eventTime.getTime()) ? eventTime : null,
      eventType,
      objectId,
      actorName: str(r.actor_name),
      raw: r,
      syncedAt: new Date(),
    };
    await db
      .insert(schema.metaActivities)
      .values(vals)
      .onConflictDoUpdate({ target: schema.metaActivities.id, set: vals });
    written++;
  }
  return written;
}

const LEADFORM_FIELDS = ["id", "name", "status", "leads_count", "locale", "created_time", "page"];

/**
 * Best-effort lead-form metadata capture (form name/status/count — NOT submissions, which are PII
 * and need page-level leads_retrieval). Traverses the account's promotable pages → leadgen_forms,
 * skipping silently where the token lacks page access. Stored in meta_objects as "leadgen_form".
 */
export async function syncLeadForms(client: InsightsClient, accountId: string): Promise<number> {
  let pages: GraphNode[];
  try {
    pages = await client.getChildren(accountId, "promote_pages", ["id", "name"], { limit: 50 });
  } catch {
    return 0; // no page access for this token — nothing capturable
  }
  let written = 0;
  for (const page of pages) {
    try {
      const forms = await client.getChildren(String(page.id), "leadgen_forms", LEADFORM_FIELDS, {
        limit: 100,
      });
      for (const f of forms) {
        const vals = {
          objectType: "leadgen_form",
          id: String(f.id),
          accountId,
          name: str(f.name),
          raw: f,
          syncedAt: new Date(),
        };
        await db
          .insert(schema.metaObjects)
          .values(vals)
          .onConflictDoUpdate({
            target: [schema.metaObjects.objectType, schema.metaObjects.id],
            set: vals,
          });
        written++;
      }
    } catch {
      // page lacks leads access — skip, capture what we can elsewhere
    }
  }
  return written;
}
