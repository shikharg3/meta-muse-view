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

## Vocabulary: the console's words are not the schema's

| admin console says | schema / code                                                     | what it is                                    |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------- |
| **Owner**          | `clients` row                                                     | the agency's customer on the Notion board     |
| **Client**         | `brands` row                                                      | one portal: what a login is granted, as a set |
| **Brand**          | a Notion board row ("project") in `clients.raw`, keyed by page id | one engagement, with its own ad accounts      |

Grant scopes keep the code names: `brand` = a whole Client, `project` = one Brand held **through**
a Client (`parent_id` = the `brands` id — the same board row covered by two Clients is two grants),
`campaign` = one campaign.

A campaign counts under exactly one Brand of a Client: the **newest** board row (board order is
newest first) whose accounts include its account — boards reuse one account for each month's
engagement (`projectOfAccount`, `src/portal/brand-accounts.ts`). That Brand's settings apply to it,
and a Brand grant opens exactly those campaigns. An older row sharing the account shows a "shared
with a newer brand" marker on the Client page, because its settings do not reach them.

The customer portal uses the same meaning: its "All your brands" picker, the `brandIds` filter on
every `portal*` op, a campaign row's `brandId` and the report's per-brand totals are all Brands
(board rows, by page id — `portalBrandOf` in `src/portal/scope.ts`), named by the row's title. A
campaign on an account no covered row lists falls back to its Client, so the Brands always add up
to the whole.

## What a customer must never receive

Enforced in `src/portal/markup.ts` and `src/portal/scope.ts`, not by reviewer discipline:

- **Raw spend.** Commission is folded into `spend` on each daily campaign row _before_ aggregation,
  so every derived cost metric is consistent and there is no list of "cost keys" to forget.
- **The commission rate itself.** It exists server-side only.
- **A campaign name that names somebody else.** The client-facing name defaults to `campaigns.name`,
  which is fine for most of them. `src/portal/name-review.ts` flags the tail that is not — a
  " - Copy" suffix (99 of 628), an opaque id (38), Meta's placeholder text (13), an embedded URL
  (2, one a competitor's tracking domain), or a name mentioning a DIFFERENT client. None currently
  do: the ones that look like it sit on shared accounts and are attributed to the client they name,
  through the ownership ladder rather than through their ad account. `portal_campaigns.alias`
  overrides the name; `hidden` is the only way to withhold a campaign.
- **Another client's anything.** Shared and recycled ad accounts make account-based attribution
  wrong, so ownership always resolves through `ownedCampaignIds()`.

`src/server/api/portal-surface.test.ts` asserts the set of `portal*` ops is **exactly** an expected
list. Widening the customer-reachable surface therefore has to be a reviewed line in a diff. Staff
ops that administer the portal must NOT be named `portal*` — that prefix is the allowlist.

## Onboarding a client — the required sequence

**The portal shows a client nothing until someone does this**, and every gate fails closed, so a
half-finished setup shows them nothing rather than something wrong. All of it happens in the
customer app's own admin console at `/admin`, signed in as a Base44 user whose role is `admin`. Its
Home page lists these steps with a link to each, and flags anything a half-finished setup left
behind under _Needs attention_.

In practice it is two steps: add a client, and grant the login access. Everything in between has
a working default.

1. **Add the client.** `/admin/brands` → _Add client_. Pick the owner; its Notion brands appear
   **already selected**, and the ad accounts follow from them — there is nothing to map by hand.
   Leaving every brand selected stores "follow this owner", so a row added to the board next month
   is included by itself. Nothing is typed in: the name is the owner's and the default commission
   is stored as `PORTAL_DEFAULT_COMMISSION` (10%). There is no website or monthly budget any more
   (the columns are retired, and the portal's pacing stat with them).
   Then, on the client's page, set its **Client defaults** — commission and **Ad page** (the page
   name and profile photo every creative preview shows as the advertiser, whichever Facebook page
   each ad really ran under; blank falls back to the client name and initials; the photo is
   uploaded to Base44's public storage and must be https). Each **Brand** below can override the
   ad page and/or commission field by field (`portal_project_settings`, keyed by Notion page id);
   anything it leaves blank inherits the client's value.
2. **Check the campaign names.** `/admin/campaigns`. Names default to Meta's own, so a client can
   already see everything — you do not have to name anything for the portal to work. What you
   should do once is filter to **"Needs a look"** and deal with the flagged handful: a name carrying
   a " - Copy" suffix, an opaque id, Meta's placeholder text, or — the one that matters — a name
   mentioning another client. Edit those in place and save the screen in one go, or set `hidden` on
   anything the client should not see at all.
3. **Set commission, if it differs.** A campaign's rate resolves as: its own dated history
   (Campaigns → the commission cell), else its Brand's commission, else the Client default, else
   10%. Each history entry applies from a date onwards; the period's end is derived from the next
   entry, so periods cannot overlap. Editing history re-prices past days, which is the point — a
   report re-run for an old month must still say what it said.
4. **Invite the login.** `/admin/users` → _Invite user_. This records the address in
   `portal_users` and then asks Base44 to email the person: with no password, Base44's own invite
   email (`users.inviteUser`); with a password the admin types, `auth.register` creates the account
   and Base44 emails a one-time code the person enters once at first sign-in (the login screen has
   a "Have a verification code?" step). Base44 has no way to set an already-verified password. The
   Mail button on a row re-sends the invite. The email **must match their Base44 login address
   exactly**; an unknown address is refused rather than created. Then set them `approved` —
   pending grants nothing at all, not even a read.
5. **Grant access.** A row's _Manage access_ lists every Client, its Brands and their campaigns: a
   whole Client (every campaign it owns, now and in future), one Brand, or single campaigns. A
   grant pointing at a campaign the Client's owner no longer owns is ignored, and so is a Brand
   grant whose Client no longer covers that board row, so a recycled ad account cannot hand a
   login somebody else's history.

The client then signs in at the portal URL with that address. Until step 4 they see "you're signed
in — no data linked yet".

Steps 2 and 3 are optional — names and commission both have defaults that work. If the client's
Notion board has no ad accounts on it yet, the brand screen says so and data appears as soon as
the board is filled in.

A client's campaign list holds only the campaigns that DELIVERED in the window they are looking
at. Meta keeps every campaign ever created on an account, so a grant covering 34 campaigns
typically means 6 that ran and 28 abandoned drafts and duplicates; listing all of them is noise,
and Ads Manager hides no-delivery campaigns by default too. The rule is "no delivery", not "no
spend" — a campaign with any figure the portal also sums stays on the list, so the table's columns
always add up to the overview's totals. An unfiltered whole-range report follows the same rule;
asking a report about specific campaigns still returns their zeroes, because that is the answer.
Campaign detail pages stay reachable either way, so an old link never 403s.

To revoke: remove the grant (immediate), or set the user `rejected`, or delete them — deleting
cascades their grants. Deleting a client also deletes the grants pointing at it and the Brand
grants held through it, because `portal_grants.target_id` / `parent_id` deliberately carry no
foreign key.

## Viewing the portal as a client

`/admin` → _View as client_ in the header, or the eye button on a Portal users row, opens the real
portal as that login — the same brands, campaigns, client-facing names and marked-up figures —
with a banner and an Exit. A pending or rejected login previews as the screen that login gets.

- **It is a staff op, not a portal-transport field.** Every portal call is routed through
  `viewPortalAs` (`src/server/api/ops/portal-admin.ts`) on the `staff` function, so it needs the
  staff token, the Base44 `admin` role and `requireAdmin()` — the client token cannot address it.
  Letting the portal transport accept "act as this address" would make identity a request field
  on the one surface a customer can reach.
- **It dispatches only `portal*` ops**, and runs them the way the portal transport does: same actor
  resolution, same approval floor, staff context explicitly empty. `src/server/api/view-as.test.ts`
  pins its op set to exactly the client-reachable one.
- **The client's `last_seen_at` is left alone**, because the admin console reports it as client
  activity. One `portal.view_as` audit entry is written per preview (on `portalBootstrap`).
- **The preview lives in the admin's browser tab** (`sessionStorage`). Entering and leaving reload
  the page, so no cached figure crosses between the admin's own view and the client's; opening
  the admin console or signing out ends it.

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
| `base44-portal/client/viewAs.js`          | `src/lib/viewAs.js`                |
| `base44-portal/client/staff.js`           | `src/api/staff.js`                 |

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
