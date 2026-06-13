// Minimal Anthropic Messages API client. No SDK: one endpoint, fetch is enough.
// claude-opus-4-8 uses adaptive thinking + output_config.effort (not the older
// thinking.type=enabled budget form).
const URL = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

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
  usage: { input_tokens: number; output_tokens: number };
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
    const res = await this.fetchImpl(URL, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        thinking: { type: "adaptive" },
        output_config: { effort: params.effort },
        system: params.system,
        tools: params.tools,
        messages: params.messages,
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } }).error?.message ?? "request failed";
      throw new Error(`Anthropic ${res.status}: ${msg}`);
    }
    return json as unknown as AnthropicResponse;
  }
}
