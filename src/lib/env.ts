import { z } from "zod";

const schema = z.object({
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_SYSTEM_USER_TOKEN: z.string().optional(),
  META_BUSINESS_ID: z.string().optional(),
  META_API_VERSION: z.string().default("v25.0"),
  META_AD_ACCOUNT_IDS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  APP_ENCRYPTION_KEY: z.string().length(64, "APP_ENCRYPTION_KEY must be 64 hex chars (32 bytes)"),
  DATABASE_URL: z.string().min(1),
  // Basic-auth test gate: when BOTH are set, HTTP Basic Auth (a single shared credential) replaces
  // the email/password login for testing. Unset both to use the normal login — no code change.
  BASIC_AUTH_USER: z.string().optional(),
  BASIC_AUTH_PASS: z.string().optional(),
  // Telegram alert delivery (optional): bot token + target chat/channel id.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALERT_CHAT_ID: z.string().optional(),
  // Daily performance report target; unset = the alert chat above.
  TELEGRAM_REPORT_CHAT_ID: z.string().optional(),
  // Emails auto-approved as admins on first sign-up/login (comma-separated, lowercased).
  AUTH_BOOTSTRAP_ADMINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  // Emails auto-promoted to SUPERADMIN (a superset of admin) on sign-up/login (comma-separated).
  AUTH_SUPERADMINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  // The Base44 creative mirror, asked after each sync to copy newly visible creatives into Base44's
  // own storage (`src/sync/jobs/creative-mirror.ts`). Both or neither: unset skips the step. The key
  // is shared with the `creatives` function's CREATIVE_MIRROR_KEY secret and gates only that call.
  CREATIVE_MIRROR_URL: z.string().url().optional(),
  CREATIVE_MIRROR_KEY: z
    .string()
    .min(32, "CREATIVE_MIRROR_KEY must be at least 32 chars")
    .optional(),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source);
}

let cached: Env | undefined;
export function env(): Env {
  if (!cached) cached = parseEnv();
  return cached;
}
