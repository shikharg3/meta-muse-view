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

## Setup

On the droplet, in `/opt/meta-dashboard/.env`:

```bash
# 32 random bytes; rotate by changing both sides and restarting meta-web
VPS_API_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
```

Then `systemctl restart meta-web`. Leaving it unset disables the API — `/api/v1/*` answers `503`,
it never falls open.

In the Base44 project:

```bash
base44 secrets set VPS_API_URL=https://analytics.dotmads.com
base44 secrets set VPS_API_TOKEN=<the same value>
base44 functions deploy vps vpsStream
```

`VPS_API_URL` is the origin only — the proxy appends `/api/v1/...` itself.

### TLS is a hard prerequisite

The API refuses a bearer token over plaintext when `NODE_ENV=production` (`403
insecure_transport`), because nginx forwards the real scheme and the repo's vhosts are all
pre-certbot `listen 80`. Run `certbot --nginx -d analytics.dotmads.com --redirect` before setting
the token. No new vhost or DNS record is needed: `/api/v1/*` is served by the same `meta-web`
process on the existing hostname, and the existing `location /` already proxies it.

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
be made. Eight ops instead answer `200` with a domain failure *inside* `data` — `getFinance` returns
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
