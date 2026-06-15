import {
  pgTable,
  text,
  bigint,
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
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adCreatives = pgTable("ad_creatives", {
  id: text("id").primaryKey(),
  name: text("name"),
  thumbnailUrl: text("thumbnail_url"),
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

export const tokenHealth = pgTable("token_health", {
  id: text("id").primaryKey().default("singleton"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  isValid: boolean("is_valid").notNull().default(false),
  scopes: jsonb("scopes"),
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

// Client ↔ ad-account mapping sourced from the Notion "Meta Campaigns" board,
// with manual UI overrides that survive re-syncs.
// Effective accounts = (notion ∪ manualAdd) − manualRemove.
export const clients = pgTable("clients", {
  id: text("id").primaryKey(), // slug of the normalized client name
  name: text("name").notNull(),
  status: text("status"),
  notionAccountIds: jsonb("notion_account_ids"), // string[] act_ ids from Notion
  manualAddIds: jsonb("manual_add_ids"), // string[] act_ ids added in the UI
  manualRemoveIds: jsonb("manual_remove_ids"), // string[] act_ ids removed in the UI
  raw: jsonb("raw"), // contributing Notion rows (page ids, titles)
  syncedAt: timestamp("synced_at", { withTimezone: true }),
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

// Admin action trail (approvals, role changes, mapping edits, resets, credential saves).
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(), // e.g. "user.approve", "client.account.add", "sync.reset"
  detail: text("detail").notNull(), // human-readable summary
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
