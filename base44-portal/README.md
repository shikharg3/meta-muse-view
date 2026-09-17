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
- **A campaign name that names somebody else.** The client-facing name defaults to `campaigns.name`,
  which is fine for most of them. `src/portal/name-review.ts` flags the tail that is not — a
  " - Copy" suffix, an opaque id, Meta's placeholder text, an embedded URL, or a name mentioning a
  DIFFERENT client (4 campaigns do, one with a competitor's tracking URL). `portal_campaigns.alias`
  overrides the name; `hidden` is the only way to withhold a campaign.
- **Another client's anything.** Shared and recycled ad accounts make account-based attribution
  wrong, so ownership always resolves through `ownedCampaignIds()`.

`src/server/api/portal-surface.test.ts` asserts the set of `portal*` ops is **exactly** an expected
list. Widening the customer-reachable surface therefore has to be a reviewed line in a diff. Staff
ops that administer the portal must NOT be named `portal*` — that prefix is the allowlist.

## Onboarding a client — the required sequence

**The portal shows a client nothing until someone does this**, and every gate fails closed, so a
half-finished setup shows them nothing rather than something wrong. All of it happens in the
customer app's own `/admin` section, signed in as a Base44 user whose role is `admin`.

In practice it is two steps: create a brand, and grant the client access. Everything in between has
a working default.

1. **Create the brand.** `/admin` → Brands → _Create brand_. Pick the agency client; its Notion
   projects appear **already selected**, and the ad accounts follow from them — there is nothing to
   map by hand. Leaving every project selected stores "follow this client", so an engagement it
   wins next month is included by itself. Give the brand the name and website **the client should
   see**, and set the monthly budget in client-facing money, since that is what the portal's pacing
   compares marked-up spend against. Leave the default commission blank to fall back to
   `PORTAL_DEFAULT_COMMISSION` (10%).
2. **Check the campaign names.** `/admin` → Campaigns. Names default to Meta's own, so a client can
   already see everything — you do not have to name anything for the portal to work. What you
   should do once is filter to **"Needs a look"** and deal with the flagged handful: a name carrying
   a " - Copy" suffix, an opaque id, Meta's placeholder text, or — the one that matters — a name
   mentioning another client. Edit those in place and save the screen in one go, or set `hidden` on
   anything the client should not see at all.
3. **Set commission, if it differs.** Campaigns → the commission cell. Each entry is a rate that
   applies from a date onwards; the period's end is derived from the next entry, so periods cannot
   overlap or contradict. Editing history re-prices past days, which is the point — a report re-run
   for an old month must still say what it said.
4. **Invite the client.** `/admin` → Users → invite. The email **must match their Base44 login
   address exactly**; an unknown address is refused rather than created. Then set them `approved` —
   pending grants nothing at all, not even a read.
5. **Grant access.** Whole brand (every campaign it owns, now and in future) or individual
   campaigns. A grant pointing at a campaign the brand's client no longer owns is ignored, so a
   recycled ad account cannot hand a client somebody else's history.

The client then signs in at the portal URL with that address. Until step 4 they see "you're signed
in — no data linked yet".

Steps 2 and 3 are optional — names and commission both have defaults that work. If the client's
Notion board has no ad accounts on it yet, the brand screen says so and data appears as soon as
the board is filled in.

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
