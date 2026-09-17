# MetaConsole — working agreements

Internal Meta Ads analytics for **DOT Agency**: hourly ingestion from the Meta Marketing API into
Postgres, cross-client attribution, reporting, alerting, an AI assistant, and a two-way Notion sync.

TanStack Start (React 19, SSR via Nitro) · Postgres + Drizzle · Bun · deployed to a DigitalOcean
droplet as two systemd services (`meta-web` on :8787, `meta-sync` worker).

This file is read by both humans and coding agents. Machine-specific details (SSH key paths, host
addresses) belong in each operator's local config, never here.

## Commands

```bash
bun run dev            # local dev server
bun run build          # production build into .output/
bun run lint           # eslint (includes prettier)
bun run format         # prettier --write
bun test               # DESTRUCTIVE against TEST_DATABASE_URL — read the database section first
bun run sync:once      # one full sync cycle (all metrics + breakdowns), ~3-4h over 150+ accounts
bunx tsc --noEmit      # typecheck
bunx drizzle-kit push  # apply schema to whatever DATABASE_URL points at
```

## Agency boundary — do not cross it

MetaConsole belongs to **DOT Agency**, which runs on the DigitalOcean droplet. The separate Hetzner
box hosts **PetalPixel** projects (a Telegram bot, a Meta ads uploader, fbtools, n8n, WatchTower, a
task manager). **The two must never be interlinked** — no reads, no syncs, no shared identity.

In scope: this app, the Notion campaigns board (`dotaudiences` workspace), and the Base44 Asset
Library at `library.dotaudiences.com` (read-only). Everything else is out of scope regardless of how
convenient it looks.

## Git

- **`feat/meta-integration` is trunk.** `main` is a stale ancestor left behind in June 2026; do not
  target it. Both operators work on the trunk branch directly.
- **Rebase before every push:** `git pull --rebase origin feat/meta-integration`. Two people
  auto-committing to one branch otherwise produces non-fast-forward rejections. **Never force-push**
  — it silently erases the other operator's work.
- Cut a short-lived branch for anything multi-file or risky, and merge it back yourself.
- **Remotes — push to `origin` AND `droplet` for anything you intend to deploy.** They serve
  different purposes and neither substitutes for the other:
  - `origin` (GitHub) — the collaboration source of truth. This is what the other operator pulls.
  - `droplet` (`ssh://…/opt/meta.git`, a bare repo on the server) — **the only path code takes onto
    the server.** The deployed checkout's own `origin` is that bare repo, _not_ GitHub, and there is
    no hook. Push to GitHub alone and the server sees nothing.
  - `madsmonitor` — a code mirror pushed by the maintainer only; it needs a separate key, so do not
    expect it to work from every machine.

  Because forgetting the `droplet` push deploys stale code while reporting success, always pass
  `EXPECT` when deploying (see below) — it turns that mistake into a hard failure.

- **Stage explicitly — never `git add -A` or `git add .`** Scratch files (`.tmp-*.ts`, screenshots,
  local notes) are not all gitignored, and one careless commit puts them in three remotes.
- Conventional commit messages. Explain _why_ in the body when the reasoning is not obvious from the
  diff; the interesting commits here are the ones that correct a wrong assumption.

## Deploying

One command, from either operator. Always pass the commit you expect to ship:

```bash
git push origin feat/meta-integration && git push droplet feat/meta-integration
ssh <droplet> "EXPECT=$(git rev-parse HEAD) bash /opt/meta-dashboard/deploy/deploy.sh"
```

The script takes a lock, fast-forwards the checkout, aborts if the result is not `EXPECT`, reinstalls
dependencies only if the manifest moved, builds, restarts both services, and fails loudly if health
does not come back. Deploying by hand is what it replaces: there is a single checkout and a single
`.output/`, and `meta-web` boots directly from `.output/server/index.mjs`, so two overlapping deploys
can restart onto a half-written build.

_Worth fixing properly at some point:_ point the server checkout's `origin` at GitHub with a deploy
key, so one push is enough and the bare repo stops being a second source of truth. That needs a
deploy key added on the GitHub side, so it is a deliberate change rather than something to do in
passing.

Docs-only changes need no deploy. `meta-sync` **does** need the restart whenever sync or job code
changes — it is long-lived and only picks up new code on restart.

## Databases — read this before running anything

**There is no local database.** `DATABASE_URL` in local dev points at the _production_ Postgres
through an SSH tunnel:

```bash
ssh -N -L 127.0.0.1:5432:127.0.0.1:5432 <droplet>
```

Every query you run locally hits production. There is no staging copy. Treat destructive SQL,
migrations and one-off scripts accordingly.

**`bun test` truncates tables.** `test-setup.ts` redirects `DATABASE_URL` to `TEST_DATABASE_URL`, and
the DB-backed tests truncate and insert. **Each operator needs their own test database** — sharing
one produces failures that do not reproduce and corrupts whichever run finishes second:

```bash
ssh <droplet> "sudo -u postgres createdb -O meta meta_test_<yourname>"
DATABASE_URL='postgres://meta:PASSWORD@127.0.0.1:5432/meta_test_<yourname>' bunx drizzle-kit push
# then set TEST_DATABASE_URL to that URL in your local .env
```

DB-backed tests are slow over the tunnel — pass `--timeout 60000` or they fail on latency alone,
which looks exactly like a real failure.

**Secrets** live only in `.env` (gitignored, with `.env.example` as the tracked template). Share them
through a password manager, never through git, chat, or a commit.

## Two frontends, one backend

The frontend is moving to **Base44**; the backend stays here. Every backend operation is an **op**
in `src/server/api/ops/*.ts`, and both frontends dispatch through the same ones:

- the in-repo TanStack UI, via the `createServerFn` wrappers in `src/lib/api/*.ts`, which are now
  nothing but `.handler(({ data }) => ops.someOp.run(data))`;
- the Base44 SPA, via `POST /api/v1/<op>` in `src/server/api/http.ts`.

So: **add a backend operation as an op, never as a server fn**. A wrapper that calls a delegate
directly is invisible to Base44, and logic put in a wrapper dies with that frontend — which is
exactly what nearly happened to `getBreakdowns`' client→accountIds lookup and to the superadmin
gates that used to live in `src/lib/api/{finance,conversations}.ts`.

### Three frontends now, and two of them are customer-facing

A **second** Base44 app (`6a91757327c7555d5f5a8f91`, "DotAnalytics") serves the agency's _customers_.
It reaches the same ops through the same `/api/v1/invoke`, but the audience is chosen by **which
bearer secret arrives** — not by a role on the caller:

| secret             | audience | reachable ops      | identity table |
| ------------------ | -------- | ------------------ | -------------- |
| `VPS_API_TOKEN`    | staff    | all of them        | `users`        |
| `PORTAL_API_TOKEN` | customer | **`portal*` only** | `portal_users` |

**The `portal` prefix IS the allowlist.** Name a staff op `portalSomething` and you have just
published it to every customer. `src/server/api/ops/portal-admin.ts` throws at module load if a
staff op name starts with it, and `src/server/api/portal-surface.test.ts` asserts the set of
`portal*` ops equals an exact list — so widening the customer surface is a reviewed line in a diff,
never an accident. Do not relax either guard.

Why customers are not just rows in `users`: `provisionFederatedUser()` CREATES a `users` row for
any email the proxy asserts, and `approved` is one flag that unlocks all ~100 ops — including the 28
that carry no authorisation check of their own, because the cookie gate was always in front of them.
Approving a customer there would hand them the agency's numbers. `portal_users` auto-creates
nothing and refuses an unknown email.

Three things must never reach a customer, and each is enforced in code rather than by review:

- **Raw spend and the commission rate.** `src/portal/markup.ts` folds the rate into `spend` on each
  daily campaign row _before_ aggregation, so every derived cost metric is consistent and there is
  no list of "cost keys" to keep in step. Aggregating raw and multiplying at the end is the shape
  that silently reports true cost for whichever metric someone adds next. Raw spend does not
  survive `markupRows()`, and no frontend performs markup arithmetic.
- **A campaign name that names somebody else.** The client-facing name DEFAULTS to `campaigns.name`
  — the owner's call, and true of most of them, which were written for a human to read. The tail is
  not: of 628 campaigns, 99 carry a " - Copy" suffix, 38 are opaque ids, 13 are Meta's placeholder
  text, and 2 embed a URL — one of them a competitor's tracking domain.
  `src/portal/name-review.ts` flags exactly those so an operator overrides the name or sets
  `hidden`; agency strategy vocabulary ("prospecting", "lookalike") is deliberately not flagged,
  because flagging 54 rows nobody would act on teaches people to ignore the flag.

  A naive check said 4 campaigns named a DIFFERENT client. They do not: `SweatBet - PWA` and
  `Betheboss CA …` sit on shared accounts, and the ownership ladder attributes them by brand name
  to SweatBet and Playw3 — their own clients. The 4 came from joining account → client through
  `notion_account_ids`, which is the naive attribution this file warns about two bullets down. The
  flag resolves the owner with `loadCampaignOwnership()` and correctly reports none, which is also
  a reminder that any new cross-client check has to go through that ladder or it will lie.
  `portal_campaigns.alias` is the override, and `hidden` is the only way to withhold a campaign.

- **Another client's anything.** Scope resolves through `ownedCampaignIds()` into an explicit
  campaign whitelist (`src/portal/scope.ts`); an empty scope returns no rows, never "no filter".
  Portal ops read `level = 'campaign'` insight rows only — the one grain at which both markup and
  ownership are well defined.

The customer app also contains the agency's admin UI, at its owner's request, so it holds
`VPS_API_TOKEN` too behind a `staff` backend function that requires the Base44 role `admin`. That
role check is load-bearing, not decoration: without it, forwarding a customer's request would enrol
every customer in the staff `users` table via `provisionFederatedUser()`. See
`base44-portal/README.md`.

Op names are the historical server-fn export names (`getOverview`, `saveInfraProfile`) in one flat
namespace. `src/server/api/ops/index.ts` builds the table by walking module namespaces — **not** by
side effect. `package.json` sets `"sideEffects": false`, so `import "./ops"` for registration was
silently dropped by the bundler and shipped an empty registry in `.output/` while every in-process
test passed. New module under `ops/` ⇒ add it to `MODULES`; `registry.test.ts` fails if you forget.

`.inputValidator` in `src/lib/api/*.ts` is a **type annotation, not validation** — it always was
(`(d: T) => d`). Real zod schemas live on the ops, so both transports validate.

Auth works on both transports because `currentUser()` reads an actor context
(`src/lib/auth/actor.ts`) before falling back to the session cookie. `requireAdmin()`,
`requireApproved()`, `requireUser()` and `audit()` therefore need no transport-specific branches.
Base44 asserts identity only; role, approval status and the audit trail stay in Postgres. See
`base44/README.md`.

`VPS_API_TOKEN` gates the API and is database-equivalent — Base44 backend-function secrets only,
never frontend code, HTTPS only (the API returns `403 insecure_transport` over plaintext in
production). Unset it and `/api/v1/*` answers `503`; it never falls open.

## Verifying before you claim something works

- `bunx tsc --noEmit` and `bun run lint` must be clean.
- Run the tests that cover what you changed, not the whole suite (it is slow over the tunnel).
- For behaviour changes, exercise the actual path — a passing unit test on a pure helper does not
  prove the job writes the right number. Prefer running the job and reading the result back.
- Beware verifying only the easy cases. A budget calculation that was correct on three
  single-account clients was wrong by 71× on the multi-account ones; the passing check hid it.

## Invariants worth not breaking

- **Meta is the system of record.** Notion and every other system mirror it. Columns prefixed `🤖`
  on the Notion board are machine-owned and written only for _live_ engagements; a finished or paused
  row keeps whatever the team recorded, because its ad accounts get recycled onto the next client.
- **A campaign's `effective_status` does not mean it can spend.** Meta stops delivery at the account
  level when an account is disabled or its prepaid `spend_cap` is exhausted, and leaves campaigns
  reporting ACTIVE. Gate any budget or delivery figure through `canDeliver()`.
- Normalise Meta account status codes with `accountStatus()` from `src/server/agg.ts` — never compare
  raw codes.
- Client ↔ campaign ownership goes through `ownedCampaignIds()` / `clientCampaignScope()`. Shared and
  recycled ad accounts make naive account-based attribution wrong; do not reinvent it.
- **No `any`.** Validate unknown input or use a domain type.
- Ad-account ids are `act_<digits>` everywhere and are the join key across systems.
