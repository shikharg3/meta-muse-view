// Minimal Anthropic Messages API client. No SDK: one endpoint, fetch is enough.
// claude-opus-5 uses adaptive thinking + output_config.effort (not the older
// thinking.type=enabled budget form).
const URL = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

/** No bytes for this long and the connection is presumed dead. Thinking is silent, so be generous. */
const IDLE_TIMEOUT_MS = 120_000;
/** Hard ceiling on one model call, thinking included. */
const TOTAL_TIMEOUT_MS = 600_000;
const MAX_ATTEMPTS = 3;

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
  /**
   * Stable, cacheable instructions ONLY.
   *
   * Anything that changes between turns belongs in `volatile`. The system block is a cache breakpoint,
   * so interpolating today's date or the live client list here — as this used to — invalidated the
   * prefix daily and on every client sync, quietly paying full price for a cache that never hit.
   */
  system: string;
  /** Per-turn facts (date, client roster). Sent as a leading user block, outside the cached prefix. */
  volatile?: string;
  tools: AnthropicTool[];
  messages: AnthropicMessage[];
  maxTokens?: number;
}

/** Progressive output. Every callback is optional; a non-streaming fake can ignore them all. */
export interface StreamHandlers {
  onText?(delta: string): void;
  onThinking?(): void;
  onToolStart?(name: string): void;
}

/** The slice of an LLM the agent loop depends on — lets tests inject a scripted fake. */
export interface LlmClient {
  send(params: CreateMessageParams, on?: StreamHandlers): Promise<AnthropicResponse>;
}

/** Accumulates SSE deltas back into the block array the API would have returned whole. */
interface Building {
  type: string;
  text: string;
  thinking: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  json: string;
}

const retriable = (status: number) => status === 408 || status === 429 || status >= 500;

export class AnthropicClient implements LlmClient {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(params: CreateMessageParams, on?: StreamHandlers): Promise<AnthropicResponse> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attempt(params, on);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        // Only retry when nothing was emitted: a half-streamed answer cannot be restarted cleanly.
        if (attempt === MAX_ATTEMPTS || !isRetriable(lastError)) throw lastError;
        const backoff = Promise.withResolvers<void>();
        setTimeout(backoff.resolve, 500 * 2 ** (attempt - 1));
        await backoff.promise;
      }
    }
    throw lastError ?? new Error("Anthropic: exhausted retries");
  }

  private async attempt(
    params: CreateMessageParams,
    on?: StreamHandlers,
  ): Promise<AnthropicResponse> {
    // Prompt caching, three of the four breakpoints the API allows:
    //   - the last tool and the system block, explicitly: the static prefix every conversation
    //     shares, so a brand-new chat reads it back instead of paying to write it again.
    //   - the end of `messages`, via the top-level `cache_control`: the API puts that breakpoint on
    //     the last cacheable block and walks it forward as the history grows. Without it the whole
    //     conversation — including the tool results, which are the bulk of it — was re-billed at
    //     full input price on every tool round-trip and every follow-up turn.
    // cache_control isn't on AnthropicTool, so widen locally.
    const cacheControl = { type: "ephemeral" as const };
    const tools = params.tools.map((t, i) =>
      i === params.tools.length - 1 ? { ...t, cache_control: cacheControl } : t,
    );
    // Volatile facts ride in front of the first user message, leaving the cached prefix untouched.
    const messages: AnthropicMessage[] = params.volatile
      ? [{ role: "user", content: params.volatile }, ...params.messages]
      : params.messages;

    const controller = new AbortController();
    const total = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };
    touch();

    try {
      const res = await this.fetchImpl(URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: params.model,
          // Thinking is billed as output and counts against this ceiling, so a small one risks
          // truncating the answer at the xhigh default effort. Only generated tokens are billed.
          max_tokens: params.maxTokens ?? 32_000,
          cache_control: cacheControl,
          thinking: { type: "adaptive" },
          output_config: { effort: params.effort },
          system: [{ type: "text", text: params.system, cache_control: cacheControl }],
          tools,
          messages,
          stream: true,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        const err = new Error(
          `Anthropic ${res.status}: ${body.error?.message ?? "request failed"}`,
        );
        if (retriable(res.status)) err.name = "RetriableError";
        throw err;
      }
      if (!res.body) throw new Error("Anthropic: response had no body");
      return await this.consume(res.body, touch, on);
    } finally {
      clearTimeout(total);
      clearTimeout(idle);
    }
  }

  /** Read the SSE stream, fire handlers, and rebuild the full response. */
  private async consume(
    body: ReadableStream<Uint8Array>,
    touch: () => void,
    on?: StreamHandlers,
  ): Promise<AnthropicResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const blocks: Building[] = [];
    const usage: AnthropicResponse["usage"] = { input_tokens: 0, output_tokens: 0 };
    let stopReason = "end_turn";
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; keep the trailing partial in the buffer.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: StreamFrame;
        try {
          evt = JSON.parse(payload) as StreamFrame;
        } catch {
          continue; // a malformed frame is not worth failing a whole answer over
        }
        applyFrame(evt, blocks, usage, on, (r) => (stopReason = r));
      }
    }

    return { stop_reason: stopReason, content: blocks.map(finish), usage };
  }
}

interface StreamFrame {
  type: string;
  index?: number;
  message?: { usage?: Partial<AnthropicResponse["usage"]> };
  content_block?: { type: string; id?: string; name?: string; data?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: Partial<AnthropicResponse["usage"]>;
}

function applyFrame(
  evt: StreamFrame,
  blocks: Building[],
  usage: AnthropicResponse["usage"],
  on: StreamHandlers | undefined,
  setStop: (r: string) => void,
): void {
  switch (evt.type) {
    case "message_start":
      mergeUsage(usage, evt.message?.usage);
      return;
    case "content_block_start": {
      const b = evt.content_block;
      if (!b) return;
      blocks[evt.index ?? blocks.length] = {
        type: b.type,
        text: "",
        thinking: "",
        json: "",
        ...(b.id ? { id: b.id } : {}),
        ...(b.name ? { name: b.name } : {}),
        ...(b.data ? { data: b.data } : {}),
      };
      if (b.type === "thinking") on?.onThinking?.();
      if (b.type === "tool_use" && b.name) on?.onToolStart?.(b.name);
      return;
    }
    case "content_block_delta": {
      const block = blocks[evt.index ?? 0];
      const d = evt.delta;
      if (!block || !d) return;
      if (d.type === "text_delta" && d.text) {
        block.text += d.text;
        on?.onText?.(d.text);
      } else if (d.type === "thinking_delta" && d.thinking) {
        block.thinking += d.thinking;
      } else if (d.type === "signature_delta" && d.signature) {
        block.signature = d.signature;
      } else if (d.type === "input_json_delta" && d.partial_json) {
        block.json += d.partial_json;
      }
      return;
    }
    case "message_delta":
      if (evt.delta?.stop_reason) setStop(evt.delta.stop_reason);
      mergeUsage(usage, evt.usage);
      return;
    case "error":
      throw new Error("Anthropic stream error");
    default:
      return;
  }
}

function mergeUsage(
  into: AnthropicResponse["usage"],
  from: Partial<AnthropicResponse["usage"]> | undefined,
): void {
  if (!from) return;
  if (from.input_tokens) into.input_tokens = from.input_tokens;
  if (from.output_tokens) into.output_tokens = from.output_tokens;
  if (from.cache_creation_input_tokens != null)
    into.cache_creation_input_tokens = from.cache_creation_input_tokens;
  if (from.cache_read_input_tokens != null)
    into.cache_read_input_tokens = from.cache_read_input_tokens;
}

function finish(b: Building): ContentBlock {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      return {
        type: "thinking",
        thinking: b.thinking,
        ...(b.signature ? { signature: b.signature } : {}),
      };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: b.data ?? "" };
    case "tool_use": {
      let input: Record<string, unknown> = {};
      if (b.json) {
        try {
          input = JSON.parse(b.json) as Record<string, unknown>;
        } catch {
          input = {};
        }
      }
      return { type: "tool_use", id: b.id ?? "", name: b.name ?? "", input };
    }
    default:
      return { type: "text", text: b.text };
  }
}

function isRetriable(e: Error): boolean {
  if (e.name === "RetriableError") return true;
  // AbortError from our own timeout, or a transport-level failure.
  return e.name === "AbortError" || e.name === "TypeError";
}
