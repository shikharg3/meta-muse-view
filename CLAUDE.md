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
    the server.** The deployed checkout's own `origin` is that bare repo, *not* GitHub, and there is
    no hook. Push to GitHub alone and the server sees nothing.
  - `madsmonitor` — a code mirror pushed by the maintainer only; it needs a separate key, so do not
    expect it to work from every machine.

  Because forgetting the `droplet` push deploys stale code while reporting success, always pass
  `EXPECT` when deploying (see below) — it turns that mistake into a hard failure.
- **Stage explicitly — never `git add -A` or `git add .`** Scratch files (`.tmp-*.ts`, screenshots,
  local notes) are not all gitignored, and one careless commit puts them in three remotes.
- Conventional commit messages. Explain *why* in the body when the reasoning is not obvious from the
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

*Worth fixing properly at some point:* point the server checkout's `origin` at GitHub with a deploy
key, so one push is enough and the bare repo stops being a second source of truth. That needs a
deploy key added on the GitHub side, so it is a deliberate change rather than something to do in
passing.

Docs-only changes need no deploy. `meta-sync` **does** need the restart whenever sync or job code
changes — it is long-lived and only picks up new code on restart.

## Databases — read this before running anything

**There is no local database.** `DATABASE_URL` in local dev points at the *production* Postgres
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

## Verifying before you claim something works

- `bunx tsc --noEmit` and `bun run lint` must be clean.
- Run the tests that cover what you changed, not the whole suite (it is slow over the tunnel).
- For behaviour changes, exercise the actual path — a passing unit test on a pure helper does not
  prove the job writes the right number. Prefer running the job and reading the result back.
- Beware verifying only the easy cases. A budget calculation that was correct on three
  single-account clients was wrong by 71× on the multi-account ones; the passing check hid it.

## Invariants worth not breaking

- **Meta is the system of record.** Notion and every other system mirror it. Columns prefixed `🤖`
  on the Notion board are machine-owned and written only for *live* engagements; a finished or paused
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
