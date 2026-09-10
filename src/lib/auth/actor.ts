import { AsyncLocalStorage } from "node:async_hooks";
import type { PublicUser } from "@/lib/auth/users";

/**
 * Who the current call is acting as, when there is no cookie to read.
 *
 * Server fns resolve the caller through `getCookie()`, which needs a TanStack request context. The
 * HTTP API in `src/server/api` has neither — it is called server-to-server by the Base44 proxy,
 * which asserts the caller's email in a header. Rather than fork ~60 authorisation checks across
 * two transports, the API resolves the actor once per request and runs the whole op inside this
 * context; `currentUser()` reads it first and falls back to the cookie. Every existing
 * `requireAdmin()` / `requireApproved()` / `audit()` call then works unchanged on both transports.
 *
 * The store is wrapped in an object so an *explicitly anonymous* API call (no identity header) is
 * distinguishable from "not running under the API at all" — `undefined` means use the cookie,
 * `{ actor: null }` means there is genuinely nobody signed in.
 */
const storage = new AsyncLocalStorage<{ actor: PublicUser | null }>();

// These two thin accessors exist so the `AsyncLocalStorage` instance itself stays module-private:
// exported, it would let any caller `enterWith()` an actor and leave it set for the rest of the
// event-loop turn, which is exactly the privilege-escalation shape this context must not allow.
export function runAsActor<T>(actor: PublicUser | null, fn: () => Promise<T>): Promise<T> {
  return storage.run({ actor }, fn);
}

/** The active actor context, or `undefined` outside the HTTP API. */
export function actorContext(): { actor: PublicUser | null } | undefined {
  return storage.getStore();
}
