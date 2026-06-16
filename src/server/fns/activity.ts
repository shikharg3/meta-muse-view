import { db, schema } from "@/db/client";
import { desc, eq } from "drizzle-orm";

export interface ActivityEvent {
  id: string;
  accountId: string;
  accountName: string | null;
  eventTime: string | null;
  eventType: string;
  objectName: string | null;
  actorName: string | null;
}

/** Recent ad-account change history (who changed budgets/status/etc.), newest first. */
export async function fetchActivity(limit = 250): Promise<ActivityEvent[]> {
  const rows = await db
    .select({
      id: schema.metaActivities.id,
      accountId: schema.metaActivities.accountId,
      accountName: schema.accounts.name,
      eventTime: schema.metaActivities.eventTime,
      eventType: schema.metaActivities.eventType,
      actorName: schema.metaActivities.actorName,
      raw: schema.metaActivities.raw,
    })
    .from(schema.metaActivities)
    .leftJoin(schema.accounts, eq(schema.metaActivities.accountId, schema.accounts.id))
    .orderBy(desc(schema.metaActivities.eventTime))
    .limit(limit);
  return rows.map((r) => {
    const raw = (r.raw ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      accountId: r.accountId,
      accountName: r.accountName,
      eventTime: r.eventTime ? new Date(r.eventTime).toISOString() : null,
      eventType: String(raw.translated_event_type ?? r.eventType ?? "—"),
      objectName: typeof raw.object_name === "string" ? raw.object_name : null,
      actorName: r.actorName,
    };
  });
}
