import { AsyncLocalStorage } from "node:async_hooks";
import type { PortalActor } from "@/portal/scope";

/**
 * The calling portal user, for the duration of one `portal*` op.
 *
 * Deliberately a SEPARATE store from `src/lib/auth/actor.ts`, not a role inside it. That module
 * backs `currentUser()`, which backs `requireAdmin()` / `requireApproved()` / `audit()` — around
 * sixty authorisation checks written on the assumption that whoever is in there is a member of
 * staff. Putting a client in that store to save a file would make every one of those checks a
 * question about the wrong person, and `requireApproved()` would happily pass for an approved
 * client. Two stores means a portal caller cannot satisfy a staff check by construction.
 *
 * The transport pairs this with `runAsActor(null, …)`, so the staff context is explicitly empty for
 * the whole call: any staff check reached from a portal op fails closed rather than falling back to
 * a cookie that is not there.
 */
const storage = new AsyncLocalStorage<PortalActor>();

export function runAsPortalActor<T>(actor: PortalActor, fn: () => Promise<T>): Promise<T> {
  return storage.run(actor, fn);
}

/**
 * The calling portal user.
 *
 * Throws rather than returning null: every `portal*` op needs an actor to scope itself to, so
 * "there is nobody here" is a programming error (an op registered under the wrong prefix, or called
 * from the staff transport) and must not be silently treated as "show everything".
 */
export function currentPortalActor(): PortalActor {
  const actor = storage.getStore();
  if (!actor) {
    throw new Error(
      "No portal actor in context — a portal* op was invoked outside the portal transport.",
    );
  }
  return actor;
}
