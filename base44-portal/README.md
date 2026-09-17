# Client portal — Base44 frontend ↔ VPS portal API

The agency's customers log into a **second, separate Base44 app**. This directory is the source of
truth for the code that lives inside it; `base44/` next door does the same job for the internal app.

```
Customer's browser ──invoke──▶ base44/functions/portal ──Bearer──▶ VPS /api/v1/invoke
   (DotAnalytics SPA)           (Deno, holds PORTAL_API_TOKEN)      (portal* ops only)
```

## Two apps, two tokens, one API

|                 | internal                              | client portal                             |
| --------------- | ------------------------------------- | ----------------------------------------- |
| Base44 app      | `6a9fc1bd1da17a04aaf31ecc` (MetaMuse) | `6a91757327c7555d5f5a8f91` (DotAnalytics) |
| slug            | `analytic-meta-muse-view`             | `wakeful-data-pulse-view`                 |
| function        | `vps`, `vps-stream`                   | `portal`                                  |
| secret          | `VPS_API_TOKEN`                       | `PORTAL_API_TOKEN`                        |
| ops reachable   | all of them                           | **only `portal*`**                        |
| identity table  | `users` (staff)                       | `portal_users` (customers)                |

`src/server/api/http.ts` picks the audience from **which secret arrives**, not from a role on the
caller. That is the entire boundary, and it is why the portal app is safe to publish: it cannot
address `getFinance`, `listUsers` or `resetAndResync` — those ops are unaddressable with its token,
not merely forbidden. The two tokens must differ; the transport refuses to start a request if they
are equal, because the staff comparison runs first and would silently promote every customer.

## Why the portal does not reuse `users` / `approved`

The staff path calls `provisionFederatedUser()`, which **creates** a `users` row for any email the
proxy asserts, `pending`. That is right for a colleague's first sign-in. It is wrong for a
customer-facing app: it would fill the internal Users page with customers, and `approved` is a
single binary flag that unlocks all ~100 ops — including the 28 that carry no authorisation check of
their own, because the cookie gate was always in front of them. Approving a customer there would
hand them the agency's own numbers.

So portal identity is its own table, nothing is auto-created, and an unknown email is refused.
Authorisation is `portal_grants` → `brands` → `brand_accounts` → `ownedCampaignIds()`, resolved in
`src/portal/scope.ts` into an explicit campaign **whitelist**. An empty scope returns no rows.

## What a customer must never receive

Enforced in `src/portal/markup.ts` and `src/portal/scope.ts`, not by reviewer discipline:

- **Raw spend.** Commission is folded into `spend` on each daily campaign row *before* aggregation,
  so every derived cost metric is consistent and there is no list of "cost keys" to forget.
- **The commission rate itself.** It exists server-side only.
- **`campaigns.name`.** The internal Meta name encodes account, objective and buying strategy. The
  portal renders `portal_campaigns.alias`; a campaign with no alias is invisible rather than falling
  back to the internal name.
- **Another client's anything.** Shared and recycled ad accounts make account-based attribution
  wrong, so ownership always resolves through `ownedCampaignIds()`.

`src/server/api/portal-surface.test.ts` asserts the set of `portal*` ops is **exactly** an expected
list. Widening the customer-reachable surface therefore has to be a reviewed line in a diff. Staff
ops that administer the portal must NOT be named `portal*` — that prefix is the allowlist.

## No streaming sibling

The internal app has `vps-stream` for the AI assistant. There is deliberately no portal equivalent:
the assistant's tools read finance, infrastructure and every client. A portal assistant needs its
own scoped tool set before it gets a transport.

## Pushing a change

Writing the file into the sandbox **is** the deploy (auto-committed ~5s). Never run `base44 deploy`,
`functions deploy`, `create` or `scaffold` against it.

```bash
export BASE44_APP_ID=6a91757327c7555d5f5a8f91
cat base44-portal/functions/portal/entry.ts \
  | base44 sandbox write base44/functions/portal/entry.ts --overwrite --app-id "$BASE44_APP_ID" --json
cat base44-portal/client/portal.js \
  | base44 sandbox write src/api/portal.js --overwrite --app-id "$BASE44_APP_ID" --json
```

| this repo (source of truth for review)      | the Base44 sandbox                |
| ------------------------------------------- | --------------------------------- |
| `base44-portal/functions/portal/entry.ts`   | `base44/functions/portal/entry.ts` |
| `base44-portal/client/portal.js`            | `src/api/portal.js`               |

Secrets are already set on the app (`PORTAL_API_URL`, `PORTAL_API_TOKEN`). To rotate: change
`/opt/meta-next/.env`, `systemctl restart meta-web-next`, then re-set the Base44 secret.

```bash
BASE44_APP_ID=6a91757327c7555d5f5a8f91 base44 secrets list
```

## Deploying the server side

The portal API runs in the **staging** checkout, so `deploy.sh` needs its unit list and health
target overridden — it defaults to the live pair:

```bash
git push origin feat/base44-api && git push droplet feat/base44-api
ssh <droplet> "EXPECT=$(git rev-parse HEAD) APP_DIR=/opt/meta-next BRANCH=feat/base44-api \
  SERVICES=meta-web-next HEALTH=http://127.0.0.1:8789/login bash /opt/meta-next/deploy/deploy.sh"
```

`meta-sync` is deliberately not in that list: two workers would race on the same upsert keys and
split the Meta rate-limit budget. The single live worker keeps ingesting and the portal reads what
it writes.
