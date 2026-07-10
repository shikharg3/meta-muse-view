// Minimal Anthropic Messages API client. No SDK: one endpoint, fetch is enough.
// claude-opus-4-8 uses adaptive thinking + output_config.effort (not the older
// thinking.type=enabled budget form).
const URL = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

/** Blocks allowed inside a tool_result's content array (text + images). */
export type ResultBlock = { type: "text"; text: string } | { type: "image"; source: ImageSource };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "image"; source: ImageSource }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ResultBlock[];
      is_error?: boolean;
    };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
  stop_reason: string;
  content: ContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    // Present only when prompt caching is active.
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface CreateMessageParams {
  model: string;
  effort: string;
  system: string;
  tools: AnthropicTool[];
  messages: AnthropicMessage[];
  maxTokens?: number;
}

/** The slice of an LLM the agent loop depends on — lets tests inject a scripted fake. */
export interface LlmClient {
  createMessage(params: CreateMessageParams): Promise<AnthropicResponse>;
}

export class AnthropicClient implements LlmClient {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async createMessage(params: CreateMessageParams): Promise<AnthropicResponse> {
    // Prompt caching (GA): mark the system prompt and the final tool as cache
    // breakpoints. cache_control isn't on AnthropicTool, so widen locally.
    const cacheControl = { type: "ephemeral" as const };
    const tools = params.tools.map((t, i) =>
      i === params.tools.length - 1 ? { ...t, cache_control: cacheControl } : t,
    );
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: params.effort },
      system: [{ type: "text", text: params.system, cache_control: cacheControl }],
      tools,
      messages: params.messages,
    };
    const res = await this.fetchImpl(URL, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } }).error?.message ?? "request failed";
      throw new Error(`Anthropic ${res.status}: ${msg}`);
    }
    return json as unknown as AnthropicResponse;
  }
}
