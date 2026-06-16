import { test, expect } from "bun:test";
import { runOnce } from "./run";
import type { InsightsClient } from "@/meta/types";

test("runOnce calls each job for each account in order", async () => {
  const order: string[] = [];
  const fakeClient = {
    debugToken: async () => ({ is_valid: true, scopes: [] }),
  } as unknown as InsightsClient;

  await runOnce({
    client: fakeClient,
    accountIds: ["act_1", "act_2"],
    jobs: {
      structure: async (_c, id) => {
        order.push(`struct:${id}`);
      },
      insights: async (_c, id) => {
        order.push(`ins:${id}`);
      },
      breakdowns: async (_c, id) => {
        order.push(`bd:${id}`);
      },
      objects: async (_c, id) => {
        order.push(`obj:${id}`);
      },
    },
  });

  expect(order).toEqual([
    "struct:act_1",
    "ins:act_1",
    "bd:act_1",
    "obj:act_1",
    "struct:act_2",
    "ins:act_2",
    "bd:act_2",
    "obj:act_2",
  ]);
});

test("runOnce continues to the next account when one account throws", async () => {
  const seen: string[] = [];
  const fakeClient = {
    debugToken: async () => ({ is_valid: true, scopes: [] }),
  } as unknown as InsightsClient;
  await runOnce({
    client: fakeClient,
    accountIds: ["act_1", "act_2"],
    jobs: {
      structure: async (_c, id) => {
        if (id === "act_1") throw new Error("x");
        seen.push(id);
      },
      insights: async () => {},
      breakdowns: async () => {},
      objects: async () => {},
    },
  });
  expect(seen).toEqual(["act_2"]);
});

test("an account's structure failure does not skip its insights or breakdowns", async () => {
  const ran: string[] = [];
  const fakeClient = {
    debugToken: async () => ({ is_valid: true, scopes: [] }),
  } as unknown as InsightsClient;
  await runOnce({
    client: fakeClient,
    accountIds: ["act_1"],
    jobs: {
      structure: async () => {
        throw new Error("Meta 500 after 6 retries");
      },
      insights: async (_c, id) => {
        ran.push(`ins:${id}`);
      },
      breakdowns: async (_c, id) => {
        ran.push(`bd:${id}`);
      },
      objects: async (_c, id) => {
        ran.push(`obj:${id}`);
      },
    },
  });
  expect(ran).toEqual(["ins:act_1", "bd:act_1", "obj:act_1"]);
});
