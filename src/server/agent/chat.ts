import { getChatCredentials } from "@/lib/credentials";
import { fetchClients } from "@/server/fns/clients";
import {
  AnthropicClient,
  type AnthropicMessage,
  type ContentBlock,
  type LlmClient,
} from "./anthropic";
import { TOOLS, runTool } from "./tools";
import { costUsd, type TokenUsage } from "./pricing";
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
  /** Total USD spent on model tokens for the whole turn (all loop iterations). */
  costUsd: number;
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
    "- 'Which campaigns are active / running / spending [in a period]?' OR any request for a breakdown/summary of the active campaigns -> call list_active_campaigns ONCE. It returns EVERY campaign with >$0 spend in the window with a FULL per-campaign breakdown: owning account + its Meta status (ACTIVE/PAUSED/DISABLED), owning client, campaign status, spend, dailyAvgSpend, dailyBudget (daily target), impressions, clicks, CTR, CPC, results, and `events` (purchases/registrations/leads/…). This single call has everything — do NOT loop get_client_stats per client, and do NOT use get_overview (top few only). list_clients and name-resolution cover only CURRENT (on-board) clients, so a name that does not resolve as a client may be a campaign or an old/off-board client — check with list_active_campaigns or search_entities before calling it inactive or 'not started'.",
    "- Some clients group several Notion campaigns/brands under one client name (agencies). A brand/campaign name (e.g. 'Lucky Rebel', 'Farside') is NOT a client name: resolve it with get_client_stats (it fuzzy-matches brands too) or search_entities (whose `brands` list maps a brand to its client). When a brand's Notion row has its OWN ad accounts, get_client_stats and get_ad_sets automatically scope figures to JUST that campaign's accounts (the result carries `matchedBrand` + a `brandNote` saying so) — this is the default for 'details of campaign X' questions, so per-campaign answers do NOT include the client's other campaigns. Only when the row carries no accounts do figures fall back to the whole client (the brandNote says that too — relay it). Never call a brand 'not started' or unknown before checking.",
    "- Ad-set-level AND ad-level data ARE available via get_ad_sets (spend, impressions, CTR, CPC, objective result, and the FULL conversion breakdown per ad set/ad). Use it for any ad-set/ad question — never say ad-set or ad data is unavailable. When each ad set targets/represents one thing named in the ad-set name (e.g. one US state per ad set), call get_ad_sets with group_by_name=true to get per-name (per-state) totals INCLUDING conversions, and prefer this over the region/geo breakdown for per-state conversions. Pass a client subject for all of the client's ad sets, or a campaign subject to scope to one campaign.",
    "- Time ranges: `days` is a TRAILING window ending TODAY, so days=1 = TODAY only (today's spend is usually ~0 until the day completes and syncs). For a SPECIFIC day or explicit range, pass since+until (YYYY-MM-DD) on list_clients / get_client_stats / get_overview — e.g. for 'yesterday' set since=until=(today − 1 day) computed from the date above; for 'last week' use the appropriate since/until. When no range is stated, default to the trailing 30 days. HISTORY: core insights are synced back to each ad account's creation date (Meta's cap is ≈37 months), so month- or year-long ranges are fine — never claim data only covers ~90 days. Platform/placement/age/gender/country/region breakdown tables cover ≈13 months.",
    "- Be concise and lead with the answer. Your replies render as Markdown, so format for readability: use a **Markdown table** when listing metrics across multiple campaigns / accounts / clients / days (e.g. columns Campaign | Spend | Results | CPC), use **bold** for key figures and short section titles, and bullet lists only for non-tabular breakdowns. Format money as $ and rates as %.",
    "- A client's accounts may include old ones not in the current Business Manager (shown with no data) — say so rather than reporting them as zero performance.",
    "- Notion IS connected: a client's `status` (from list_clients / get_client_stats) is its status on the Notion campaigns board (e.g. Live, Paused, Full Budget Finished). You CAN answer questions about Notion campaign/client status — never say you lack Notion access.",
    "- Ad accounts carry a Meta `status`: DISABLED = Meta has suspended/disabled the account (with a `disableReason`); ACTIVE/PAUSED are normal. Each DISABLED account also has `disabledSince` — the date it was disabled (from Meta's status-change log). To find suspended/disabled accounts, WHEN they were disabled ('disabled yesterday/today/this week' → filter by `disabledSince` against the current date), or to cross-reference Notion status against account suspension (e.g. 'how many Live/Paused-on-Notion clients have a suspended account'), call list_accounts ONCE — it returns every account with status, disable reason, disabledSince, owning client, and Notion status. Never claim you can't see account suspension or the disable date; a null `disabledSince` means only that one account's change wasn't captured, not that dates are unavailable.",
    "- If a name can't be resolved, say so and offer the closest matches.",
    "- get_client_stats AND get_overview return an `events` list: ALL conversion + engagement events that fired (purchases, leads, registrations, link clicks, …), de-duplicated across Meta's many action_type variants — get_client_stats is scoped to one client, get_overview spans every account. `kpis.results`/`resultLabel` is ONLY the campaign-objective metric; when asked about conversions or performance (for a client OR across all accounts), report the full non-zero `events` list (with counts, and value for purchases), not just the objective result. A sales-objective client can still drive leads/registrations, so surface them (e.g. 0 purchases but 67 leads).",
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
  // Only show the model the last 25 turns (user+assistant pairs) to bound context.
  const CONTEXT_TURNS = 25;
  const windowed = history.slice(-CONTEXT_TURNS * 2);
  const messages: AnthropicMessage[] = windowed.map((m) => ({ role: m.role, content: m.content }));
  const toolCalls: ToolTrace[] = [];
  let cards: ChatResult["cards"] = null;
  let report: ChatResult["report"] = null;
  const acc: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

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
    acc.input += resp.usage.input_tokens ?? 0;
    acc.output += resp.usage.output_tokens ?? 0;
    acc.cacheWrite += resp.usage.cache_creation_input_tokens ?? 0;
    acc.cacheRead += resp.usage.cache_read_input_tokens ?? 0;

    if (resp.stop_reason !== "tool_use") {
      return {
        reply: textOf(resp.content),
        toolCalls,
        cards,
        report,
        costUsd: costUsd(opts.model, acc),
      };
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
    costUsd: costUsd(opts.model, acc),
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
      costUsd: 0,
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
      costUsd: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
