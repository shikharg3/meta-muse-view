import { getChatCredentials } from "@/lib/credentials";
import { fetchClients } from "@/server/fns/clients";
import {
  AnthropicClient,
  type AnthropicMessage,
  type ContentBlock,
  type LlmClient,
} from "./anthropic";
import { TOOLS, runTool } from "./tools";
import { summarizeReportForLlm, type ReportPayload } from "./report";
import type { Kpis } from "@/lib/types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolTrace {
  name: string;
  ok: boolean;
}

export interface ChatResult {
  reply: string;
  toolCalls: ToolTrace[];
  /** KPI strip the UI renders from the last data tool that succeeded, if any. */
  cards: { title: string; kpis: Kpis } | null;
  /** Full report payload from a generate_report call, for the UI to render + download. */
  report: ReportPayload | null;
  error?: string;
}

// Cap tool round-trips so a confused model can't loop the bill up.
const MAX_ITERATIONS = 5;

export async function buildSystemPrompt(today = new Date()): Promise<string> {
  const clients = await fetchClients();
  const names = clients.map((c) => c.name).join(", ");
  return [
    "You are the analytics assistant inside MetaConsole, an internal Meta Ads dashboard for a marketing agency.",
    `Today is ${today.toISOString().slice(0, 10)}.`,
    "You answer questions about ad performance for the agency's clients, ad accounts, and campaigns.",
    "",
    "Rules:",
    "- ALWAYS call a tool to get figures. NEVER invent, estimate, or recall numbers from earlier — fetch them.",
    "- Resolve fuzzy client names using the known-clients list below or the list_clients tool.",
    "- To compare or rank clients (most/least spend or results), call list_clients ONCE — it already includes per-client spend and results, sorted by spend. NEVER call get_client_stats for many clients in a loop.",
    "- When no time range is stated, default to the last 30 days. Data only exists for the last 90 days.",
    "- Be concise and lead with the answer. Format money as $ and rates as %. Use short bullet lists for breakdowns.",
    "- A client's accounts may include old ones not in the current Business Manager (shown with no data) — say so rather than reporting them as zero performance.",
    "- If a name can't be resolved, say so and offer the closest matches.",
    "- get_client_stats returns an `events` list: ALL conversion + engagement events that fired for the client (purchases, leads, registrations, link clicks, …), already de-duplicated across Meta's many action_type variants. `kpis.results`/`resultLabel` is ONLY the campaign-objective metric — when asked about conversions or performance, report the full non-zero `events` list (with counts, and value for purchases), not just the objective result. A sales-objective client can still drive leads/registrations, so surface them (e.g. 0 purchases but 67 leads).",
    "- The /reports command (or any 'generate/export a report' request) maps to generate_report: it builds a downloadable CSV/PDF from live Meta data. It REQUIRES a subject (client/account) and a date range — if either is missing, ask the user for the missing detail instead of calling the tool. After a successful report, give a one-line confirmation (the table and download buttons render automatically); do not paste the full table.",
    "",
    `Known clients: ${names || "(none synced yet)"}`,
  ].join("\n");
}

const textOf = (blocks: ContentBlock[]): string =>
  blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

const isErr = (r: unknown): boolean =>
  typeof r === "object" && r !== null && "error" in (r as Record<string, unknown>);

/**
 * Drive the tool-use loop to completion: call the model, run any requested
 * tools against Postgres, feed results back, repeat until the model answers or
 * the iteration cap trips. Pure w.r.t. the LLM (injected) so it can be tested.
 */
export async function runAgentLoop(
  llm: LlmClient,
  system: string,
  history: ChatMessage[],
  opts: { model: string; effort: string },
): Promise<ChatResult> {
  const messages: AnthropicMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
  const toolCalls: ToolTrace[] = [];
  let cards: ChatResult["cards"] = null;
  let report: ChatResult["report"] = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const resp = await llm.createMessage({
      model: opts.model,
      effort: opts.effort,
      system,
      tools: TOOLS,
      messages,
    });
    // Preserve the full content (incl. thinking blocks) verbatim — required for
    // tool-use continuations with extended thinking.
    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") {
      return { reply: textOf(resp.content), toolCalls, cards, report };
    }

    const results: ContentBlock[] = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      let result: unknown;
      try {
        result = await runTool(block.name, block.input);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      const ok = !isErr(result);
      toolCalls.push({ name: block.name, ok });
      let content = JSON.stringify(result);
      if (ok && block.name === "generate_report") {
        report = result as ReportPayload;
        content = JSON.stringify(summarizeReportForLlm(report));
      } else if (ok && block.name === "get_client_stats") {
        const r = result as { client: string; kpis: Kpis };
        cards = { title: r.client, kpis: r.kpis };
      } else if (ok && block.name === "get_overview") {
        cards = { title: "All accounts", kpis: (result as { kpis: Kpis }).kpis };
      }
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content,
        is_error: !ok,
      });
    }
    messages.push({ role: "user", content: results });
  }

  return {
    reply: "I couldn't finish that in a reasonable number of steps. Try a narrower question.",
    toolCalls,
    cards,
    report,
  };
}

/** Entry point for the chat server fn: load creds, run the loop, map errors to a reply. */
export async function chatTurn(history: ChatMessage[]): Promise<ChatResult> {
  const creds = await getChatCredentials();
  if (!creds) {
    return {
      reply: "",
      toolCalls: [],
      cards: null,
      report: null,
      error: "No Claude API key configured. Add one in Settings → Assistant.",
    };
  }
  const llm = new AnthropicClient(creds.token);
  const system = await buildSystemPrompt();
  try {
    return await runAgentLoop(llm, system, history, { model: creds.model, effort: creds.effort });
  } catch (e) {
    return {
      reply: "",
      toolCalls: [],
      cards: null,
      report: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
