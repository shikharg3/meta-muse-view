import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

export interface Credentials {
  appId: string;
  appSecret: string;
  token: string;
  businessId: string;
  accountIds: string[];
  apiVersion: string;
}

export interface CredentialsInput {
  appId: string;
  appSecret: string;
  token: string;
  businessId: string;
  accountIds: string[];
  apiVersion?: string;
}

export async function saveCredentials(input: CredentialsInput): Promise<void> {
  const key = env().APP_ENCRYPTION_KEY;
  const row = {
    id: "singleton",
    appId: input.appId,
    appSecretEnc: input.appSecret ? encryptSecret(input.appSecret, key) : null,
    systemUserTokenEnc: input.token ? encryptSecret(input.token, key) : null,
    businessId: input.businessId,
    accountIds: input.accountIds,
    apiVersion: input.apiVersion ?? "v25.0",
    updatedAt: new Date(),
  };
  await db
    .insert(schema.metaCredentials)
    .values(row)
    .onConflictDoUpdate({ target: schema.metaCredentials.id, set: row });
}

export async function getCredentials(): Promise<Credentials | null> {
  const key = env().APP_ENCRYPTION_KEY;
  const [row] = await db
    .select()
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.id, "singleton"));

  if (row?.systemUserTokenEnc) {
    return {
      appId: row.appId ?? "",
      appSecret: row.appSecretEnc ? decryptSecret(row.appSecretEnc, key) : "",
      token: decryptSecret(row.systemUserTokenEnc, key),
      businessId: row.businessId ?? "",
      accountIds: (row.accountIds as string[] | null) ?? [],
      apiVersion: row.apiVersion ?? "v25.0",
    };
  }

  const e = env();
  if (e.META_SYSTEM_USER_TOKEN) {
    return {
      appId: e.META_APP_ID ?? "",
      appSecret: e.META_APP_SECRET ?? "",
      token: e.META_SYSTEM_USER_TOKEN,
      businessId: e.META_BUSINESS_ID ?? "",
      accountIds: e.META_AD_ACCOUNT_IDS ?? [],
      apiVersion: e.META_API_VERSION,
    };
  }
  return null;
}
