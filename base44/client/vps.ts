import { base44 } from "@/api/base44Client";

/**
 * Drop this into the Base44 app's `src/api/` — it is the frontend half of the VPS bridge and the
 * only thing in that app that should ever mention the VPS.
 *
 * Ops are named exactly as the old TanStack server fns were (`getOverview`, `saveInfraProfile`),
 * so porting a page is a mechanical swap: `await getOverview({ data: spec })` becomes
 * `await callVps("getOverview", spec)`. The catalogue is `GET /api/v1/_ops` on the VPS.
 */

export interface VpsError {
  code: string;
  message: string;
  detail?: unknown;
}

/** Thrown for transport and authorisation failures. Ops that *return* `{error}` still do. */
export class VpsCallError extends Error {
  constructor(
    readonly op: string,
    readonly info: VpsError,
  ) {
    super(info.message);
    this.name = "VpsCallError";
  }
}

/** Narrow the error envelope without asserting a shape onto whatever actually arrived. */
function readError(raw: unknown, op: string, status: number): VpsError {
  if (raw && typeof raw === "object" && "code" in raw && "message" in raw) {
    const { code, message } = raw;
    if (typeof code === "string" && typeof message === "string") {
      return { code, message, ...("detail" in raw ? { detail: raw.detail } : {}) };
    }
  }
  return { code: "unreachable", message: `"${op}" failed (${status}).` };
}

export async function callVps<T>(op: string, data?: unknown): Promise<T> {
  const res = await base44.functions.fetch("/vps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, data }),
  });

  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === "object" && "ok" in body) {
    // The VPS op registry is the schema authority for `data`; re-declaring 100 payload shapes here
    // would be a second source of truth that silently rots. `T` is the caller's assertion.
    if (body.ok === true && "data" in body) return body.data as T;
    if ("error" in body) throw new VpsCallError(op, readError(body.error, op, res.status));
  }
  throw new VpsCallError(op, readError(null, op, res.status));
}

// ── Chat ───────────────────────────────────────────────────────────────────────────────────────

/**
 * One newline-delimited event per line, read off the body as it lands.
 *
 * Chunk boundaries fall wherever the network puts them, so a line can be split across two reads;
 * anything after the last newline waits in `buffer` for the rest of it. Event shapes are the
 * `ChatEvent` union the VPS declares in `src/server/agent/events.ts`:
 * `start | status | tool_start | tool_end | delta | cards | series | report | done | error`.
 */
export async function streamChat(
  body: { conversationId: string | null; message: string },
  signal: AbortSignal,
  onEvent: (event: { type: string } & Record<string, unknown>) => void,
): Promise<void> {
  const res = await base44.functions.fetch("/vpsStream", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Chat request failed (${res.status}).`);
  if (!res.body) throw new Error("The chat stream returned no body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string): void => {
    const text = line.trim();
    if (text === "") return;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        onEvent(parsed as { type: string } & Record<string, unknown>);
      }
    } catch {
      // A truncated tail (connection dropped mid-write) is not worth surfacing: the events already
      // delivered stand, and the caller reacts to `done` never arriving.
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        flush(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    flush(buffer + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
