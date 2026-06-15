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
  // Auth (Google OAuth optional; email/password works without it).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Basic-auth test gate: when BOTH are set, the Google/email login is replaced by
  // HTTP Basic Auth (a single shared credential) for testing. Unset both to restore
  // the normal Google/email login — no code change needed.
  BASIC_AUTH_USER: z.string().optional(),
  BASIC_AUTH_PASS: z.string().optional(),
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
