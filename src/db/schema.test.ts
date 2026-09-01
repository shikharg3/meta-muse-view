import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "./client";

beforeEach(async () => {
  await db.execute(sql`truncate table accounts cascade`);
});

test("round-trips an account row", async () => {
  await db.insert(schema.accounts).values({
    id: "act_1",
    name: "Test Co",
    currency: "USD",
    status: "ACTIVE",
  });
  const rows = await db.select().from(schema.accounts);
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe("Test Co");
});
