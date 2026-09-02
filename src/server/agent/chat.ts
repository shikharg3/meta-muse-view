import { getChatCredentials } from "@/lib/credentials";
import { fetchClients } from "@/server/fns/clients";
import {
  AnthropicClient,
  type AnthropicMessage,
  type ContentBlock,
  type LlmClient,
} from "./anthropic";
import { runTool, toolLabel, toolsFor } from "./tools";
import type { ToolContext } from "./tools/kit";
import { costUsd, type TokenUsage } from "./pricing";
import { emptyExtras, type ChatEvent, type MessageExtras } from "./events";
export type { ToolTrace, MessageExtras, ChatEvent, SeriesPoint } from "./events";
import type { Kpis } from "@/lib/types";

/**
 * A turn of history. `toolResults` is what the model actually fetched last time.
 *
 * Replaying them is the difference between a conversation and a series of unrelated questions. The
 * loop used to be handed prose only, so on turn two the model could see that it had said "$4,210" but
 * not where that came from — which is why the system prompt had to forbid recalling numbers, and why
 * "of those, which had the worst CPC?" re-ran the entire tool chain at full cost.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolResults?: ReplayedTool[];
}

export interface ReplayedTool {
  name: string;
  input: Record<string, unknown>;
  /** JSON the tool returned, already truncated for replay. */
  result: string;
  /** ISO timestamp. Fed to the model so it can judge whether to re-fetch. */
  at: string;
}

export interface ChatResult extends MessageExtras {
  reply: string;
  /** Tool results captured this turn, to be persisted and replayed into the next one. */
  replay: ReplayedTool[];
  costUsd: number;
  /** Raw token counts, kept so cost can be re-derived and attributed per model. */
  usage: TokenUsage;
  model: string;
}

// Cap tool round-trips so a confused model can't loop the bill up.
export const MAX_ITERATIONS = 6;
/** Per-tool replay budget. Big tables get summarised rather than dropped entirely. */
const REPLAY_CHARS = 6000;

/**
 * The cacheable half of the prompt: rules only, no dates and no client list.
 *
 * Everything here is identical from one turn to the next, which is the entire point — this string is
 * a cache breakpoint, and the version that interpolated today's date and every client name broke its
 * own prefix daily and on every Notion sync.
 */
export function buildSystemPrompt(): string {
  return [
    "You are the analytics assistant inside MetaConsole, an internal Meta Ads dashboard for a marketing agency.",
    "You answer questions about ad performance for the agency's clients, ad accounts, and campaigns.",
    "",
    "Rules:",
    "- ALWAYS call a tool for figures you do not already have. Tool results from earlier in THIS conversation are replayed to you with the time they were fetched — reuse them for follow-up questions instead of re-fetching, but re-fetch if the user asks for a different window or the data is more than an hour old.",
    "- NEVER invent or estimate a number that no tool returned.",
    "- Prefer the `preset` argument (yesterday, last_7d, last_month, this_quarter…) over computing dates yourself.",
    "- To compare or rank clients, call list_clients ONCE — it already includes per-client spend, results and contract budget, sorted by spend. NEVER loop get_client_stats.",
    "- 'Which campaigns are active/running/spending?' or any breakdown of active campaigns -> list_active_campaigns ONCE. It returns every campaign with >$0 spend plus account status, budgets and the full conversion breakdown.",
    "- Some clients group several Notion campaigns/brands under one client name (agencies). A brand name is NOT a client name: get_client_stats fuzzy-matches brands too, and search_entities maps a brand to its client. When a brand's Notion row has its own ad accounts, figures are scoped to just those — relay the `brandNote`.",
    "- Ad-set AND ad grain are available via get_ad_sets, including the full per-entity conversion breakdown. Never say ad-set or ad data is unavailable. When ad sets are named after what they target (often one US state each), pass group_by_name=true.",
    "- Budget questions ('when does X run out', 'is X pacing correctly') are answered by the `budget` block on get_client_stats — it carries total, spent, remaining, dailyPace, daysRemaining and projectedEndDate.",
    "- Notion IS connected: a client's `status` is its Notion board status. Ad accounts carry a Meta status where DISABLED means Meta suspended it, with a reason and `disabledSince`.",
    "- If a name can't be resolved, say so and offer the closest matches.",
    "- `kpis.results`/`resultLabel` is ONLY the campaign-objective metric. When asked about conversions or performance, report the full non-zero `events` list too — a sales-objective client can still drive leads and registrations.",
    "- Be concise and lead with the answer. Replies render as Markdown: use a table when listing metrics across multiple campaigns/accounts/clients/days, bold for key figures, bullets only for non-tabular points. Format money as $ and rates as %.",
    // Reports have a dedicated section with templates, run history and export stamping. Answering
    // "build me a CSV" in chat produced a worse copy of it, so the capability is gone rather than
    // duplicated — and the model is told to hand the request over instead of improvising.
    "- You CANNOT generate, build, export or attach CSV/PDF/XLSX files, and you have no tool for it. When someone asks for a downloadable report, export, spreadsheet or PDF: say so in one line and send them to the Reports page (left sidebar → Reports → New report), which has saved templates, run history and the full ~120-metric column catalogue. Then offer to answer the same question as numbers in chat right now, and do it if they say yes. Never claim a file is being prepared, never promise a download, and never imply a link will appear.",
  ].join("\n");
}

/** Per-turn facts. Deliberately outside the cached prefix, because they change every day. */
export async function buildVolatileContext(today = new Date()): Promise<string> {
  const clients = await fetchClients();
  const names = clients
    .filter((c) => c.removedAt == null)
    .map((c) => c.name)
    .join(", ");
  return [
    `Today is ${today.toISOString().slice(0, 10)}.`,
    `Known clients: ${names || "(none synced yet)"}`,
  ].join("\n");
}

const textOf = (blocks: ContentBlock[]): string =>
  blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

const isErr = (r: unknown): boolean => typeof r === "object" && r !== null && "error" in r;

/** One-line summary of a tool call's arguments, for the live trace. */
function describeInput(input: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const key of ["client", "subject", "query", "preset", "level"]) {
    const v = input[key];
    if (typeof v === "string" && v) parts.push(v);
  }
  if (typeof input.days === "number") parts.push(`${input.days}d`);
  else if (typeof input.since === "string" && typeof input.until === "string")
    parts.push(`${input.since}→${input.until}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Rebuild the message array the model sees, re-inserting prior tool results as synthetic tool_use /
 * tool_result pairs so earlier findings survive into later turns.
 *
 * Synthetic rather than replayed verbatim: the original `tool_use` ids are gone, and reusing a stale
 * id would break the pairing the API requires. Each result is stamped with when it was fetched, which
 * is what lets the model decide between reusing and re-fetching.
 */
function toApiMessages(history: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  let synthetic = 0;
  for (const m of history) {
    if (m.role === "user" || !m.toolResults?.length) {
      if (m.content.trim()) out.push({ role: m.role, content: m.content });
      continue;
    }
    const uses: ContentBlock[] = [];
    const results: ContentBlock[] = [];
    for (const t of m.toolResults) {
      const id = `replay_${synthetic++}`;
      uses.push({ type: "tool_use", id, name: t.name, input: t.input });
      results.push({
        type: "tool_result",
        tool_use_id: id,
        content: `[fetched ${t.at}]\n${t.result}`,
      });
    }
    out.push({ role: "assistant", content: uses });
    out.push({ role: "user", content: results });
    if (m.content.trim()) out.push({ role: "assistant", content: m.content });
  }
  return out;
}

export interface LoopOptions {
  model: string;
  effort: string;
  ctx: ToolContext;
  /** Emits progress as it happens. Omit for a silent (test) run. */
  emit?: (e: ChatEvent) => void;
}

/**
 * Drive the tool-use loop to completion: call the model, run any requested tools against Postgres,
 * feed results back, repeat until the model answers or the iteration cap trips. Pure w.r.t. the LLM
 * (injected) so it can be tested.
 */
export async function runAgentLoop(
  llm: LlmClient,
  system: string,
  history: ChatMessage[],
  opts: LoopOptions,
): Promise<ChatResult> {
  // Only show the model the last 25 turns (user+assistant pairs) to bound context.
  const CONTEXT_TURNS = 25;
  const messages = toApiMessages(history.slice(-CONTEXT_TURNS * 2));
  const tools = toolsFor(opts.ctx);
  const emit = opts.emit ?? (() => {});
  const extras: MessageExtras = emptyExtras();
  const captured: ReplayedTool[] = [];
  const acc: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const volatile = await buildVolatileContext();

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    emit({ type: "status", text: i === 0 ? "Thinking" : "Working through the results" });
    const resp = await llm.send(
      { model: opts.model, effort: opts.effort, system, volatile, tools, messages },
      {
        onText: (text) => emit({ type: "delta", text }),
        onThinking: () => emit({ type: "status", text: "Reasoning" }),
      },
    );
    // Preserve the full content (incl. thinking blocks) verbatim — required for
    // tool-use continuations with extended thinking.
    messages.push({ role: "assistant", content: resp.content });
    acc.input += resp.usage.input_tokens ?? 0;
    acc.output += resp.usage.output_tokens ?? 0;
    acc.cacheWrite += resp.usage.cache_creation_input_tokens ?? 0;
    acc.cacheRead += resp.usage.cache_read_input_tokens ?? 0;

    if (resp.stop_reason !== "tool_use") {
      return {
        ...extras,
        reply: textOf(resp.content),
        replay: captured,
        costUsd: costUsd(opts.model, acc),
        usage: acc,
        model: opts.model,
      };
    }

    const results: ContentBlock[] = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const label = toolLabel(block.name);
      const detail = describeInput(block.input);
      emit({ type: "tool_start", name: block.name, label, detail });
      const started = Date.now();
      const result = await runTool(block.name, block.input, opts.ctx);
      const ms = Date.now() - started;
      const ok = !isErr(result);
      extras.toolCalls.push({ name: block.name, label, ok, ms, detail });
      emit({ type: "tool_end", name: block.name, label, ok, ms, detail });

      const content = JSON.stringify(result);
      if (ok && isClientStats(result)) {
        extras.cards = { title: result.client, kpis: result.kpis };
        emit({ type: "cards", ...extras.cards });
      } else if (ok && block.name === "get_overview" && hasKpis(result)) {
        extras.cards = { title: "All accounts", kpis: result.kpis };
        emit({ type: "cards", ...extras.cards });
      } else if (ok && isSeries(result)) {
        extras.series = { title: result.title, unit: result.unit, points: result.points };
        emit({ type: "series", ...extras.series });
      }

      captured.push({
        name: block.name,
        input: block.input,
        result:
          content.length > REPLAY_CHARS ? `${content.slice(0, REPLAY_CHARS)}…[truncated]` : content,
        at: new Date().toISOString(),
      });
      results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: !ok });
    }
    messages.push({ role: "user", content: results });
  }

  return {
    ...extras,
    reply: "I couldn't finish that in a reasonable number of steps. Try a narrower question.",
    replay: captured,
    costUsd: costUsd(opts.model, acc),
    usage: acc,
    model: opts.model,
  };
}

/** A tool result carrying a chartable series, by convention on the `series` key. */
function isSeries(
  r: unknown,
): r is { title: string; unit: string; points: { date: string; value: number }[] } {
  if (typeof r !== "object" || r === null) return false;
  return (
    "title" in r &&
    typeof r.title === "string" &&
    "unit" in r &&
    typeof r.unit === "string" &&
    "points" in r &&
    Array.isArray(r.points)
  );
}

const hasKpis = (r: unknown): r is { kpis: Kpis } =>
  typeof r === "object" &&
  r !== null &&
  "kpis" in r &&
  typeof r.kpis === "object" &&
  r.kpis !== null;

const isClientStats = (r: unknown): r is { client: string; kpis: Kpis } =>
  hasKpis(r) && "client" in r && typeof r.client === "string";

export interface TurnOutcome extends ChatResult {
  error?: string;
}

const failed = (error: string): TurnOutcome => ({
  ...emptyExtras(),
  reply: "",
  replay: [],
  costUsd: 0,
  usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  model: "",
  error,
});

/** Entry point for the chat server fn: load creds, run the loop, map errors to a reply. */
export async function chatTurn(
  history: ChatMessage[],
  ctx: ToolContext,
  emit?: (e: ChatEvent) => void,
): Promise<TurnOutcome> {
  const creds = await getChatCredentials();
  if (!creds) return failed("No Claude API key configured. Add one in Settings → Assistant.");
  const llm = new AnthropicClient(creds.token);
  try {
    const out = await runAgentLoop(llm, buildSystemPrompt(), history, {
      model: creds.model,
      effort: creds.effort,
      ctx,
      emit,
    });
    return out;
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}
