import { db, schema } from "@/db/client";

export interface LibraryItem {
  id: string;
  name: string | null;
  accountId: string;
  detail: string | null;
}
export interface LibraryGroup {
  type: string;
  label: string;
  count: number;
  items: LibraryItem[];
}

const TYPE_LABELS: Record<string, string> = {
  custom_audience: "Custom Audiences",
  saved_audience: "Saved Audiences",
  pixel: "Pixels",
  custom_conversion: "Custom Conversions",
  ad_image: "Image Library",
  ad_video: "Video Library",
  ad_label: "Labels",
  ad_rule: "Automated Rules",
  instagram_account: "Instagram Accounts",
  conversion_goal: "Conversion Goals",
};

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A short, type-appropriate descriptor pulled from the captured raw object. */
function detailFor(type: string, raw: Record<string, unknown>): string | null {
  switch (type) {
    case "custom_audience":
    case "saved_audience": {
      const size = num(raw.approximate_count_lower_bound) ?? num(raw.approximate_count);
      const parts = [
        size != null ? `~${size.toLocaleString()} people` : null,
        typeof raw.subtype === "string" ? raw.subtype : null,
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : null;
    }
    case "pixel":
      return raw.last_fired_time
        ? `last fired ${String(raw.last_fired_time).slice(0, 10)}`
        : "no recent fires";
    case "custom_conversion":
      return typeof raw.custom_event_type === "string" ? raw.custom_event_type : null;
    case "ad_rule":
      return typeof raw.status === "string" ? raw.status : null;
    default:
      return null;
  }
}

const MAX_PER_TYPE = 200;

/** Reference objects captured into meta_objects, grouped by type for the Library page. */
export async function fetchLibrary(): Promise<LibraryGroup[]> {
  const rows = await db
    .select()
    .from(schema.metaObjects)
    .orderBy(schema.metaObjects.objectType, schema.metaObjects.name);
  const items = new Map<string, LibraryItem[]>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.objectType, (counts.get(r.objectType) ?? 0) + 1);
    const arr = items.get(r.objectType) ?? [];
    if (arr.length < MAX_PER_TYPE)
      arr.push({
        id: r.id,
        name: r.name,
        accountId: r.accountId,
        detail: detailFor(r.objectType, (r.raw ?? {}) as Record<string, unknown>),
      });
    items.set(r.objectType, arr);
  }
  return [...items.entries()]
    .map(([type, list]) => ({
      type,
      label: TYPE_LABELS[type] ?? type,
      count: counts.get(type) ?? list.length,
      items: list,
    }))
    .sort((a, b) => b.count - a.count);
}
