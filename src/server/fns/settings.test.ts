import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { fetchSettings, saveCredentialsFormData } from "./settings";

beforeEach(async () => {
  await db.execute(sql`truncate table meta_credentials, token_health, sync_state cascade`);
});

test("getSettings masks secrets and reports presence", async () => {
  await saveCredentialsFormData({
    appId: "111",
    appSecret: "SECRETval",
    token: "TOKENval",
    businessId: "999",
    accountIds: "act_1, act_2",
  });
  const s = await fetchSettings();
  expect(s.appId).toBe("111");
  expect(s.businessId).toBe("999");
  expect(s.accountIds).toEqual(["act_1", "act_2"]);
  expect(s.hasSecret).toBe(true);
  expect(s.hasToken).toBe(true);
  // never leaks plaintext secrets (sentinels chosen so they can't collide with the
  // always-present lowercase "token" JSON key — the plan's "tok"/"shh" had that collision)
  expect(JSON.stringify(s)).not.toContain("SECRETval");
  expect(JSON.stringify(s)).not.toContain("TOKENval");
});
