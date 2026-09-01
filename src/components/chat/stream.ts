import type { ChatEvent } from "@/server/agent/events";

/**
 * Client half of the Ask transport. `POST /api/chat/stream` answers with `application/x-ndjson` —
 * one JSON-encoded {@link ChatEvent} per line — and this reads them off the body as they land so the
 * UI can paint tokens and tool progress mid-turn instead of waiting on the whole answer.
 */
export interface StreamChatBody {
  conversationId: string | null;
  message: string;
}

export async function streamChat(
  body: StreamChatBody,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(await failureMessage(res));
  }
  if (!res.body) throw new Error("The chat stream returned no body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Chunk boundaries fall wherever TCP feels like it, so a line can be split across reads. Anything
  // after the last newline stays in `buffer` until the rest of it shows up.
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        dispatch(buffer.slice(0, nl), onEvent);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    // A stream that ends without a trailing newline still has one good event in the buffer.
    dispatch(buffer + decoder.decode(), onEvent);
  } finally {
    reader.releaseLock();
  }
}

function dispatch(line: string, onEvent: (event: ChatEvent) => void): void {
  const text = line.trim();
  if (text === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A genuinely truncated tail (connection dropped mid-write) is not worth surfacing as an error:
    // the events already delivered stand, and `done` never arriving is what the caller reacts to.
    return;
  }
  if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
    onEvent(parsed as ChatEvent);
  }
}

/** Turn a non-2xx response into something the user can act on (auth wall, crash, proxy error). */
async function failureMessage(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const body: unknown = JSON.parse(trimmed);
      if (typeof body === "object" && body !== null && "error" in body) {
        const { error } = body as { error: unknown };
        if (typeof error === "string" && error !== "") return error;
      }
    } catch {
      /* fall through to the status line */
    }
  }
  if (res.status === 401 || res.status === 403) return "Your session expired — sign in again.";
  return `Chat request failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""}).`;
}
