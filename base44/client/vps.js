import { base44 } from "@/api/base44Client";

/**
 * The frontend half of the VPS bridge, and the only module in this app that should mention the VPS.
 *
 * Ops are named exactly as the old TanStack server fns were (`getOverview`, `saveInfraProfile`), so
 * porting a page is a mechanical swap:
 *
 *   await getOverview({ data: spec })   ->   await callVps('getOverview', spec)
 *
 * The catalogue is `GET /api/v1/_ops` on the VPS (99 ops, `{name, mode}`); `mode: "read"` never
 * mutates and is safe to retry or cache.
 *
 * `functions.fetch` rather than `functions.invoke`: invoke returns the raw axios response and
 * throws on any non-2xx, which would bury the VPS's own error envelope, and it cannot stream.
 */

/** Thrown for transport and authorisation failures. Ops that *return* `{error}` still do — see below. */
export class VpsCallError extends Error {
  constructor(op, info) {
    super(info.message);
    this.name = "VpsCallError";
    this.op = op;
    this.info = info;
  }
}

/** Narrow the error envelope without asserting a shape onto whatever actually arrived. */
function readError(raw, op, status) {
  if (
    raw &&
    typeof raw === "object" &&
    typeof raw.code === "string" &&
    typeof raw.message === "string"
  ) {
    return raw;
  }
  return { code: "unreachable", message: `"${op}" failed (${status}).` };
}

/**
 * Call a VPS op.
 *
 * Two failure channels, deliberately distinct. A thrown `VpsCallError` means the call could not be
 * made — bad token, unapproved account, invalid input. Eight ops instead answer `ok:true` with a
 * domain failure *inside* the payload (`getFinance` -> `{error:'Forbidden'}`, the user-admin and
 * client-mapping mutations -> `{ok:false,error}`); that is their existing contract and the UI
 * branches on it, so it is returned untouched rather than normalised into a throw.
 */
export async function callVps(op, data) {
  const res = await base44.functions.fetch("/vps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, data }),
  });

  const body = await res.json().catch(() => null);
  if (body && typeof body === "object" && "ok" in body) {
    if (body.ok === true) return body.data;
    throw new VpsCallError(op, readError(body.error, op, res.status));
  }
  throw new VpsCallError(op, readError(null, op, res.status));
}

/** True when a rejection is the VPS saying "your account is not approved yet". */
export function isNotApproved(err) {
  return err instanceof VpsCallError && err.info.code === "not_approved";
}

// ── Chat ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Stream one assistant turn, one newline-delimited event per line, read off the body as it lands.
 *
 * Chunk boundaries fall wherever the network puts them, so a line can be split across two reads;
 * anything after the last newline waits in `buffer` for the rest of it. Event shapes are the
 * `ChatEvent` union the VPS declares in `src/server/agent/events.ts`:
 * `start | status | tool_start | tool_end | delta | cards | series | report | done | error`.
 */
export async function streamChat(body, signal, onEvent) {
  const res = await base44.functions.fetch("/vps-stream", {
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

  const flush = (line) => {
    const text = line.trim();
    if (text === "") return;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "type" in parsed) onEvent(parsed);
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
