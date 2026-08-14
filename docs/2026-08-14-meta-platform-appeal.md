# Meta developer account suspension — remediation record

**Date:** 2026-08-14
**App:** `2883033765406087`
**Term cited:** Platform Term 7.e.i.2 — negatively impacting platform, products, data, or users
**Status:** remediation deployed; appeal not yet submitted

Kept in the repository so the appeal's claims stay checkable against the code, and so the same
defects are not reintroduced later by someone who never saw this.

## Timeline

| When (UTC)             | What                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| 2026-08-13 00:04–04:xx | Daily full pass + backfill wrote 187,308 insight rows — a 30× day (~6,000 is normal)                |
| 2026-08-13 16:18–18:47 | Six worker restarts from separate deployments, each firing an immediate full sweep of every account |
| 2026-08-13 17:38:38    | Last successful insights sync                                                                       |
| 2026-08-13 ~18:00      | Meta blocks API access                                                                              |
| 2026-08-13 18:21:09    | First `token invalid/expired — aborting cycle`                                                      |
| 2026-08-14 09:15       | Noticed as "last data update 15h ago"                                                               |

Every Graph call, including `debug_token` and reading the app's own object with an app access token,
returns `API access blocked` / `OAuthException` code 200. `oauth/access_token` with
`client_credentials` still succeeds, which is what confirms the credentials are valid and the block
is on the account rather than the token.

## What we found, measured

| #   | Defect                                                                                                 | Measured                                                                    |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 1   | Worker began a full refresh immediately on start-up with no spacing, so every deploy triggered a sweep | 6 restarts in 2.5h on 2026-08-13                                            |
| 2   | No circuit breaker; the cycle ground on through Meta-side failures                                     | ~920 failed calls/day (961/919/922/917 on Aug 10–13), each retried up to 3× |
| 3   | Backfill walked history for every account regardless of status                                         | 203 accounts, against 106 on the routine refresh                            |
| 4   | Field-error recovery retried a single request up to 12 times plus bisection probes                     | `withFieldRecovery`, `client.ts`                                            |

Worth recording honestly: rate limiting was **not** the problem. One rate-limit event in fourteen
days. This was redundant and failing volume, not throughput against a quota.

## Changes deployed 2026-08-14

1. **Restart cooldown** (`MIN_CYCLE_GAP_MS = 45m`). A cycle records its start in Postgres before any
   Meta call; another cycle within the floor is declined. Persisted deliberately — an in-memory
   timer cannot survive the restart that causes the problem. Deliberate human action (Settings
   "Sync now", "Reset & resync", `--once`) passes `force` and is unaffected.
2. **Circuit breaker** (`CIRCUIT_THRESHOLD = 25`). Consecutive Meta-side failures (#1/#2/is_transient
   and 5xx) open `MetaCircuitOpenError`, which — like the existing `MetaAuthError` — callers re-throw
   rather than logging as a skipped group, so the whole cycle stops. Field and permission errors are
   excluded: those are our bug, not Meta being unwell.
3. **Backfill honours account status**, reusing the refresh's own `refreshAccountIds` selection.
   Confirmed in production: `[backfill] 106 accounts (97 already-synced disabled skipped)`.
4. **Field recovery bounded** from 12 attempts to 4. The rejected-field blocklist is persisted, so a
   request key needing more rounds converges across cycles instead of burning them in one.
5. **Backfill gated behind the same cooldown.** Found by testing fix 1 in production: the restart
   correctly declined to sweep and then ran a full backfill pass anyway, so each restart was still
   being granted a fresh hour-long backfill budget.

Also added: `sync-cycle` health recording on every terminal path. The 15-hour outage was visible
only as data going quietly stale; it now surfaces as a failing service.

## Verification

Production log after a deliberate restart, both gates live:

```
[sync] scheduler started (hourly CORE refresh + daily full + continuous backfill)
[sync] last cycle started 8m ago; within the 45m floor — skipping (restart or duplicate tick)
```

No sweep, no backfill pass. Unit tests cover the breaker (trips, resets on success, ignores field
errors) and the cooldown (holds across a restart, `force` overrides, lapses after the gap). Each was
mutation-checked: disabling the breaker, miscounting field errors as transient, and removing the
cooldown each fail a test.

## Appeal answers

- _Do you understand how you are violating this Platform Term?_ — **Yes.**
- _Have you made the necessary changes?_ — **Yes**, deployed 2026-08-14 (do not answer this until
  the deploy is live; it was not, at the time the form was first opened).

Supporting documentation to attach: this file, and the four commits it describes.
