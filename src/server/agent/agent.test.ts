import { test, expect, beforeEach } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resolveClient, runTool } from "./tools";
import { runReport } from "./report";
import { runAgentLoop, type ChatResult } from "./chat";
import type { CreateMessageParams, AnthropicResponse, LlmClient } from "./anthropic";

async function seed() {
  await db.execute(
    sql`truncate table accounts, campaigns, ad_sets, ads, insights_daily, clients cascade`,
  );
  await db.insert(schema.accounts).values([
    { id: "act_111", name: "Wild Main", currency: "USD" },
    { id: "act_222", name: "Wild Old", currency: "USD" },
    { id: "act_555", name: "GatherOne", currency: "USD" },
    { id: "act_556", name: "SlotsAcct", currency: "USD" },
  ]);
  await db.insert(schema.clients).values([
    {
      id: "wildcasino-ag",
      name: "wildcasino.ag",
      status: "Live",
      notionAccountIds: ["act_111", "act_222"],
      notionActiveAccountIds: ["act_111"], // act_222 is an "Other ad accounts" entry
    },
    {
      id: "playw3-be-the-boss",
      name: "playW3 / be the boss",
      status: "Live",
      notionAccountIds: ["act_999"],
      notionActiveAccountIds: ["act_999"], // act_999 is not assigned to the Meta token (not in accounts)
    },
    {
      id: "old-farside",
      name: "Farside",
      status: "Not started",
      notionAccountIds: ["act_333"],
      removedAt: new Date(),
    },
    {
      id: "oneagency",
      name: "OneAgency",
      status: "Live",
      notionAccountIds: ["act_555", "act_556"],
      raw: [
        // Per-row account mapping: each Notion campaign row carries its own accounts.
        { pageId: "p1", title: "Lucky Rebel", status: "Live", accountIds: ["act_555"] },
        { pageId: "p2", title: "Slots.lv", status: "Live", accountIds: ["act_556"] },
      ],
    },
  ]);
  await db.insert(schema.campaigns).values({
    id: "c1",
    accountId: "act_111",
    name: "Wild #5",
    objective: "OUTCOME_LEADS",
    status: "ACTIVE",
    dailyBudget: 5000, // cents → $50/day target
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
  // Ad-set fixture: a client whose ad sets are named by US state, spread across two campaigns.
  await db.insert(schema.accounts).values({ id: "act_777", name: "State Ads", currency: "USD" });
  await db.insert(schema.clients).values({
    id: "statewise",
    name: "Statewise",
    status: "Live",
    notionAccountIds: ["act_777"],
  });
  await db.insert(schema.campaigns).values([
    {
      id: "c_broad",
      accountId: "act_777",
      name: "SW Broad",
      objective: "OUTCOME_SALES",
      status: "ACTIVE",
    },
    {
      id: "c_lal",
      accountId: "act_777",
      name: "SW LAL",
      objective: "OUTCOME_SALES",
      status: "ACTIVE",
    },
  ]);
  await db.insert(schema.adSets).values([
    {
      id: "s_ca_b",
      campaignId: "c_broad",
      accountId: "act_777",
      name: "California",
      status: "ACTIVE",
    },
    {
      id: "s_ca_l",
      campaignId: "c_lal",
      accountId: "act_777",
      name: "California",
      status: "ACTIVE",
    },
    { id: "s_tx_b", campaignId: "c_broad", accountId: "act_777", name: "Texas", status: "PAUSED" },
  ]);
  await db.insert(schema.ads).values({
    id: "ad_ca1",
    adSetId: "s_ca_b",
    accountId: "act_777",
    name: "Creative A",
    status: "ACTIVE",
  });
  await db.insert(schema.insightsDaily).values([
    {
      level: "adset",
      entityId: "s_ca_b",
      date: today,
      accountId: "act_777",
      spend: 100,
      impressions: 1000,
      clicks: 40,
      actions: [{ action_type: "omni_purchase", value: "2" }],
    },
    {
      level: "adset",
      entityId: "s_ca_l",
      date: today,
      accountId: "act_777",
      spend: 50,
      impressions: 500,
      clicks: 20,
      actions: [{ action_type: "omni_purchase", value: "3" }],
    },
    {
      level: "adset",
      entityId: "s_tx_b",
      date: today,
      accountId: "act_777",
      spend: 80,
      impressions: 800,
      clicks: 30,
      actions: [{ action_type: "omni_purchase", value: "1" }],
    },
    {
      level: "ad",
      entityId: "ad_ca1",
      date: today,
      accountId: "act_777",
      spend: 60,
      impressions: 600,
      clicks: 25,
      actions: [{ action_type: "omni_purchase", value: "2" }],
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

test("resolveClient falls back to a Notion brand title, mapping it to its agency client", async () => {
  // "Lucky Rebel" is not a client name — it's a brand row grouped under agency client "OneAgency".
  const r = await resolveClient("Lucky Rebel");
  expect(r).toMatchObject({ id: "oneagency", name: "OneAgency", matchedBrand: "Lucky Rebel" });
  expect((r as { siblingBrands?: string[] }).siblingBrands).toContain("Slots.lv");
  // The matched row's own accounts come back so stats can be scoped per campaign, not per client.
  expect((r as { brandAccountIds?: string[] }).brandAccountIds).toEqual(["act_555"]);
  // Punctuation/spacing-insensitive: "LuckyRebel" (no space) resolves the same brand.
  expect(await resolveClient("LuckyRebel")).toMatchObject({
    id: "oneagency",
    matchedBrand: "Lucky Rebel",
  });
  // A pure client-NAME match still wins over brand fallback.
  expect(await resolveClient("wild")).toMatchObject({ id: "wildcasino-ag" });
  // get_client_stats scopes to the brand row's OWN account — the sibling row's act_556 is excluded.
  const stats = (await runTool("get_client_stats", { client: "Lucky Rebel", days: 7 })) as {
    client: string;
    matchedBrand?: string;
    brandNote?: string;
    accounts: { id: string }[];
  };
  expect(stats.client).toBe("OneAgency");
  expect(stats.matchedBrand).toBe("Lucky Rebel");
  expect(stats.accounts.map((a) => a.id)).toEqual(["act_555"]); // NOT act_556 (Slots.lv's account)
  expect(stats.brandNote).toContain("scoped");
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
  // A removed "ghost" client also links act_111; it must NOT override the live owner's status.
  await db
    .update(schema.clients)
    .set({ notionAccountIds: ["act_333", "act_111"] })
    .where(eq(schema.clients.id, "old-farside"));
  const { accounts: rows, unsyncedActiveAccounts } = (await runTool("list_accounts", {})) as {
    mappingSyncedAt: string | null;
    unsyncedActiveAccounts: { client: string; clientStatus: string | null; accountId: string }[];
    accounts: {
      id: string;
      status: string;
      disableReason: string | null;
      client: string | null;
      clientStatus: string | null;
      isActiveAccount: boolean;
    }[];
  };
  // A designated Active Account ID not assigned to the Meta token surfaces as unsynced (no status),
  // never as a fabricated active/disabled account.
  expect(unsyncedActiveAccounts).toContainEqual({
    client: "playW3 / be the boss",
    clientStatus: "Live",
    accountId: "act_999",
  });
  expect(rows.some((r) => r.id === "act_999")).toBe(false);
  expect(rows.find((r) => r.id === "act_111")).toMatchObject({
    status: "DISABLED",
    disableReason: "Ads integrity policy",
    client: "wildcasino.ag",
    clientStatus: "Live",
    isActiveAccount: true,
  });
  expect(rows.find((r) => r.id === "act_222")).toMatchObject({
    status: "ACTIVE",
    client: "wildcasino.ag",
    clientStatus: "Live",
    isActiveAccount: false,
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
  // Restrict to the Notion "Active Account ID" only: act_111 is wildcasino's active account (disabled);
  // act_222 is an "Other ad accounts" entry — so the active-account cross-ref flags only wildcasino.ag.
  const liveDisabledActive = rows
    .filter((r) => r.clientStatus === "Live" && r.isActiveAccount && r.status === "DISABLED")
    .map((r) => r.client);
  expect(liveDisabledActive).toEqual(["wildcasino.ag"]);
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
    dailyAvgSpend: number;
    dailyBudget: number | null;
    accountStatus: string;
    events: { label: string; count: number }[];
  }[];
  const wild = camps.find((c) => c.name === "Wild #5");
  expect(wild).toBeDefined();
  expect(wild!.spend).toBeGreaterThan(0);
  expect(wild!.client).toBe("wildcasino.ag"); // current client, not an archived board entity
  expect(wild!.dailyAvgSpend).toBeCloseTo(200 / 7); // window spend / 7 days
  expect(wild!.dailyBudget).toBeCloseTo(50); // 5000 cents → $50/day target
  expect(wild!.accountStatus).toBe("ACTIVE");
  expect(wild!.events.find((e) => e.label === "Leads")?.count).toBe(20);
}, 20000);

test("get_ad_sets returns per-ad-set conversions and sums by name (state) across campaigns", async () => {
  // Ungrouped: one row per ad set — California appears under both campaigns.
  const ungrouped = (await runTool("get_ad_sets", { subject: "Statewise", days: 30 })) as {
    adSets: { name: string; parent: string; spend: number }[];
  };
  expect(ungrouped.adSets.map((a) => a.name).sort()).toEqual(["California", "California", "Texas"]);

  // group_by_name: the two California ad sets collapse into one; spend + conversions sum.
  const grouped = (await runTool("get_ad_sets", {
    subject: "Statewise",
    group_by_name: true,
    days: 30,
  })) as {
    groupedByName: boolean;
    adSets: {
      name: string;
      spend: number;
      merged?: number;
      events: { label: string; count: number }[];
    }[];
  };
  expect(grouped.groupedByName).toBe(true);
  const ca = grouped.adSets.find((a) => a.name === "California");
  if (!ca) throw new Error("California row missing");
  expect(ca.merged).toBe(2);
  expect(ca.spend).toBeCloseTo(150);
  expect(ca.events.find((e) => e.label === "Purchases")?.count).toBe(5);
  const tx = grouped.adSets.find((a) => a.name === "Texas");
  expect(tx?.events.find((e) => e.label === "Purchases")?.count).toBe(1);
}, 20000);

test("get_ad_sets level='ad' returns ad-level rows under their ad set", async () => {
  const r = (await runTool("get_ad_sets", { subject: "Statewise", level: "ad", days: 30 })) as {
    level: string;
    ads: { name: string; parent: string; spend: number }[];
  };
  expect(r.level).toBe("ad");
  const ad = r.ads.find((a) => a.name === "Creative A");
  if (!ad) throw new Error("ad missing");
  expect(ad.parent).toBe("California"); // parent = owning ad set
  expect(ad.spend).toBeCloseTo(60);
}, 20000);

test("get_ad_sets resolves a campaign subject to just its ad sets", async () => {
  const r = (await runTool("get_ad_sets", { subject: "SW Broad", days: 30 })) as {
    adSets: { name: string }[];
  };
  // SW Broad holds California + Texas (not the LAL campaign's California).
  expect(r.adSets.map((a) => a.name).sort()).toEqual(["California", "Texas"]);
}, 20000);

test("runReport says breakdown-not-synced (not 'no data') when totals exist for the window", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const args = {
    name: "wildcasino.ag",
    accountIds: ["act_111"],
    since: today,
    until: today,
    columns: ["spend"],
    markup: undefined,
  };
  // Campaign-level rows exist for today, but no breakdown rows are seeded → actionable error.
  const bd = await runReport({ ...args, breakdown: "platform" });
  if (!("error" in bd)) throw new Error("expected an error for the unsynced breakdown");
  expect(bd.error).toContain("hasn't been synced");
  expect(bd.error).toContain("platform");
  // Same window without a breakdown works fine.
  const totals = await runReport({ ...args, breakdown: "none" });
  if ("error" in totals) throw new Error(`unexpected error: ${totals.error}`);
  expect(totals.rowCount).toBeGreaterThan(0);
  // A window with truly nothing still reports plain no-data.
  const empty = await runReport({
    ...args,
    since: "2020-01-01",
    until: "2020-01-02",
    breakdown: "platform",
  });
  if (!("error" in empty)) throw new Error("expected no-data error");
  expect(empty.error).toContain("No data");
}, 20000);
