import { base44 } from "@/api/base44Client";

/**
 * The frontend half of the client portal's bridge, and the only module in the portal app that
 * should mention the backend at all.
 *
 * Every call goes through the `portal` backend function, which holds `PORTAL_API_TOKEN` and is the
 * only thing that may see it. The catalogue of callable ops is `GET /api/v1/_ops` presented with
 * that token, which returns ONLY the `portal*` ops — the internal dashboard's hundred-odd ops are
 * not merely forbidden here, they are unaddressable.
 *
 * `functions.fetch` rather than `functions.invoke`: invoke returns the raw axios response and
 * throws on any non-2xx, which would bury the error envelope the backend deliberately sends.
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
