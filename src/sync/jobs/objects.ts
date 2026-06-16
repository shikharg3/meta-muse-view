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

/** Pull each reference edge into meta_objects (raw-complete). Returns rows written. */
export async function syncEdges(client: InsightsClient, accountId: string): Promise<number> {
  let written = 0;
  for (const cfg of EDGE_SYNCS) {
    try {
      const rows = await client.getChildren(accountId, cfg.edge, cfg.fields, { limit: 200 });
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
    } catch (e) {
      console.error(`[edges] ${cfg.edge} skipped:`, e instanceof Error ? e.message : e);
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
