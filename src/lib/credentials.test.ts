import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { saveCredentials } from "./credentials";

beforeEach(async () => {
  await db.execute(sql`truncate table meta_credentials, token_health cascade`);
});

test("saveCredentials resets the observed tier so a swapped (possibly dev) app re-paces safely", async () => {
  // A previously-observed standard-tier app.
  await db
    .insert(schema.tokenHealth)
    .values({ id: "singleton", isValid: true, tier: "standard_access" });

  await saveCredentials({
    appId: "123",
    appSecret: "secret",
    token: "tok",
    businessId: "biz",
    accountIds: [],
    apiVersion: "v25.0",
  });

  // Tier is cleared → the next cycle starts on conservative pacing until it re-observes the tier.
  const [row] = await db.select().from(schema.tokenHealth);
  expect(row.tier).toBeNull();
});
