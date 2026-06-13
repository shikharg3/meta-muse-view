import { getChatCredentials } from "@/lib/credentials";
import { fetchClients } from "@/server/fns/clients";
import {
  AnthropicClient,
  type AnthropicMessage,
  type ContentBlock,
  type ResultBlock,
  type LlmClient,
} from "./anthropic";
import { TOOLS, runTool } from "./tools";
import { summarizeReportForLlm, type ReportPayload } from "./report";
import type { CreativeAnalysis, CreativeRow } from "./creative-analysis";
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
  /** Ranked creative grid from analyze_creatives, for the UI to render. */
  creatives: CreativeCards | null;
  error?: string;
}

export interface CreativeCards {
  name: string;
  since: string;
  until: string;
  metricLabel: string;
  rows: CreativeRow[];
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
    "- The /reports command (or any 'generate/export a report' request) maps to generate_report: it builds a downloadable CSV/PDF from live Meta data. It REQUIRES a subject (client/account) and a date range — if either is missing, ask the user for the missing detail instead of calling the tool. After a successful report, give a one-line confirmation (the table and download buttons render automatically); do not paste the full table.",
    "- The /creativeanalysis command (or any question about top/best/worst creatives or what's working visually) maps to analyze_creatives: it returns each top creative's metrics AND image. Study the images and ad copy, not just the numbers — call out shared visual patterns among winners (format, hook, faces, color, text density, CTA) and give concrete scale/pause/test recommendations. Default to last 7 days if no range is given; the creative grid renders automatically, so don't restate every metric.",
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

/** Build a multimodal tool_result (per-creative stats + copy text, then its image). */
function creativeBlocks(a: CreativeAnalysis): ResultBlock[] {
  const blocks: ResultBlock[] = [
    {
      type: "text",
      text: `Top ${a.rows.length} creatives for ${a.name} (${a.since} → ${a.until}), ranked by ${a.metricLabel}. Each creative's image follows its stats.`,
    },
  ];
  const imgByRef = new Map(a.images.map((i) => [i.ref, i]));
  for (const r of a.rows) {
    const parts = [
      `${r.name} — ${r.format}`,
      `spend $${r.spend.toFixed(0)}`,
      `${Math.round(r.results)} ${r.resultLabel.toLowerCase()}`,
      `CTR ${r.ctr.toFixed(2)}%`,
      `CPC $${r.cpc.toFixed(2)}`,
      r.results ? `cost/result $${r.costPerResult.toFixed(2)}` : "",
      r.copy.title ? `headline: "${r.copy.title}"` : "",
      r.copy.body ? `body: "${r.copy.body}"` : "",
      r.copy.cta ? `CTA: ${r.copy.cta}` : "",
    ].filter(Boolean);
    blocks.push({ type: "text", text: parts.join(" · ") });
    const img = imgByRef.get(r.name);
    if (img)
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.base64 },
      });
  }
  return blocks;
}

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
  let creatives: ChatResult["creatives"] = null;

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
      return { reply: textOf(resp.content), toolCalls, cards, report, creatives };
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
      let content: string | ResultBlock[] = JSON.stringify(result);
      if (ok && block.name === "generate_report") {
        report = result as ReportPayload;
        content = JSON.stringify(summarizeReportForLlm(report));
      } else if (ok && block.name === "analyze_creatives") {
        const a = result as CreativeAnalysis;
        creatives = {
          name: a.name,
          since: a.since,
          until: a.until,
          metricLabel: a.metricLabel,
          rows: a.rows,
        };
        content = creativeBlocks(a);
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
    creatives,
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
      creatives: null,
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
      creatives: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
