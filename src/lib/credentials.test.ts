import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { saveCredentials, getCredentials } from "./credentials";

beforeEach(async () => {
  await db.execute(sql`truncate table meta_credentials cascade`);
});

test("saveCredentials encrypts and getCredentials decrypts (DB takes precedence)", async () => {
  await saveCredentials({
    appId: "111", appSecret: "the-secret", token: "the-token",
    businessId: "999", accountIds: ["act_1", "act_2"], apiVersion: "v25.0",
  });
  const [row] = await db.select().from(schema.metaCredentials);
  expect(row.appSecretEnc).not.toContain("the-secret"); // stored encrypted

  const creds = await getCredentials();
  expect(creds?.appSecret).toBe("the-secret");
  expect(creds?.token).toBe("the-token");
  expect(creds?.accountIds).toEqual(["act_1", "act_2"]);
});
test("getCredentials returns null when neither DB nor env provide a token", async () => {
  // env in this test run has blank META_* (see .env), so no fallback token
  expect(await getCredentials()).toBeNull();
});
