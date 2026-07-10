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
} from "drizzle-orm/pg-core";

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
