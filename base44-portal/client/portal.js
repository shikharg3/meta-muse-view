import { base44 } from "@/api/base44Client";
import { clearViewAs, getViewAs } from "@/lib/viewAs";

/**
 * The frontend half of the client portal's bridge, and the only module in the portal app that
 * should mention the backend at all.
 *
 * Every op goes through the `portal` backend function, and every assistant turn through its
 * streaming sibling `portal-stream`; those two hold `PORTAL_API_TOKEN` and are the only things that
 * may see it. The catalogue of callable ops is `GET /api/v1/_ops` presented with that token, which
 * returns ONLY the `portal*` ops — the internal dashboard's hundred-odd ops are not merely forbidden
 * here, they are unaddressable.
 *
 * `functions.fetch` rather than `functions.invoke`: invoke returns the raw axios response and
 * throws on any non-2xx, which would bury the error envelope the backend deliberately sends.
 *
 * The one exception to "only the portal functions": while an agency admin is previewing the portal
 * as a client (`@/lib/viewAs`), the same ops go through the staff function's `viewPortalAs`
 * instead (see `callPortalAs`), and assistant turns through `staff-stream`.
 */

/** Thrown when a call could not be completed — not signed in, no access, bad input, upstream down. */
export class PortalError extends Error {
  constructor(op, info) {
    super(info.message);
    this.name = "PortalError";
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

/** Call a portal op. Resolves to the op's `data`, or throws `PortalError`. */
export async function callPortal(op, data) {
  const viewAs = getViewAs();
  if (viewAs) return callPortalAs(viewAs.email, op, data);

  const res = await base44.functions.fetch("/portal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, data }),
  });

  const body = await res.json().catch(() => null);
  if (body && typeof body === "object" && "ok" in body) {
    if (body.ok === true) return body.data;
    throw new PortalError(op, readError(body.error, op, res.status));
  }
  throw new PortalError(op, readError(null, op, res.status));
}

/** Staff-side refusals: the caller is not (or no longer) an approved agency admin. */
const STAFF_REFUSALS = ["forbidden", "unauthorized", "not_approved"];

/**
 * The same call, answered as the previewed client by the staff function's `viewPortalAs` — which
 * requires the Base44 `admin` role and a MetaConsole admin, and runs the op exactly as the portal
 * transport would for that address. Its answer carries the portal envelope, so a pending login's
 * `not_approved` still becomes the portal's own "no data linked yet" screen.
 *
 * `@/api/staff` is imported lazily, the rule `Reports.jsx` follows too: the staff client stays out
 * of the portal's static module graph and is only reached while an admin preview is on.
 *
 * A staff refusal ends the preview rather than surfacing as the client's state: it is about the
 * caller, not the client, and after a reload the caller sees their own portal.
 */
async function callPortalAs(email, op, data) {
  const { callStaff, StaffError } = await import("@/api/staff");
  let answer;
  try {
    answer = await callStaff("viewPortalAs", { email, op, data });
  } catch (e) {
    if (e instanceof StaffError && STAFF_REFUSALS.includes(e.info.code)) {
      clearViewAs();
      throw new PortalError(op, {
        code: "view_as_refused",
        message: `Viewing as a client needs an approved agency admin login. ${e.info.message} Reload to see your own portal.`,
      });
    }
    if (e instanceof StaffError) throw new PortalError(op, e.info);
    throw e;
  }
  if (answer && typeof answer === "object" && "ok" in answer) {
    if (answer.ok === true) return answer.data;
    throw new PortalError(op, readError(answer.error, op, 200));
  }
  throw new PortalError(op, readError(null, op, 200));
}

/**
 * True when the signed-in Base44 account has no portal access.
 *
 * Two distinct cases the UI must tell apart from a real error, because both are normal: the address
 * was never invited (`unknown_actor`), or it was invited and is not active yet (`not_approved`).
 * Both mean "show the waiting screen", never "something broke".
 */
export function isNoAccess(err) {
  return (
    err instanceof PortalError &&
    (err.info.code === "unknown_actor" || err.info.code === "not_approved")
  );
}

// ── The assistant ──────────────────────────────────────────────────────────────────────────────

/**
 * Stream one AI Intelligence turn about ONE brand, calling `onEvent` for each event as it lands.
 *
 * The conversation lives in the browser, so `messages` is the whole history (`{ role, content }`,
 * ending with the question); the server keeps none. `brandId` is a `portalBootstrap` brand id and is
 * checked on the server against the caller's own brands — the assistant's tools are bound to it
 * there, so nothing sent from here can make a turn read another brand.
 *
 * Events are newline-delimited JSON: `status | tool_start | tool_end | delta | cards | series |
 * done | error`. Chunk boundaries fall wherever the network puts them, so a line can be split
 * across two reads; anything after the last newline waits in `buffer` for the rest of it.
 *
 * A refusal before the stream starts (no such brand, the daily limit, no access) throws
 * `PortalError` with the server's sentence. While previewing as a client the turn goes through
 * `staff-stream` instead, and a staff-side refusal ends the preview exactly as `callPortalAs` does.
 */
export async function streamPortalChat({ brandId, messages, signal, onEvent }) {
  const viewAs = getViewAs();
  const res = await base44.functions.fetch(viewAs ? "/staff-stream" : "/portal-stream", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(viewAs ? { email: viewAs.email, brandId, messages } : { brandId, messages }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    const info = readError(body && typeof body === "object" ? body.error : null, "portalChat", res.status);
    if (viewAs && STAFF_REFUSALS.includes(info.code)) {
      clearViewAs();
      throw new PortalError("portalChat", {
        code: "view_as_refused",
        message: `Viewing as a client needs an approved agency admin login. ${info.message} Reload to see your own portal.`,
      });
    }
    throw new PortalError("portalChat", info);
  }

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
