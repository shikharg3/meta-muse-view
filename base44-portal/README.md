# Client portal — Base44 frontend ↔ VPS portal API

The agency's customers log into a **second, separate Base44 app**. This directory is the source of
truth for the code that lives inside it; `base44/` next door does the same job for the internal app.

```
Customer's browser ──invoke──▶ base44/functions/portal ──Bearer──▶ VPS /api/v1/invoke
   (DotAnalytics SPA)           (Deno, holds PORTAL_API_TOKEN)      (portal* ops only)
```

## Two apps, two tokens, one API

|                | internal                              | client portal                             |
| -------------- | ------------------------------------- | ----------------------------------------- |
| Base44 app     | `6a9fc1bd1da17a04aaf31ecc` (MetaMuse) | `6a91757327c7555d5f5a8f91` (DotAnalytics) |
| slug           | `analytic-meta-muse-view`             | `wakeful-data-pulse-view`                 |
| function       | `vps`, `vps-stream`                   | `portal`                                  |
| secret         | `VPS_API_TOKEN`                       | `PORTAL_API_TOKEN`                        |
| ops reachable  | all of them                           | **only `portal*`**                        |
| identity table | `users` (staff)                       | `portal_users` (customers)                |

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

- **Raw spend.** Commission is folded into `spend` on each daily campaign row _before_ aggregation,
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

## Onboarding a client — the required sequence

**The portal is empty until someone does this, and that is deliberate.** Every gate fails closed,
so a half-finished setup shows a client nothing rather than showing them something wrong. All of it
happens in the customer app's own `/admin` section, signed in as a Base44 user whose role is
`admin`.

1. **Create the brand.** `/admin` → Brands → _Create brand_. Pick the agency client it belongs to,
   give it the name and website **the client should see**, and set the monthly budget — that figure
   is what the portal's pacing compares marked-up spend against, so it must be in client-facing
   money. Leave the default commission blank to fall back to `PORTAL_DEFAULT_COMMISSION` (10%).
2. **Map its ad accounts.** Same screen. Accounts are read-only — they arrive from the Meta sync and
   cannot be created by hand. The mapping is what turns accounts into a brand.
3. **Name every campaign the client should see.** `/admin` → Campaigns. **A campaign with no alias
   is invisible to the client.** This is the step people forget, and it is the one that cannot be
   defaulted: `campaigns.name` encodes the account, objective and buying strategy, so falling back
   to it would leak the internal naming convention. The screen marks unnamed campaigns explicitly.
4. **Set commission, if it differs.** Campaigns → the commission cell. Each entry is a rate that
   applies from a date onwards; the period's end is derived from the next entry, so periods cannot
   overlap or contradict. Editing history re-prices past days, which is the point — a report re-run
   for an old month must still say what it said.
5. **Invite the client.** `/admin` → Users → invite. The email **must match their Base44 login
   address exactly**; an unknown address is refused rather than created. Then set them `approved` —
   pending grants nothing at all, not even a read.
6. **Grant access.** Whole brand (every campaign it owns, now and in future) or individual
   campaigns. A grant pointing at a campaign the brand's client no longer owns is ignored, so a
   recycled ad account cannot hand a client somebody else's history.

The client then signs in at the portal URL with that address. Until step 5 they see
"you're signed in — no data linked yet"; until step 3 they see a brand with no campaigns.

To revoke: remove the grant (immediate), or set the user `rejected`, or delete them — deleting
cascades their grants. Deleting a brand also deletes grants pointing at it, because
`portal_grants.target_id` deliberately carries no foreign key.

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

| this repo (source of truth for review)    | the Base44 sandbox                 |
| ----------------------------------------- | ---------------------------------- |
| `base44-portal/functions/portal/entry.ts` | `base44/functions/portal/entry.ts` |
| `base44-portal/client/portal.js`          | `src/api/portal.js`                |

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
