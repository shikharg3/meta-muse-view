import type { AccountStatus, Kpis } from "@/lib/types";

export interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  reach: number;
}

const div = (a: number, b: number): number => (b > 0 ? a / b : 0);
export const deriveRoas = (revenue: number, spend: number): number => div(revenue, spend);

export function deriveKpis(t: Totals): Kpis {
  return {
    ...t,
    ctr: div(t.clicks, t.impressions) * 100,
    cpc: div(t.spend, t.clicks),
    cpm: div(t.spend, t.impressions) * 1000,
    roas: div(t.revenue, t.spend),
  };
}

/**
 * Percent change vs a previous-period value; null when there is no meaningful
 * baseline (prev <= 0) so the UI can hide the badge instead of showing +Inf.
 */
export function pctDelta(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

/** Window start as YYYY-MM-DD, `days` before `today` (inclusive). */
export function windowStart(days: number, today = new Date()): string {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

// Meta's numeric account_status codes -> our AccountStatus union.
const ACCOUNT_STATUS_CODES: Record<string, AccountStatus> = {
  "1": "ACTIVE",
  "2": "DISABLED",
  "3": "PENDING",
  "7": "PENDING",
  "8": "PENDING",
  "9": "PENDING",
  "100": "DISABLED",
  "101": "DISABLED",
};

/** Normalize a stored account status (Meta numeric code or already-mapped label). */
export function accountStatus(raw: string | null | undefined): AccountStatus {
  if (!raw) return "ACTIVE";
  const up = raw.toUpperCase();
  if (up === "ACTIVE" || up === "PAUSED" || up === "DISABLED" || up === "PENDING") {
    return up as AccountStatus;
  }
  return ACCOUNT_STATUS_CODES[raw] ?? "PENDING";
}

export interface ClientEvent {
  /** De-duplicated, human-readable event name, e.g. "Purchases", "Leads". */
  label: string;
  /** Total count over the window (Meta's unified omni_* value when available). */
  count: number;
  /** Total value/revenue where the event carries one, else 0. */
  value: number;
}

type RawActions = { action_type: string; value: string }[] | null | undefined;

// Meta reports the same conversion under many action_types (omni_*, the bare
// name, offsite_conversion.fb_pixel_*, onsite_web_*, …) with near-identical
// counts. Each family lists members in preference order (Meta's unified omni_*
// first); we take the FIRST present member so each conversion is counted once.
const EVENT_FAMILIES: { label: string; types: string[] }[] = [
  // Trailing members were observed in production but were previously absent here, so a row carrying
  // only one of them counted zero. Order still matters: unified omni_* first, bare name next.
  {
    label: "Purchases",
    types: [
      "omni_purchase",
      "purchase",
      "offsite_conversion.fb_pixel_purchase",
      "onsite_web_purchase",
      "onsite_web_app_purchase",
      "web_in_store_purchase",
      "web_app_in_store_purchase",
      "offsite_purchase_add_20_s_calls",
    ],
  },
  {
    label: "Leads",
    types: [
      "lead",
      "onsite_web_lead",
      "offsite_conversion.fb_pixel_lead",
      "offsite_lead_add_20_s_calls",
    ],
  },
  {
    label: "Registrations",
    types: [
      "omni_complete_registration",
      "complete_registration",
      "offsite_conversion.fb_pixel_complete_registration",
      "offsite_complete_registration_add_meta_leads",
      "offsite_complete_registration_add_20_s_calls",
    ],
  },
  {
    label: "Add to cart",
    types: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"],
  },
  {
    label: "Checkouts initiated",
    types: [
      "omni_initiated_checkout",
      "initiate_checkout",
      "offsite_conversion.fb_pixel_initiate_checkout",
      "onsite_web_initiate_checkout",
      "offsite_initiate_checkout_add_20_s_calls",
    ],
  },
  {
    label: "View content",
    types: [
      "omni_view_content",
      "view_content",
      "offsite_conversion.fb_pixel_view_content",
      "offsite_content_view_add_meta_leads",
      "offsite_content_view_add_20_s_calls",
    ],
  },
  { label: "Add payment info", types: ["omni_add_payment_info", "add_payment_info"] },
  { label: "Subscriptions", types: ["omni_subscribe", "subscribe"] },
  { label: "Trials started", types: ["omni_start_trial", "start_trial"] },
  { label: "Searches", types: ["omni_search", "search"] },
  { label: "Contacts", types: ["contact"] },
  { label: "App installs", types: ["omni_app_install", "mobile_app_install", "app_install"] },
  {
    label: "Messaging conversations",
    types: ["onsite_conversion.messaging_conversation_started_7d"],
  },
  { label: "Landing page views", types: ["omni_landing_page_view", "landing_page_view"] },
  { label: "Link clicks", types: ["link_click"] },
  { label: "Post engagements", types: ["post_engagement"] },
  { label: "Video views", types: ["video_view"] },
];

/**
 * Collapse the raw `actions` / `action_values` JSONB across rows into clean,
 * de-duplicated conversion + engagement events for the chat assistant. Surfaces
 * every event that fired — not just the campaign-objective "result".
 */
export function canonicalEvents(
  rows: { actions: unknown; actionValues: unknown }[],
): ClientEvent[] {
  const count = new Map<string, number>();
  const value = new Map<string, number>();
  const sumInto = (m: Map<string, number>, raw: unknown): void => {
    for (const a of (raw as RawActions) ?? []) {
      m.set(a.action_type, (m.get(a.action_type) ?? 0) + (Number(a.value) || 0));
    }
  };
  for (const r of rows) {
    sumInto(count, r.actions);
    sumInto(value, r.actionValues);
  }
  const out: ClientEvent[] = [];
  for (const fam of EVENT_FAMILIES) {
    const cKey = fam.types.find((t) => count.has(t));
    const vKey = fam.types.find((t) => value.has(t));
    const c = cKey ? (count.get(cKey) ?? 0) : 0;
    const v = vKey ? (value.get(vKey) ?? 0) : 0;
    if (c > 0 || v > 0) out.push({ label: fam.label, count: Math.round(c), value: Math.round(v) });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * Count for one canonical event family from a map of raw action_type -> summed count, using the
 * same first-present-variant de-dup as canonicalEvents. Lets the report engine expose per-event
 * columns (Registrations, Leads, Purchases, …) whose numbers match the chat's event list.
 */
export function familyCount(sums: Map<string, number>, label: string): number {
  const fam = EVENT_FAMILIES.find((f) => f.label === label);
  if (!fam) return 0;
  const key = fam.types.find((t) => sums.has(t));
  return key ? Math.round(sums.get(key) ?? 0) : 0;
}

/**
 * Value for one canonical event family, using the same first-present-variant de-dup as familyCount.
 * Paired with it deliberately: a count and a value read from different variants of the same family
 * would produce an average order value that belongs to neither.
 */
export function familyValue(sums: Map<string, number>, label: string): number {
  const fam = EVENT_FAMILIES.find((f) => f.label === label);
  if (!fam) return 0;
  const key = fam.types.find((t) => sums.has(t));
  return key ? Math.round(sums.get(key) ?? 0) : 0;
}

/**
 * Family labels in declaration order, and label → member action_types.
 *
 * The report catalog is client-safe and cannot import this module, so it restates the labels; a test
 * asserts the two lists agree. EVENT_MEMBERS lets the availability check ask whether any variant of
 * a family actually fired for a client, without duplicating the synonym lists.
 */
export const eventFamilyLabels = (): string[] => EVENT_FAMILIES.map((f) => f.label);

export const EVENT_MEMBERS: Record<string, string[]> = Object.fromEntries(
  EVENT_FAMILIES.map((f) => [f.label, f.types]),
);
