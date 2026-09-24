import { base44 } from "@/api/base44Client";

/**
 * The agency-side client, used ONLY by the `/admin` routes.
 *
 * Kept separate from `src/api/portal.js` on purpose. The two talk to the same API with different
 * authority, and a single `call(op)` helper would make the authority a property of the op name
 * rather than of the import — so a portal page could reach an agency op by typo. Two modules means
 * `git grep callStaff src/pages src/components` is a complete audit of the privileged surface, and
 * anything outside `admin/` showing up there is a bug you can see.
 */

/** Thrown for transport and authorisation failures. */
export class StaffError extends Error {
  constructor(op, info) {
    super(info.message);
    this.name = "StaffError";
    this.op = op;
    this.info = info;
  }
}

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
 * Call an agency op. Resolves to the op's `data`, or throws `StaffError`.
 *
 * Several ops answer `ok: true` with a domain failure INSIDE the payload
 * (`{ ok: false, error }` from the mutations, `{ error }` from finance). That is their existing
 * contract and the admin UI branches on it, so it is returned untouched rather than normalised
 * into a throw — only transport and authorisation problems throw here.
 */
export async function callStaff(op, data) {
  const res = await base44.functions.fetch("/staff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, data }),
  });

  const body = await res.json().catch(() => null);
  if (body && typeof body === "object" && "ok" in body) {
    if (body.ok === true) return body.data;
    throw new StaffError(op, readError(body.error, op, res.status));
  }
  throw new StaffError(op, readError(null, op, res.status));
}

/** True when the signed-in account is not an agency admin — the UI shows "not authorised". */
export function isNotAdmin(err) {
  return err instanceof StaffError && err.info.code === "forbidden";
}

/**
 * True when the agency API knows this address but has not approved it. The VPS creates a pending
 * staff row the first time a new address calls it, so this is what a brand-new admin sees.
 */
export function isNotApproved(err) {
  return err instanceof StaffError && err.info.code === "not_approved";
}
