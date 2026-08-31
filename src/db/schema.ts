import {
  pgTable,
  text,
  bigint,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  date,
  boolean,
  primaryKey,
  index,
  serial,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CheckinStatus, PromptState } from "@/lib/checkin";

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status"),
  effectiveStatus: text("effective_status"),
  amountSpent: bigint("amount_spent", { mode: "number" }),
  balance: bigint("balance", { mode: "number" }),
  spendCap: bigint("spend_cap", { mode: "number" }),
  timezoneName: text("timezone_name"),
  disableReason: integer("disable_reason"),
  businessId: text("business_id"),
  businessName: text("business_name"),
  createdTime: timestamp("created_time", { withTimezone: true }),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaigns = pgTable("campaigns", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  status: text("status"),
  effectiveStatus: text("effective_status"),
  objective: text("objective"),
  dailyBudget: bigint("daily_budget", { mode: "number" }),
  lifetimeBudget: bigint("lifetime_budget", { mode: "number" }),
  budgetRemaining: bigint("budget_remaining", { mode: "number" }),
  bidStrategy: text("bid_strategy"),
  buyingType: text("buying_type"),
  startTime: timestamp("start_time", { withTimezone: true }),
  stopTime: timestamp("stop_time", { withTimezone: true }),
  createdTime: timestamp("created_time", { withTimezone: true }),
  updatedTime: timestamp("updated_time", { withTimezone: true }),
  specialAdCategories: jsonb("special_ad_categories"),
  promotedObject: jsonb("promoted_object"),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adSets = pgTable("ad_sets", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  status: text("status"),
  effectiveStatus: text("effective_status"),
  optimizationGoal: text("optimization_goal"),
  billingEvent: text("billing_event"),
  bidAmount: bigint("bid_amount", { mode: "number" }),
  bidStrategy: text("bid_strategy"),
  dailyBudget: bigint("daily_budget", { mode: "number" }),
  lifetimeBudget: bigint("lifetime_budget", { mode: "number" }),
  budgetRemaining: bigint("budget_remaining", { mode: "number" }),
  startTime: timestamp("start_time", { withTimezone: true }),
  endTime: timestamp("end_time", { withTimezone: true }),
  createdTime: timestamp("created_time", { withTimezone: true }),
  updatedTime: timestamp("updated_time", { withTimezone: true }),
  destinationType: text("destination_type"),
  promotedObject: jsonb("promoted_object"),
  targeting: jsonb("targeting"),
  attributionSpec: jsonb("attribution_spec"),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ads = pgTable("ads", {
  id: text("id").primaryKey(),
  adSetId: text("ad_set_id").notNull(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  status: text("status"),
  effectiveStatus: text("effective_status"),
  creativeId: text("creative_id"),
  bidAmount: bigint("bid_amount", { mode: "number" }),
  createdTime: timestamp("created_time", { withTimezone: true }),
  updatedTime: timestamp("updated_time", { withTimezone: true }),
  trackingSpecs: jsonb("tracking_specs"),
  conversionSpecs: jsonb("conversion_specs"),
  previewShareableLink: text("preview_shareable_link"),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adCreatives = pgTable("ad_creatives", {
  id: text("id").primaryKey(),
  name: text("name"),
  thumbnailUrl: text("thumbnail_url"),
  title: text("title"),
  body: text("body"),
  callToActionType: text("call_to_action_type"),
  linkUrl: text("link_url"),
  videoId: text("video_id"),
  imageHash: text("image_hash"),
  imageUrl: text("image_url"),
  objectType: text("object_type"),
  effectiveObjectStoryId: text("effective_object_story_id"),
  instagramPermalinkUrl: text("instagram_permalink_url"),
  objectStorySpec: jsonb("object_story_spec"),
  assetFeedSpec: jsonb("asset_feed_spec"),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insightsDaily = pgTable(
  "insights_daily",
  {
    level: text("level").notNull(),
    entityId: text("entity_id").notNull(),
    date: date("date").notNull(),
    accountId: text("account_id").notNull(),
    spend: doublePrecision("spend").notNull().default(0),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    reach: bigint("reach", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    inlineLinkClicks: bigint("inline_link_clicks", { mode: "number" }).notNull().default(0),
    ctr: doublePrecision("ctr").notNull().default(0),
    cpc: doublePrecision("cpc").notNull().default(0),
    cpm: doublePrecision("cpm").notNull().default(0),
    conversions: doublePrecision("conversions").notNull().default(0),
    conversionValues: doublePrecision("conversion_values").notNull().default(0),
    purchaseRoas: doublePrecision("purchase_roas").notNull().default(0),
    actions: jsonb("actions"),
    actionValues: jsonb("action_values"),
    actionsByWindow: jsonb("actions_by_window"), // conversions split by attribution window (1d/7d/28d view/click)
    actionValuesByWindow: jsonb("action_values_by_window"),
    raw: jsonb("raw"),
    frequency: doublePrecision("frequency"),
    qualityRanking: text("quality_ranking"),
    engagementRateRanking: text("engagement_rate_ranking"),
    conversionRateRanking: text("conversion_rate_ranking"),
    estimatedAdRecallRate: doublePrecision("estimated_ad_recall_rate"),
    uniqueClicks: bigint("unique_clicks", { mode: "number" }),
    uniqueCtr: doublePrecision("unique_ctr"),
    inlinePostEngagement: bigint("inline_post_engagement", { mode: "number" }),
    fullViewImpressions: bigint("full_view_impressions", { mode: "number" }),
    fullViewReach: bigint("full_view_reach", { mode: "number" }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.level, t.entityId, t.date] }),
    index("insights_daily_level_date_idx").on(t.level, t.date),
    index("insights_daily_account_date_idx").on(t.accountId, t.date),
  ],
);

export const insightsBreakdownDaily = pgTable(
  "insights_breakdown_daily",
  {
    level: text("level").notNull(),
    entityId: text("entity_id").notNull(),
    date: date("date").notNull(),
    accountId: text("account_id").notNull(),
    breakdownType: text("breakdown_type").notNull(),
    breakdownValue: text("breakdown_value").notNull(),
    spend: doublePrecision("spend").notNull().default(0),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    conversions: doublePrecision("conversions").notNull().default(0),
    conversionValues: doublePrecision("conversion_values").notNull().default(0),
    reach: bigint("reach", { mode: "number" }).notNull().default(0),
    dims: jsonb("dims"),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.level, t.entityId, t.date, t.breakdownType, t.breakdownValue],
    }),
    index("insights_breakdown_daily_date_idx").on(t.date),
    index("insights_breakdown_daily_account_date_idx").on(t.accountId, t.date),
  ],
);

export const syncState = pgTable("sync_state", {
  accountId: text("account_id").primaryKey(),
  lastStructureSync: timestamp("last_structure_sync", { withTimezone: true }),
  lastInsightsSync: timestamp("last_insights_sync", { withTimezone: true }),
  status: text("status").notNull().default("idle"),
  lastError: text("last_error"),
});

// Resumable backfill progress per (account, dataset, e.g. "insights:ad" / "breakdown:account:country").
// `backfilledThrough` = the oldest date a dataset is complete back to (a job resumes from there);
// `cursor` holds an opaque resume token (e.g. an async report_run_id) when a pull spans runs.
export const syncCheckpoints = pgTable(
  "sync_checkpoints",
  {
    accountId: text("account_id").notNull(),
    dataset: text("dataset").notNull(),
    backfilledThrough: date("backfilled_through"),
    cursor: text("cursor"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.dataset] })],
);

export const tokenHealth = pgTable("token_health", {
  id: text("id").primaryKey().default("singleton"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  isValid: boolean("is_valid").notNull().default(false),
  scopes: jsonb("scopes"),
  note: text("note"),
  tier: text("tier"), // last observed ads_api_access_tier ("standard_access" | "development_access")
});

// Per-service background-sync health (e.g. the Notion client-board sync) so a silent failure surfaces
// in the UI instead of only in server logs. One row per service, upserted on each attempt.
export const serviceHealth = pgTable("service_health", {
  service: text("service").primaryKey(), // e.g. "notion"
  ok: boolean("ok").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  note: text("note"),
});

export const metaCredentials = pgTable("meta_credentials", {
  id: text("id").primaryKey().default("singleton"),
  appId: text("app_id"),
  appSecretEnc: text("app_secret_enc"),
  systemUserTokenEnc: text("system_user_token_enc"),
  businessId: text("business_id"),
  accountIds: jsonb("account_ids"),
  apiVersion: text("api_version").default("v25.0"),
  notionTokenEnc: text("notion_token_enc"),
  notionDbId: text("notion_db_id"),
  anthropicTokenEnc: text("anthropic_token_enc"),
  chatModel: text("chat_model").default("claude-opus-4-8"),
  chatEffort: text("chat_effort").default("xhigh"),
  // Telegram alert delivery. The token is encrypted like every other secret here; the chat id is
  // not a secret (it is visible to anyone in the channel) so it stays readable for the settings UI.
  telegramTokenEnc: text("telegram_token_enc"),
  telegramChatId: text("telegram_chat_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

// Client ↔ ad-account mapping sourced from the Notion Campaigns board, grouped into clients by the
// "Client Account" relation to the linked Clients board, with manual UI overrides that survive re-syncs.
// Effective accounts = (notion ∪ manualAdd) − manualRemove.
export const clients = pgTable("clients", {
  id: text("id").primaryKey(), // slug of the normalized client name
  name: text("name").notNull(),
  status: text("status"),
  notionAccountIds: jsonb("notion_account_ids"), // string[] act_ ids from Notion
  notionActiveAccountIds: jsonb("notion_active_account_ids"), // string[] from Notion's "Active Account ID" column only (a subset of notion_account_ids; "Other ad accounts" excluded)
  manualAddIds: jsonb("manual_add_ids"), // string[] act_ ids added in the UI
  manualRemoveIds: jsonb("manual_remove_ids"), // string[] act_ ids removed in the UI
  raw: jsonb("raw"), // contributing Notion rows (page ids, titles)
  budget: doublePrecision("budget"), // current-engagement total $ (Notion "Budget ($)")
  startDate: date("start_date"), // engagement start (Notion "Actual Start Date")
  endDate: date("end_date"), // estimated end (Notion "End Date (Estimated)")
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  // Set when a client drops off the Notion board; the row + its history are retained (this DB is
  // the source of truth for all historical clients). NULL = currently on the board.
  removedAt: timestamp("removed_at", { withTimezone: true }),
});

// App users for Google / email-password auth. New accounts are "pending" until
// an admin approves; the bootstrap-admin email(s) are auto-approved as admins.
export const users = pgTable("users", {
  id: text("id").primaryKey(), // crypto.randomUUID()
  email: text("email").notNull().unique(), // lowercased
  name: text("name"),
  passwordHash: text("password_hash"), // null for Google-only accounts
  role: text("role").notNull().default("member"), // "admin" | "member"
  status: text("status").notNull().default("pending"), // "pending" | "approved" | "rejected"
  googleSub: text("google_sub"), // Google account id, set on first Google login
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

// Persisted chat history for the in-app assistant, scoped per user. Deleting a user cascades to their
// conversations, and deleting a conversation cascades to its messages.
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(), // crypto.randomUUID()
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("conversations_user_idx").on(t.userId)],
);

// One row per chat turn message. `payload` carries structured assistant output (e.g. cards) and
// `costUsd` the per-message LLM cost; both are null for user messages.
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(), // crypto.randomUUID()
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // "user" | "assistant"
    content: text("content").notNull(),
    payload: jsonb("payload"),
    costUsd: doublePrecision("cost_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("chat_messages_conversation_idx").on(t.conversationId)],
);

// Admin action trail (approvals, role changes, mapping edits, resets, credential saves).
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(), // e.g. "user.approve", "client.account.add", "sync.reset"
  detail: text("detail").notNull(), // human-readable summary
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Detected anomalies surfaced in-app (and, when configured, pushed to Telegram).
export const alerts = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(), // dedupe key, e.g. `spend_drop:<accountId>:<date>`
    type: text("type").notNull(), // "spend_drop"
    accountId: text("account_id").notNull(),
    accountName: text("account_name"),
    message: text("message").notNull(),
    metric: doublePrecision("metric"), // drop fraction 0..1
    severity: text("severity").notNull().default("warning"), // "warning" | "critical"
    status: text("status").notNull().default("open"), // "open" | "acknowledged"
    date: date("date").notNull(), // the day evaluated
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alerts_status_created_idx").on(t.status, t.createdAt)],
);

// Per request-key (edge / node type / insights shape) set of fields Meta rejected (#100 nonexisting
// or #10 permission). Persisted so the costly bisection discovery runs once, not every process.
export const metaFieldBlocklist = pgTable("meta_field_blocklist", {
  memoKey: text("memo_key").primaryKey(),
  fields: jsonb("fields").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Generic store for account-level reference objects (custom/saved audiences, pixels, custom
// conversions, image/video/label libraries, automated rules, IG accounts, conversion goals).
// Everything is captured in `raw`; object_type discriminates. New edges need no new table.
export const metaObjects = pgTable(
  "meta_objects",
  {
    objectType: text("object_type").notNull(),
    id: text("id").notNull(),
    accountId: text("account_id").notNull(),
    name: text("name"),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.objectType, t.id] }),
    index("meta_objects_account_idx").on(t.accountId, t.objectType),
  ],
);

// Ad-account change history (who changed budgets/status/etc. and when). Activities have no stable
// id, so we synthesize one from time+type+object to dedupe re-pulls of the same event.
export const metaActivities = pgTable(
  "meta_activities",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }),
    eventType: text("event_type"),
    objectId: text("object_id"),
    actorName: text("actor_name"),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("meta_activities_account_time_idx").on(t.accountId, t.eventTime)],
);

// Notable Meta API events (rate-limit throttles + hard failures) surfaced to admins. Append-only,
// pruned by age; id is a uuid so concurrent inserts never collide.
export const syncEvents = pgTable(
  "sync_events",
  {
    id: text("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(), // "rate_limit" | "error"
    code: integer("code").notNull(), // Meta error code (0 = proactive backoff / unknown)
    accountId: text("account_id"),
    message: text("message").notNull(),
    retryAfterMin: integer("retry_after_min"), // estimated minutes until the throttle lifts
    pressure: integer("pressure"), // peak BUC utilization 0-100 at the time
  },
  (t) => [index("sync_events_at_idx").on(t.at)],
);

/**
 * Manual campaign -> client assignment, overriding both account mapping and name attribution.
 * Deliberately NOT foreign-keyed: the Notion sync re-keys client ids (an account moving between
 * engagements), and a cascade would silently erase the operator's correction. A row pointing at a
 * client that no longer exists is simply ignored.
 */
export const campaignClientOverrides = pgTable("campaign_client_overrides", {
  campaignId: text("campaign_id").primaryKey(),
  clientId: text("client_id").notNull(),
  setBy: text("set_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Admin-forced `Account Status` for one Notion board row, overriding the derived value.
 *
 * Deliberately NOT foreign-keyed, for the same reason as `campaignClientOverrides`: a cascade would
 * silently erase an operator's correction, and a row pointing at a page that no longer exists is
 * simply ignored. Keyed by page id rather than client id because the Notion sync re-keys client ids.
 *
 * `status` must be one of `MACHINE_STATUSES` (`src/lib/delivery-status.ts`). Pinning a human-owned
 * value is just editing Notion, and permitting it here would break the disjoint-set invariant the
 * whole feature rests on. The check lives in the server fn, not the column type.
 */
export const notionStatusOverrides = pgTable("notion_status_overrides", {
  pageId: text("page_id").primaryKey(),
  status: text("status").notNull(),
  setBy: text("set_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure registry (Track N).
//
// OPERATOR-OWNED: no sync job writes any `infra_` table. That is the invariant the whole feature
// rests on — it is why an operator's entry can never be silently overwritten — and it is forced by
// the permission ceiling: the system-user token lacks `business_management`, so every BM-level Graph
// edge (owned_ad_accounts, owned_pages, BM-level adspixels, owned_domains, business_users) returns a
// permission error. See docs/superpowers/specs/2026-08-13-infrastructure-monitor-design.md.
//
// These are the only tables here with real foreign keys besides the chat pair, and the reason the
// rest avoid them does not apply: external syncs re-key ids and a cascade would erase an operator's
// correction, but nothing external touches these rows — we own their lifetimes end to end.
// ─────────────────────────────────────────────────────────────────────────────

export const infraProfiles = pgTable("infra_profiles", {
  id: text("id").primaryKey(), // crypto.randomUUID() at the insert site
  name: text("name").notNull(),
  // A SET, not one value: Meta can strip several capabilities at once, and "active but read only" is
  // a real state. Guarded through `parseProfileStatuses` in the server fn.
  statuses: text("statuses").array().notNull().default(["active"]),
  geo: text("geo"),
  browser: text("browser"), // antidetect tool in use. Non-secret.
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraBusinessManagers = pgTable("infra_business_managers", {
  id: text("id").primaryKey(),
  // Unique: two rows for one Meta BM would silently split its access graph in half.
  bmId: text("bm_id").notNull().unique(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"), // BmStatus
  type: text("type").notNull().default("non_verified"), // BmType — what the BM is for, not its health
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Operator-owned facts about a registered ad account. Deliberately has NO status column: live status,
 * disable_reason, spend cap and balance are LEFT JOINed from `accounts`, which syncs them hourly. A
 * hand-typed status would contradict the live value on the same screen and be stale within a day.
 *
 * No foreign key to `accounts.id` on purpose — a registry row may exist before the account appears in
 * sync, or outlive its departure from the book. An unmatched row renders a "not in sync" badge.
 */
export const infraAdAccounts = pgTable("infra_ad_accounts", {
  id: text("id").primaryKey(), // act_<digits>, format-checked in the server fn
  label: text("label"), // optional operator alias; the real name comes from `accounts`
  usageState: text("usage_state").notNull().default("in_use"), // AdAccountUsage
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraPixels = pgTable("infra_pixels", {
  id: text("id").primaryKey(), // the Meta pixel id
  name: text("name").notNull(),
  // RESTRICT, not CASCADE: a pixel without a root BM is meaningless, so the delete is refused rather
  // than the pixel silently vanishing. This is also what removes the "missing root BM" case entirely.
  rootBmId: text("root_bm_id")
    .notNull()
    .references(() => infraBusinessManagers.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("active"), // PixelStatus
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraPages = pgTable("infra_pages", {
  id: text("id").primaryKey(), // randomUUID — the Meta page id is optional so it cannot be the key
  pageId: text("page_id"),
  pageUrl: text("page_url").notNull(),
  name: text("name").notNull(),
  ownerProfileId: text("owner_profile_id")
    .notNull()
    .references(() => infraProfiles.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("active"), // PageStatus
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Link tables. Membership cascades: removing a profile removes its BM memberships, never the BM.

export const infraProfileBm = pgTable(
  "infra_profile_bm",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => infraProfiles.id, { onDelete: "cascade" }),
    bmId: text("bm_id")
      .notNull()
      .references(() => infraBusinessManagers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.bmId] })],
);

export const infraBmAdAccount = pgTable(
  "infra_bm_ad_account",
  {
    bmId: text("bm_id")
      .notNull()
      .references(() => infraBusinessManagers.id, { onDelete: "cascade" }),
    adAccountId: text("ad_account_id")
      .notNull()
      .references(() => infraAdAccounts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bmId, t.adAccountId] })],
);

/** Pixel shares only. The root BM lives on `infra_pixels.root_bm_id` and is never also a share. */
export const infraPixelBm = pgTable(
  "infra_pixel_bm",
  {
    pixelId: text("pixel_id")
      .notNull()
      .references(() => infraPixels.id, { onDelete: "cascade" }),
    bmId: text("bm_id")
      .notNull()
      .references(() => infraBusinessManagers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pixelId, t.bmId] })],
);

export const infraPageBm = pgTable(
  "infra_page_bm",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => infraPages.id, { onDelete: "cascade" }),
    bmId: text("bm_id")
      .notNull()
      .references(() => infraBusinessManagers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.bmId] })],
);

/** Additional page access. The owner lives on `infra_pages.owner_profile_id`, never also here. */
export const infraPageProfile = pgTable(
  "infra_page_profile",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => infraPages.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => infraProfiles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.profileId] })],
);

/**
 * Status and verification history. Records old -> new AND the acting user, which is what makes "how
 * long has this been banned" and "how many suspensions this quarter" answerable at all.
 *
 * `entity_id` is plain text with NO foreign key, deliberately: the history of a deleted asset is
 * exactly when you most want to read it.
 */
export const infraStatusEvents = pgTable(
  "infra_status_events",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // InfraKind
    entityId: text("entity_id").notNull(),
    event: text("event").notNull(), // "status_change" | "verify"
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    reason: text("reason"),
    actorEmail: text("actor_email").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("infra_status_events_entity_idx").on(t.kind, t.entityId, t.at)],
);

// Telegram chats the bot has seen, so an admin can bind one to a media buyer in Settings. Discovery
// only: being here grants nothing. Chat ids are text — Telegram ids exceed 32-bit.
export const telegramChats = pgTable("telegram_chats", {
  chatId: text("chat_id").primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// Membership here is what makes someone a media buyer: the daily check-in prompts exactly these
// people, matched against the Notion `Owners` people property by PERSON ID (display names drift).
// A third buyer is therefore a Settings action, not a deploy.
export const mediaBuyers = pgTable(
  "media_buyers",
  {
    notionPersonId: text("notion_person_id").primaryKey(),
    displayName: text("display_name").notNull(),
    telegramChatId: text("telegram_chat_id"), // null = unroutable; prompts are still recorded
    active: boolean("active").notNull().default(true),
    boundBy: text("bound_by"),
    boundAt: timestamp("bound_at", { withTimezone: true }),
  },
  (t) => [
    // One chat belongs to at most one buyer. Without this an admin can bind the same discovered
    // chat to two buyers, and that chat then gets two daily lists and two force-reply threads;
    // binding should fail loudly in Settings instead. Partial: null means unbound, not a duplicate.
    uniqueIndex("media_buyers_chat_idx")
      .on(t.telegramChatId)
      .where(sql`${t.telegramChatId} is not null`),
  ],
);

// One row per (local date, board page, buyer). The unique index is what makes the 17:00 job
// idempotent: a worker restart inside the same minute cannot double-prompt.
export const checkinPrompts = pgTable(
  "checkin_prompts",
  {
    id: serial("id").primaryKey(),
    promptDate: date("prompt_date").notNull(),
    notionPageId: text("notion_page_id").notNull(),
    campaignTitle: text("campaign_title").notNull(),
    status: text("status").$type<CheckinStatus>().notNull(), // CheckinStatus; snapshotted at prompt time
    buyerPersonId: text("buyer_person_id").notNull(),
    chatId: text("chat_id"),
    question: text("question").notNull(), // snapshotted, so re-wording never rewrites history
    listMessageId: text("list_message_id"), // the buyer's daily list, for re-rendering
    replyMessageId: text("reply_message_id"), // the force_reply message an answer replies to
    state: text("state").$type<PromptState>().notNull().default("pending"), // PromptState
    answerText: text("answer_text"), // stored BEFORE the Notion write, so an answer is never lost
    notionCommentId: text("notion_comment_id"), // null while state=answered means a retry is owed
    note: text("note"), // last error (send failure, comment failure)
    commentAttempts: integer("comment_attempts").notNull().default(0), // stops an unwritable comment retrying forever
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("checkin_prompts_day_page_buyer_idx").on(
      t.promptDate,
      t.notionPageId,
      t.buyerPersonId,
    ),
    index("checkin_prompts_reply_idx").on(t.chatId, t.replyMessageId),
    index("checkin_prompts_state_idx").on(t.state),
  ],
);

// Makes all three time gates idempotent. Without it the 13:30 gate would re-plan every poll iteration
// on a day with zero in-scope rows, because "no prompts exist" is indistinguishable from "not planned".
//
// One claim column per notification that must not repeat: `reminded_at` for 17:30, `escalated_at` for
// the next day's final notice. Both are claimed by conditional update BEFORE the send, so a crash
// after claiming loses one nudge and a crash before it re-runs cleanly — the right way round for an
// at-most-once notification.
export const checkinRuns = pgTable("checkin_runs", {
  runDate: date("run_date").primaryKey(),
  plannedAt: timestamp("planned_at", { withTimezone: true }),
  promptsCreated: integer("prompts_created").notNull().default(0),
  remindedAt: timestamp("reminded_at", { withTimezone: true }),
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),
});

// The getUpdates cursor. `sync_state` is keyed per ad account and cannot hold this.
export const telegramState = pgTable("telegram_state", {
  id: text("id").primaryKey().default("singleton"),
  updateOffset: bigint("update_offset", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Saved report recipes. `client_id` NULL = a generic shape whose client is chosen at run time;
// set = a one-click client-bound template. One nullable FK delivers both without override rules.
export const reportTemplates = pgTable(
  "report_templates",
  {
    id: text("id").primaryKey(), // crypto.randomUUID()
    name: text("name").notNull(),
    clientId: text("client_id").references(() => clients.id, { onDelete: "cascade" }),
    columns: jsonb("columns").notNull(), // string[] catalog keys, IN USER ORDER
    breakdown: text("breakdown").notNull().default("none"),
    // Meta's `time_increment` verbatim: "all_days" | "1" | "7" | "28" | "monthly".
    timeIncrement: text("time_increment").notNull().default("all_days"),
    markup: doublePrecision("markup"),
    rangePreset: text("range_preset"), // a DATE_PRESETS key; null = ask at run time
    campaignIds: jsonb("campaign_ids"), // only legal when clientId is set
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("report_templates_client_idx").on(t.clientId)],
);

// One row per generated report. `exported_at` NULL = draft; the first export freezes the payload as
// the snapshot of what the client actually received. RESTRICT on client_id because clients are
// soft-deleted via removed_at and history must outlive a client leaving the Notion board.
export const reportRuns = pgTable(
  "report_runs",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id").references(() => reportTemplates.id, { onDelete: "set null" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    params: jsonb("params").notNull(), // the exact ClientReportInput used
    payload: jsonb("payload").notNull(), // the frozen ReportPayload
    since: date("since").notNull(),
    until: date("until").notNull(),
    rowCount: integer("row_count").notNull(),
    ranBy: text("ran_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    exportedFormats: jsonb("exported_formats"), // string[]: "csv" | "pdf"
  },
  (t) => [
    index("report_runs_exported_idx").on(t.exportedAt, t.createdAt),
    index("report_runs_client_idx").on(t.clientId, t.exportedAt),
  ],
);
