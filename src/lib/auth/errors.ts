/**
 * Typed authorisation failures.
 *
 * The guards used to throw a bare `Error` whose message the HTTP layer would have had to
 * string-match to pick a status code. These carry the class instead, so `src/server/api/http.ts`
 * maps them by type while the messages stay byte-identical — the TanStack UI surfaces `.message`
 * verbatim in several places, so the wording is part of the contract.
 */

export class UnauthorizedError extends Error {
  constructor(message = "You're not signed in.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * True when `e` is (or wraps) an auth failure.
 *
 * `src/server/fns/checkin.ts` re-throws through `flattenError`, which rebuilds the error to get the
 * root cause into the message; walking `.cause` keeps a 403 from being reported as a 500 in that
 * one path.
 */
export function authFailure(e: unknown): UnauthorizedError | ForbiddenError | null {
  let cur: unknown = e;
  for (let depth = 0; cur instanceof Error && depth < 8; depth += 1) {
    if (cur instanceof UnauthorizedError || cur instanceof ForbiddenError) return cur;
    cur = cur.cause;
  }
  return null;
}
