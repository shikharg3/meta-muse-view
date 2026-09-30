import { describe, expect, it } from "bun:test";
import type { PortalScope, ScopedBrand, ScopedGroup } from "@/portal/scope";
import type { AnthropicResponse, LlmClient } from "../anthropic";
import { runAgentLoop, TOO_MANY_LOOKUPS, type AgentToolbox } from "../chat";
import type { ReportPayload } from "../report";
import { InFlightTurns } from "@/server/fns/portal-chat";
import { bindPortalBrand, portalToolbox } from "./tools";
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_QUESTION_CHARS,
  parsePortalChat,
  toCustomerEvent,
} from "./turn";

/**
 * The portal assistant's data boundary. Every case is a way a turn about one brand could reach
 * another brand's figures, or a customer could receive something that is not theirs to see — the
 * model is untrusted here, so what matters is what the tools and the stream allow, not what the
 * prompt asks for.
 */

const client = (id: string, name: string): ScopedBrand => ({
  id,
  clientId: "owner",
  name,
  pageName: null,
  pageAvatarUrl: null,
  commission: [],
  accountIds: [],
});

const group = (key: string, brandId: string): ScopedGroup => ({
  id: `owner:${key}`,
  key,
  clientId: "owner",
  brandId,
  name: key,
  pageName: null,
  pageAvatarUrl: null,
  commission: [],
});

// One customer, one client, two Brands (groups) and a campaign on an account no board row lists.
const placement: Record<string, { brand: string; group?: string }> = {
  c_acme_1: { brand: "b1", group: "acme" },
  c_acme_2: { brand: "b1", group: "acme" },
  c_zeta: { brand: "b1", group: "zeta" },
  c_manual: { brand: "b1" },
};

const scope: PortalScope = {
  actor: { id: "u", email: "u@example.com", name: null, status: "approved" },
  brands: [client("b1", "Acme Holdings")],
  campaignIds: Object.keys(placement),
  aliasOf: new Map(Object.keys(placement).map((id) => [id, `Alias ${id}`])),
  brandOf: new Map(Object.entries(placement).map(([id, p]) => [id, p.brand])),
  groupOf: new Map(
    Object.entries(placement).flatMap(([id, p]) => (p.group ? [[id, `owner:${p.group}`]] : [])),
  ),
  groups: new Map([group("acme", "b1"), group("zeta", "b1")].map((g) => [g.id, g])),
};

describe("bindPortalBrand", () => {
  it("narrows a turn to exactly the named brand's campaigns", () => {
    const bound = bindPortalBrand(scope, "owner:acme");
    expect(bound?.brand).toEqual({ id: "owner:acme", name: "acme" });
    expect(bound?.scope.campaignIds).toEqual(["c_acme_1", "c_acme_2"]);
    expect([...(bound?.scope.aliasOf.keys() ?? [])]).toEqual(["c_acme_1", "c_acme_2"]);
    expect([...(bound?.scope.groups.keys() ?? [])]).toEqual(["owner:acme"]);
  });

  it("refuses a brand outside the caller's scope instead of widening to every brand", () => {
    // `narrowToPortalBrands` reads an id naming nothing in scope as "all brands" — right for a
    // dashboard filter, a cross-brand leak for a turn.
    expect(bindPortalBrand(scope, "someone-else:brand")).toBeNull();
    expect(bindPortalBrand(scope, "")).toBeNull();
  });

  it("binds the client's fallback entry to its row-less campaigns only", () => {
    const bound = bindPortalBrand(scope, "b1");
    expect(bound?.scope.campaignIds).toEqual(["c_manual"]);
    expect(bound?.brand.name).toBe("Acme Holdings (other campaigns)");
  });
});

describe("portalToolbox", () => {
  const bound = bindPortalBrand(scope, "owner:acme");
  if (!bound) throw new Error("fixture: owner:acme must bind");
  const toolbox = portalToolbox(bound);

  it("offers the model no parameter that selects a brand or client", () => {
    for (const d of toolbox.definitions) {
      const props = Object.keys((d.input_schema.properties ?? {}) as Record<string, unknown>);
      expect(props.filter((p) => /brand|client|account|owner/i.test(p))).toEqual([]);
    }
  });

  // Refused before anything is read: these resolve without a database.
  it.each([
    ["get_campaign", { campaign_id: "c_zeta" }],
    ["get_campaign", { campaign_id: "c_manual" }],
    ["get_campaign", { campaign_id: "c_unknown" }],
    ["get_daily_trend", { metric: "spend", campaign_id: "c_zeta" }],
    ["list_creatives", { campaign_id: "c_zeta" }],
  ] as const)("%s refuses campaign ids of another brand (%o)", async (name, input) => {
    const out = await toolbox.run(name, { ...input });
    expect(JSON.stringify(out)).toContain("belongs to this brand");
  });

  it("rejects a window longer than the portal allows before reading", async () => {
    expect(await toolbox.run("get_overview", { days: 401 })).toHaveProperty("error");
    expect(
      await toolbox.run("get_overview", { since: "2024-01-01", until: "2025-06-01" }),
    ).toHaveProperty("error");
  });
});

describe("toCustomerEvent", () => {
  it("never forwards what a turn cost", () => {
    const out = toCustomerEvent({ type: "done", costUsd: 0.42, toolCalls: [] });
    expect(out).toEqual({ type: "done", toolCalls: [] });
  });

  it("drops the internal report and thread events", () => {
    expect(toCustomerEvent({ type: "start", conversationId: "x" })).toBeNull();
    // Its payload carries the internal report's markup; the shape is irrelevant, the type is not.
    expect(toCustomerEvent({ type: "report", report: {} as ReportPayload })).toBeNull();
  });
});

describe("parsePortalChat", () => {
  const ask = (content: string) => ({
    brandId: "owner:acme",
    messages: [{ role: "user", content }],
  });

  it("accepts a bounded history ending with the question", () => {
    expect(parsePortalChat(ask("  How did we do?  "))).toEqual({
      brandId: "owner:acme",
      messages: [{ role: "user", content: "How did we do?" }],
    });
  });

  it("refuses a body whose last message is not a question", () => {
    const body = { brandId: "owner:acme", messages: [{ role: "assistant", content: "Hi" }] };
    expect(typeof parsePortalChat(body)).toBe("string");
  });

  it("refuses an over-long question and an over-long history", () => {
    expect(typeof parsePortalChat(ask("x".repeat(MAX_QUESTION_CHARS + 1)))).toBe("string");
    const long = {
      brandId: "owner:acme",
      messages: Array.from({ length: MAX_HISTORY_MESSAGES + 1 }, () => ({
        role: "user",
        content: "q",
      })),
    };
    expect(typeof parsePortalChat(long)).toBe("string");
  });

  it("refuses a history whose messages are each allowed but together too long", () => {
    // 6 × 7000 characters passes every per-message bound and still exceeds the total.
    const filler = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(7000),
    }));
    expect(6 * 7000).toBeGreaterThan(MAX_HISTORY_CHARS);
    const body = { brandId: "owner:acme", messages: [...filler, { role: "user", content: "q" }] };
    expect(typeof parsePortalChat(body)).toBe("string");
  });
});

describe("runAgentLoop maxToolCalls", () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  // First reply asks for five tools at once; second ends the turn, recording what it was sent.
  const fanOut: AnthropicResponse = {
    stop_reason: "tool_use",
    content: Array.from({ length: 5 }, (_, i) => ({
      type: "tool_use" as const,
      id: `tu_${i}`,
      name: "lookup",
      input: {},
    })),
    usage,
  };

  it("runs at most the budget and answers every extra call without running it", async () => {
    let ran = 0;
    const toolbox: AgentToolbox = {
      definitions: [{ name: "lookup", description: "", input_schema: { type: "object" } }],
      label: () => "Lookup",
      run: async () => {
        ran += 1;
        return { ok: true };
      },
      visualOf: () => null,
    };
    const sent: unknown[] = [];
    let call = 0;
    const llm: LlmClient = {
      send: async (p) => {
        sent.push(p.messages[p.messages.length - 1]);
        return call++ === 0
          ? fanOut
          : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage };
      },
    };

    const out = await runAgentLoop(llm, "system", [{ role: "user", content: "q" }], {
      model: "claude-opus-5",
      effort: "low",
      toolbox,
      volatile: "",
      maxToolCalls: 2,
    });

    expect(ran).toBe(2);
    expect(out.toolCalls).toHaveLength(2);
    // The continuation still pairs a result with every tool_use, or the API would reject it.
    const results = sent[1] as { content: { tool_use_id: string; content: string }[] };
    expect(results.content.map((r) => r.tool_use_id)).toEqual([
      "tu_0",
      "tu_1",
      "tu_2",
      "tu_3",
      "tu_4",
    ]);
    expect(results.content.slice(2).every((r) => r.content.includes(TOO_MANY_LOOKUPS))).toBe(true);
  });
});

describe("InFlightTurns", () => {
  it("caps concurrent turns per key and frees a slot exactly once per release", () => {
    const turns = new InFlightTurns(2);
    const a = turns.claim("u1");
    const b = turns.claim("u1");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(turns.claim("u1")).toBeNull();
    // Another requester is unaffected.
    expect(turns.claim("u2")).not.toBeNull();

    a?.();
    a?.(); // a double release must not free b's slot too
    const c = turns.claim("u1");
    expect(c).not.toBeNull();
    expect(turns.claim("u1")).toBeNull();
  });
});
