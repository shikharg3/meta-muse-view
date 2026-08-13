import { test, expect, beforeEach } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { reconcileClients } from "./clients";
import type { ClubbedClient } from "@/notion/parse";

const club = (id: string, name = id): ClubbedClient => ({
  id,
  name,
  status: "Live",
  accountIds: [`act_${id}`],
  activeAccountIds: [`act_${id}`],
  pages: [
    { pageId: `p_${id}`, title: name, status: "Live", accountIds: [`act_${id}`], ownerIds: [] },
  ],
  budget: null,
  startDate: null,
  endDate: null,
});

const byId = async (id: string) =>
  (await db.select().from(schema.clients).where(eq(schema.clients.id, id)))[0];

beforeEach(async () => {
  await db.execute(sql`truncate table clients cascade`);
});

test("a client that leaves the board is retained and marked removedAt, never deleted", async () => {
  await reconcileClients([club("a"), club("b")]);
  await reconcileClients([club("a")]); // b drops off the board
  const rows = await db.select().from(schema.clients);
  expect(rows.map((r) => r.id).sort()).toEqual(["a", "b"]); // b's row + history kept
  expect((await byId("a")).removedAt).toBeNull(); // still on the board
  expect((await byId("b")).removedAt).not.toBeNull(); // off board, data retained
});

test("an empty/failed board pull never flags live clients as gone", async () => {
  await reconcileClients([club("a")]);
  await reconcileClients([]); // transient empty pull
  expect((await byId("a")).removedAt).toBeNull();
});

test("a re-appearing client is un-marked", async () => {
  await reconcileClients([club("a"), club("z")]);
  await reconcileClients([club("z")]); // a leaves
  expect((await byId("a")).removedAt).not.toBeNull();
  await reconcileClients([club("a"), club("z")]); // a comes back
  expect((await byId("a")).removedAt).toBeNull();
});

test("an already-removed client keeps its original removal time (IS NULL sweep skips it)", async () => {
  const removedAt = new Date("2020-01-01T00:00:00.000Z");
  await db.insert(schema.clients).values({ id: "b", name: "b", removedAt });
  // b stays off the board: the `removed_at IS NULL` sweep must skip it, not bump the timestamp.
  await reconcileClients([club("a")]);
  expect((await byId("b")).removedAt?.getTime()).toBe(removedAt.getTime());
});
