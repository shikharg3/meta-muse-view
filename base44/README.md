# Base44 frontend ↔ VPS backend

The frontend lives on Base44. Everything else — Postgres, the Meta Marketing API sync, the Notion
sync, Telegram, the AI agent — stays on the droplet and is reached through one HTTP API.

```
Base44 SPA ──invoke──▶ base44/functions/vps ──Bearer──▶ VPS /api/v1/<op>
   (browser)             (Deno, holds secret)            (src/server/api/http.ts)
```

## Why a proxy and not a direct call

`VPS_API_TOKEN` authorises every op, including credential writes, `resetAndResync` and the finance
figures. Anything the browser holds is public, so the token lives only in a Base44 **backend
function** secret. The VPS API sets no `Access-Control-*` headers at all and never will — a browser
cannot call it, so a leaked-then-replayed request is impossible rather than merely discouraged.

## Identity vs authorisation

Base44 asserts **who**; the VPS decides **what they may do**.

The proxy sends `X-Actor-Email` for the Base44-authenticated user. `src/server/api/http.ts` resolves
that email against the droplet's own `users` table, and the whole existing model applies unchanged:
`member` / `admin` / `superadmin`, the pending→approved lifecycle, the audit log, superadmin-only
finance and cross-user chat history. A compromised Base44 app cannot mint an admin.

**Consequence:** a teammate must exist and be approved on the VPS `/users` page, and their Base44
login email must match their VPS account email exactly. An unknown email gets `403 unknown_actor`.

## How this runs today: a parallel service, live app untouched

The API is **already deployed and reachable**, and the app the team uses was never restarted to get
there. Two processes, one database, split by path at nginx:

```
                          ┌─ /            → 127.0.0.1:8787  meta-web       (live, untouched)
https://analytics.dotmads.com
                          └─ /api/v1/*    → 127.0.0.1:8789  meta-web-next  (this work)
```

|                 | live                            | staging                        |
| --------------- | ------------------------------- | ------------------------------ |
| checkout        | `/opt/meta-dashboard`           | `/opt/meta-next`               |
| branch          | `feat/meta-integration`         | `feat/base44-api`              |
| unit            | `meta-web` (+ `meta-sync`)      | `meta-web-next` — **web only** |
| port            | 8787                            | 8789                           |
| `VPS_API_TOKEN` | not set ⇒ `/api/v1/*` would 503 | set                            |

`meta-sync` is deliberately **not** duplicated: two workers would race on the same upsert keys and
split the Meta rate-limit budget. The single live worker keeps ingesting and the staging process
reads what it writes, so the API serves real, current data.

nginx matches the longest prefix, so `/api/v1/` wins over `/` regardless of block order. **Deleting
that `location` block and reloading nginx cuts Base44 off instantly**, with no effect on the team.

Port 8789, not 8788: `/opt/infra-manager` (the `infra.dotmads.com` app) already owns 8788. Check
`ss -ltn` before picking one.

## Setup

The token is already generated and lives in `/opt/meta-next/.env` only. Read it with:

```bash
ssh <droplet> "grep '^VPS_API_TOKEN=' /opt/meta-next/.env"
```

In the Base44 project:

```bash
base44 secrets set VPS_API_URL=https://analytics.dotmads.com
base44 secrets set VPS_API_TOKEN=<that value>
base44 functions deploy vps vpsStream
```

`VPS_API_URL` is the origin only — the proxy appends `/api/v1/...` itself.

Rotating it: change `/opt/meta-next/.env`, `systemctl restart meta-web-next`, then update the
Base44 secret. Unset it and the API answers `503`; it never falls open.

## Promoting, once Base44 is proven

1. Rebase `feat/base44-api` onto `droplet/feat/meta-integration` and merge it to trunk. The two
   branches have duplicate-subject commits from a rebase, so a blind merge will conflict.
2. Before deploying: `ssh <droplet> "LABEL=pre-promote bash /opt/meta-dashboard/deploy/backup.sh"`.
3. Add `VPS_API_TOKEN` to `/opt/meta-dashboard/.env`, deploy trunk the normal way.
4. Remove the `/api/v1/` block from the vhost and reload nginx — one process serves both again.
5. `systemctl disable --now meta-web-next` and delete `/opt/meta-next`.

Step 3 is the only moment the team's app restarts onto this code. The unproven part is that the
server-fn transport now validates input with real zod schemas where it previously passed data
through an identity cast — a payload the UI sends malformed would newly be rejected. Watch
`journalctl -u meta-web -f` through the first navigation of every section, and
`bash /opt/meta-ops/rollback.sh` restores the previous build in about 15 seconds.

## TLS

Already in place — certbot has run on the droplet for `analytics.dotmads.com` and
`analytics.madsmonitor.com`, and port 80 301-redirects. Note the vhosts committed under `deploy/`
are the **pre-certbot templates**; the deployed files in `/etc/nginx/sites-available/` were
rewritten in place by certbot and are captured by `deploy/backup.sh`, not by git.

This matters because the API returns `403 insecure_transport` when `NODE_ENV=production` and
`X-Forwarded-Proto` is not `https` — a bearer token crossing plaintext is a token in the clear, so
it refuses rather than trusting that certbot was run. The `/api/v1/` location sets that header.

## Calling it

Copy `base44/client/vps.ts` into the Base44 app's `src/api/`. Ops keep the exact names the old
TanStack server fns had, so porting a page is mechanical:

```ts
// before, in the VPS app
const data = await getOverview({ data: { days: 30 } });

// after, in Base44
const data = await callVps<Overview>("getOverview", { days: 30 });
```

`GET /api/v1/_ops` returns the catalogue (99 ops, `{name, mode}`). `mode: "read"` never mutates and
is safe to retry or cache.

### Envelope

```jsonc
{ "ok": true, "data": ... }
{ "ok": false, "error": { "code": "forbidden", "message": "...", "detail": [...] } }
```

`code` is one of `api_disabled`, `method_not_allowed`, `insecure_transport`, `unauthorized`,
`unknown_actor`, `bad_request`, `invalid_input`, `unknown_op`, `forbidden`, `internal`.

**Transport errors and domain errors are different things.** A 4xx envelope means the call could not
be made. Eight ops instead answer `200` with a domain failure _inside_ `data` — `getFinance` returns
`{error:"Forbidden"}`, the user-admin and client-mapping mutations return `{ok:false,error}`. That is
their existing contract and the UI branches on it, so it was preserved rather than normalised.

### Chat

The assistant streams; it is not a request/response op. Use `streamChat()` from `vps.ts`, which
posts to the `vpsStream` function and reads newline-delimited `ChatEvent` JSON as the turn happens
(`start | status | tool_start | tool_end | delta | cards | series | report | done | error`).

Base44 functions cap at **5 minutes**. `vps` aborts at 4m30s and returns `upstream_timeout` so a
long call fails as JSON instead of being killed with no response. The ops that get near it are
`resetAndResync`, `startReportRun`, `syncNotionNow` and `getExportCsv`.

## Not migrated

- **`/portal`** (the client-facing portal) renders entirely from `src/portal/mock.ts` fixtures and
  has no auth or server fns at all. There is nothing to point at an API yet; its selector surface
  (`totalsFor`, `seriesFor`, `campaignRows`, `breakdownFor`, `pacingFor`, `creativesFor`) is the
  spec for endpoints that do not exist.
- **`/privacy`, `/terms`, the Meta-crawler stub, `/auth/*`** stay server-rendered on the droplet.
  Meta App Review needs those URLs to answer without a session on the app's own domain.
- **`getGreeting`** — dead bootstrap scaffold, deleted rather than ported.
