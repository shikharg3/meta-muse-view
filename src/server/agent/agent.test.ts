import { test, expect, beforeEach } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resolveClient, runTool } from "./tools";
import { runAgentLoop, type ChatResult } from "./chat";
import type { CreateMessageParams, AnthropicResponse, LlmClient } from "./anthropic";

async function seed() {
  await db.execute(
    sql`truncate table accounts, campaigns, ad_sets, ads, insights_daily, clients cascade`,
  );
  await db.insert(schema.accounts).values([
    { id: "act_111", name: "Wild Main", currency: "USD" },
    { id: "act_222", name: "Wild Old", currency: "USD" },
  ]);
  await db.insert(schema.clients).values([
    {
      id: "wildcasino-ag",
      name: "wildcasino.ag",
      status: "Live",
      notionAccountIds: ["act_111", "act_222"],
    },
    {
      id: "playw3-be-the-boss",
      name: "playW3 / be the boss",
      status: "Live",
      notionAccountIds: ["act_999"],
    },
    {
      id: "old-farside",
      name: "Farside",
      status: "Not started",
      notionAccountIds: ["act_333"],
      removedAt: new Date(),
    },
  ]);
  await db.insert(schema.campaigns).values({
    id: "c1",
    accountId: "act_111",
    name: "Wild #5",
    objective: "OUTCOME_LEADS",
    status: "ACTIVE",
  });
  const today = new Date().toISOString().slice(0, 10);
  await db.insert(schema.insightsDaily).values([
    {
      level: "account",
      entityId: "act_111",
      date: today,
      accountId: "act_111",
      spend: 200,
      impressions: 2000,
      clicks: 100,
    },
    {
      level: "campaign",
      entityId: "c1",
      date: today,
      accountId: "act_111",
      spend: 200,
      impressions: 2000,
      clicks: 100,
      actions: [{ action_type: "lead", value: "20" }],
    },
  ]);
}

beforeEach(seed);

test("resolveClient handles exact, fuzzy, ambiguous, and missing", async () => {
  expect(await resolveClient("wildcasino.ag")).toMatchObject({ id: "wildcasino-ag" });
  expect(await resolveClient("wild")).toMatchObject({ id: "wildcasino-ag" }); // fuzzy substring
  expect(await resolveClient("Playw3")).toMatchObject({ id: "playw3-be-the-boss" });
  const none = await resolveClient("nonexistent-xyz");
  expect(none).toHaveProperty("error");
  expect((none as { candidates: string[] }).candidates.length).toBeGreaterThan(0);
}, 20000);

test("get_client_stats returns grounded KPIs across the client's accounts", async () => {
  const r = (await runTool("get_client_stats", { client: "wild", days: 7 })) as {
    client: string;
    kpis: { spend: number; ctr: number };
    accounts: unknown[];
  };
  expect(r.client).toBe("wildcasino.ag");
  expect(r.kpis.spend).toBeCloseTo(200);
  expect(r.kpis.ctr).toBeCloseTo(5); // 100/2000*100
  expect(r.accounts).toHaveLength(2); // current + old
}, 20000);

test("get_client_stats reports each account's Meta status (disabled flagged, not active)", async () => {
  // act_111 is disabled in Meta (account_status 2). The chat previously omitted
  // account status entirely and the model guessed "active" — regression guard.
  await db
    .update(schema.accounts)
    .set({ status: "2", disableReason: 1 })
    .where(eq(schema.accounts.id, "act_111"));
  const r = (await runTool("get_client_stats", { client: "wild", days: 7 })) as {
    accounts: { id: string; status: string | null; disableReason: string | null }[];
  };
  const acct = r.accounts.find((a) => a.id === "act_111");
  expect(acct?.status).toBe("DISABLED");
  expect(acct?.disableReason).toBe("Ads integrity policy");
}, 20000);

test("list_accounts joins Meta status to the owning client's Notion status (suspension cross-ref)", async () => {
  await db
    .update(schema.accounts)
    .set({ status: "2", disableReason: 1 })
    .where(eq(schema.accounts.id, "act_111"));
  const rows = (await runTool("list_accounts", {})) as {
    id: string;
    status: string;
    disableReason: string | null;
    client: string | null;
    clientStatus: string | null;
  }[];
  expect(rows.find((r) => r.id === "act_111")).toMatchObject({
    status: "DISABLED",
    disableReason: "Ads integrity policy",
    client: "wildcasino.ag",
    clientStatus: "Live",
  });
  expect(rows.find((r) => r.id === "act_222")).toMatchObject({
    status: "ACTIVE",
    client: "wildcasino.ag",
    clientStatus: "Live",
  });
  // The cross-reference the chatbot wrongly claimed it couldn't do: Live/Paused-on-Notion clients
  // that currently have a suspended (DISABLED) ad account.
  const flagged = new Set(
    rows
      .filter(
        (r) =>
          r.status === "DISABLED" && (r.clientStatus === "Live" || r.clientStatus === "Paused"),
      )
      .map((r) => r.client),
  );
  expect(flagged.has("wildcasino.ag")).toBe(true);
  expect(flagged.size).toBe(1);
}, 20000);

test("runTool returns error data for unknown tools rather than throwing", async () => {
  expect(await runTool("bogus", {})).toEqual({ error: "Unknown tool: bogus" });
});

// Scripted fake LLM: first reply asks for a tool, second reply ends the turn.
function scriptedLlm(steps: AnthropicResponse[]): LlmClient {
  let i = 0;
  return {
    createMessage: async (_p: CreateMessageParams) => steps[Math.min(i++, steps.length - 1)],
  };
}

test("runAgentLoop executes requested tools, captures KPI cards, and terminates", async () => {
  const llm = scriptedLlm([
    {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          id: "tu_1",
          name: "get_client_stats",
          input: { client: "Wild", days: 7 },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Wild spent $200 with a 5% CTR over the last 7 days." }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ]);
  const out: ChatResult = await runAgentLoop(
    llm,
    "system",
    [{ role: "user", content: "stats for Wild last 7 days" }],
    { model: "claude-opus-4-8", effort: "xhigh" },
  );
  expect(out.reply).toContain("$200");
  expect(out.toolCalls).toEqual([{ name: "get_client_stats", ok: true }]);
  expect(out.cards).toMatchObject({ title: "wildcasino.ag" });
  expect(out.cards?.kpis.spend).toBeCloseTo(200);
}, 20000);

test("runAgentLoop stops at the iteration cap if the model never finishes", async () => {
  const looping = scriptedLlm([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu", name: "list_clients", input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ]);
  const out = await runAgentLoop(looping, "system", [{ role: "user", content: "loop" }], {
    model: "claude-opus-4-8",
    effort: "low",
  });
  expect(out.reply).toContain("couldn't finish");
  expect(out.toolCalls.length).toBe(5); // MAX_ITERATIONS
}, 20000);

test("aggregate tools honor an explicit since/until day (yesterday ≠ days=1)", async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await db.insert(schema.insightsDaily).values({
    level: "account",
    entityId: "act_111",
    date: yesterday,
    accountId: "act_111",
    spend: 500,
    impressions: 100,
    clicks: 5,
  });
  // days=1 resolves to TODAY only → today's seeded spend (200), not yesterday's. This is the bug
  // that produced "$0 yesterday": today is often ~empty until it completes.
  const todayOnly = (await runTool("get_overview", { days: 1 })) as { kpis: { spend: number } };
  expect(todayOnly.kpis.spend).toBeCloseTo(200);
  // since=until=yesterday → yesterday's spend (500), the correct answer.
  const yest = (await runTool("get_overview", { since: yesterday, until: yesterday })) as {
    kpis: { spend: number };
  };
  expect(yest.kpis.spend).toBeCloseTo(500);
}, 20000);

test("resolveClient and list_clients exclude archived (off-board) clients", async () => {
  // "Farside" exists only as an archived (removedAt) client, so it must not resolve or be listed.
  expect(await resolveClient("Farside")).toHaveProperty("error");
  const listed = (await runTool("list_clients", { days: 7 })) as { name: string }[];
  expect(listed.some((c) => c.name === "Farside")).toBe(false);
  expect(listed.some((c) => c.name === "wildcasino.ag")).toBe(true);
}, 20000);

test("list_active_campaigns returns spending campaigns mapped to their current client", async () => {
  const camps = (await runTool("list_active_campaigns", { days: 7 })) as {
    name: string;
    client: string | null;
    spend: number;
  }[];
  const wild = camps.find((c) => c.name === "Wild #5");
  expect(wild).toBeDefined();
  expect(wild!.spend).toBeGreaterThan(0);
  expect(wild!.client).toBe("wildcasino.ag"); // current client, not an archived board entity
}, 20000);
