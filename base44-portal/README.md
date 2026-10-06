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
| function       | `vps`, `vps-stream`                   | `portal`, `portal-stream`                 |
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

| admin console says | schema / code                                                | what it is                                    |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------- |
| **Owner**          | `clients` row                                                | the agency's customer on the Notion board     |
| **Client**         | `brands` row                                                 | one portal: what a login is granted, as a set |
| **Brand**          | a group of an owner's Notion board rows (`projectGroups`)    | one brand, across all its engagements         |
| **Engagement**     | one board row ("project") in `clients.raw`, keyed by page id | one month/campaign run, with its ad accounts  |

Board rows group into Brands by title automatically: the first word, without a URL scheme or domain
ending (`autoGroupKey` in `src/portal/brand-accounts.ts`) — so `betonline.ag (August/September)`
and `betonline.ag (June 2026)` are Brand "betonline.ag", and `Watt2Trade Renewal May 2026` joins
`watt2trade.com`. On the Client page an admin can rename a Brand, move a row into another Brand or a
new one, or send it back to automatic (`portal_project_settings.group_key`). A Brand's own name and
ad page live in `portal_group_settings`, and its commission schedule in `commission_defaults`
(`target_id` = `<owner>:<group key>`), both keyed by owner + group key, so next month's row joins
the Brand and gets its settings with nothing re-set.

Grant scopes keep the code names: `brand` = a whole Client, `group` = one Brand held **through** a
Client (`target_id` = `<owner>:<group key>`, `parent_id` = the `brands` id), `campaign` = one
campaign.

A campaign counts under exactly one board row of a Client: the **newest** row (board order is
newest first) whose accounts include its account — boards reuse one account for each month's
engagement (`projectOfAccount`). Its Brand is that row's group; that Brand's settings apply, and a
Brand grant opens it. A Brand whose rows share an account with a newer row of ANOTHER Brand shows a
"shared with a newer brand" marker, because its settings do not reach those campaigns.

The customer portal uses the same meaning: its "All brands" picker, the `brandIds` filter on
every `portal*` op, a campaign row's `brandId` and the report's per-brand totals are all Brands
(groups, by `<owner>:<group key>` — `portalBrandOf` in `src/portal/scope.ts`). A campaign on an
account no covered row lists falls back to its Client, so the Brands always add up to the whole.

`portalBootstrap` lists both levels, and the portal words them the customer's way — a Client is
their "client", a Brand their "brand":

```ts
{
  user: { name: string | null; email: string },
  freshness: { syncedAt: string | null; completeThrough: string | null },
  clients: { id: string /* brands.id */; name: string }[], // by name; only those a brand is under
  brands: { id: string; name: string; clientId: string /* one of clients[].id */ }[], // by name
}
```

A Brand is listed under the Client it is reached through; one reached through two of the
customer's Clients appears once, under the first by name (`portalBrands`). The fallback entry has
`id === clientId` and is shown as that client's "Other campaigns", not as a brand named after the
client. Only ids and names cross: no commission, ad account or owner id.

The portal opens on every brand combined, and says so: the brand picker shows a layered icon and
a count, a strip under the top bar reads "Combined results for N brands across M clients" with
one-click picks, and the overview headline names the scope. The picker groups brands under their
clients when there are several (a client header selects that whole client; each brand has an
"Only" action). A single-brand customer sees neither picker nor strip. Opening a campaign shows
that campaign's own figures without changing the portal-wide selection.

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
customer app's own admin console at `/admin`, signed in as a Base44 user whose role is `admin`.
Each client's page opens on a **Setup** checklist (ad accounts found, campaigns ran in the last 30
days, names checked, someone can see it, someone has signed in) with the fix beside each open step,
and Home's _Client setup_ lists every client still missing one. _Needs attention_ flags the rest.

In practice it is two steps: add a client, and add a person to it. Everything in between has a
working default.

1. **Add the client.** `/admin/brands` → _Add client_. Pick the owner; its Notion brands appear
   **already selected**, and the ad accounts follow from them — there is nothing to map by hand.
   Leaving every brand selected stores "follow this owner", so a row added to the board next month
   is included by itself. Nothing is typed in: the name is the owner's, and a new client with no
   commission entry bills at `PORTAL_DEFAULT_COMMISSION` (10%). There is no website or monthly
   budget any more (the columns are retired, and the portal's pacing stat with them).
   Then, on the client's page, set its **Client defaults** — commission (_Change…_, see step 3) and
   **Ad page** (the page name and profile photo every creative preview shows as the advertiser,
   whichever Facebook page each ad really ran under; blank falls back to the client name and
   initials; the photo is uploaded to Base44's public storage and must be https). Each **Brand**
   below can override the ad page field by field (`portal_group_settings`) and has its own
   commission schedule; anything it leaves unset inherits the client's value. Check the grouping
   there too — rename a Brand, or move a row the title rule put in the wrong one.
2. **Check the campaign names.** `/admin/campaigns`. Names default to Meta's own, so a client can
   already see everything — you do not have to name anything for the portal to work. What you
   should do once is filter to **"Needs a look"** and deal with the flagged handful: a name carrying
   a " - Copy" suffix, an opaque id, Meta's placeholder text, or — the one that matters — a name
   mentioning another client. Edit those in place and save the screen in one go, or set `hidden` on
   anything the client should not see at all.
3. **Set commission, if it differs.** Three levels, each a dated schedule: the campaign's own
   (Campaigns → the commission cell), its Brand's (the Brand row on the client's page → _Change…_)
   and the Client default (_Client defaults_ → _Change…_), all stored server-side
   (`campaign_commissions`, `commission_defaults`). An entry applies **from its date, inclusive,
   until the next entry at the same level**; a day with no entry at a level falls to the level
   below as it stood **on that day** — campaign, then Brand, then Client, then 10%. So a change is
   made by adding an entry from the day it takes effect: "14% from 1 October" leaves September at
   whatever it billed and prices October onwards at 14%; "11% from 1 November" then lowers it from
   that day. Rates may go up or down (0–100%), any number of times, dated from 2020-01-01 up to a
   year ahead. A Brand or Client entry can also be _Inherit_, handing its days back to the level
   below from that date. Days before a campaign's first entry are never priced at that entry —
   they keep inheriting. Periods cannot overlap: each ends the day before the next begins. Editing
   or deleting an entry that has already started, or adding one dated in the past, re-prices those
   past days in the portal and in any report re-run for them — the dialog asks before it does. The
   dialog's timeline is resolved by the server (`effectiveTimeline`), the same rule `markupRows`
   bills by, and no rate ever reaches a portal response.
4. **Add a person.** The client page's _Add person_ (client already chosen), or `/admin/users` →
   _Add person_ (pick the client). Choose everything for the client — one whole-client grant, which
   also covers brands it gains later — or only some of its brands. `invitePortalUser` creates the
   `portal_users` row **already `approved`** together with those grants in one transaction (an
   invite is the admin's decision, so there is no separate approval step), then the console emails
   them our own invitation (`integrations.Core.SendEmail`, "You're invited to DOT Analytics") with a
   link to `/register?email=…` — the **set-up page**, where they choose a password (or use Google)
   and confirm the 6-digit code Base44 emails them. `SendEmail` reaches an address that has never
   signed up only because the app is on a paid plan with its own verified domain
   (`analytics.dotaudiences.com`). Base44's own invitation (`users.inviteUser`) is the fallback
   when ours cannot be sent: its only link is the site's home page, with no way to set a password,
   so it works only through the login page's _First time here? Set up your account_. The set-up
   page answers an address that already has an account with the ways in (log in, reset the
   password, or activate an account the admin created), so one email serves everyone. Links built
   from the editor's preview point at the published app. Typing an address that already has a
   login gives that login the access instead (and activates a not-activated one; a paused one
   stays paused until resumed); nobody is invited twice. The email **must match their Base44 login
   address exactly**; an unknown address is refused rather than created.

   _Advanced_ in the same form creates the account with a password the admin types: `auth.register`
   creates it and Base44 emails a bare 6-digit code — no link, no explanation — that must be entered
   once before the first sign-in. So the console also sends a setup email ("Activate your DOT
   Analytics account") with a link to `/activate?email=…` and the steps, optionally including the
   password. The activation page takes email, code and password on one screen, can email a fresh
   code, and signs them in. If an email fails, the form shows the same instructions to copy. Base44
   has no way to set an already-verified password.
5. **Adjust access later.** A row's _Manage access_ on Portal users lists every Client, its Brands
   and their campaigns: a whole Client (every campaign it owns, now and in future), one Brand, or
   single campaigns. A grant pointing at a campaign the Client's owner no longer owns is ignored,
   and so is a Brand grant whose Client no longer covers any of its rows, so a recycled ad account
   cannot hand a login somebody else's history.

The client then signs in at the portal URL with that address. The app is public with its own
login pages (`public_without_login`), so anyone can create an account on the set-up page — an
account nobody added sees "you're signed in — no data linked yet", because access is the
`portal_users` row, not the account.

Portal users shows each login as **Active** (has signed in), **Invited** (has not yet — the row's
send button resends the invitation the same way), **Paused**
(`rejected`: signs in to nothing until resumed) or **Not activated** (`pending`, only logins
invited before invites created them approved). Opening a row runs an **access check** in the
portal's own order — login on, access held, a visible campaign reached, one that ran in the last
30 days (the range the portal opens on), signed in — with the fix next to the first failure and a
_Preview as them_ button; a row whose check finds nothing to show carries a warning on its status.

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

To revoke: remove the grant (immediate), or pause the login (`rejected`), or delete it — deleting
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
  on the one surface a customer can reach. AI Intelligence turns, which stream, take the same gates
  through `staff-stream` instead (see the next section).
- **It dispatches only `portal*` ops**, and runs them the way the portal transport does: same actor
  resolution, same approval floor, staff context explicitly empty. `src/server/api/view-as.test.ts`
  pins its op set to exactly the client-reachable one.
- **The client's `last_seen_at` is left alone**, because the admin console reports it as client
  activity. One `portal.view_as` audit entry is written per preview (on `portalBootstrap`).
- **The preview lives in the admin's browser tab** (`sessionStorage`). Entering and leaving reload
  the page, so no cached figure crosses between the admin's own view and the client's; opening
  the admin console or signing out ends it.

## AI Intelligence — the portal assistant

Customers can ask about their results in plain English: _AI Intelligence_ in the sidebar (`/ai`),
with a suggestions strip on the Overview. It runs the internal Ask assistant's loop
(`runAgentLoop`, `src/server/agent/chat.ts`) with an injected tool set, prompt and context of its
own (`src/server/agent/portal/`) — not the internal assistant with a filter on top, whose tools
read finance, infrastructure and every client's raw spend.

```
browser ──fetch──▶ base44/functions/portal-stream ──Bearer PORTAL──▶ POST /api/v1/portal/chat/stream
 { brandId, messages }   (X-Actor-Email from auth.me())               (NDJSON, see below)
```

**One brand per turn, enforced on the VPS.**

- The request names a brand; `bindPortalBrand` (`src/server/agent/portal/tools.ts`) looks it up in
  the caller's OWN `portalBrands(portalScope(actor))` and answers `403 brand_forbidden` otherwise —
  not through `narrowToPortalBrands`, which reads an unknown id as "all brands". The scope is then
  narrowed to exactly that brand and verified to hold nothing else.
- The tools close over that narrowed scope. None takes a brand or client parameter; a campaign id
  the model passes is re-checked (`portalBrandOf(scope, id) === brand`). They read through the same
  `build*` functions as the pages (`src/server/fns/portal.ts`, `portal-creative.ts`,
  `portal-report.ts`), so every figure is marked up exactly as on screen; the module imports no
  commission loader. Tools: `get_overview` (KPI strip), `get_daily_trend` (chart), `list_campaigns`,
  `get_campaign` (ad-set spend flagged as an estimate), `get_breakdown`, `list_creatives` (copy and
  metrics, no media or landing URLs), `get_report` (with its correct total), `get_data_freshness`.
  Windows: `days` ≤ 400 or `since`/`until` spanning ≤ 400 days.
- The prompt is customer-facing and names only that brand; the per-turn context is today's date and
  the brand name. It refuses other brands, clients, the agency, commission and margins, and says
  nothing about internal systems. All money is USD.
- The conversation lives in the customer's tab (`sessionStorage`, one thread per brand). The server
  keeps no thread and accepts text only — no tool results come back from the browser.

**Events** (one JSON object per line): `status`, `tool_start`, `tool_end`, `delta`,
`cards {title, kpis}`, `series {title, unit, points}`, `done {toolCalls}`, `error {message}`. The
internal union's `start` and `report` never reach a customer, and `done` carries no cost
(`toCustomerEvent` in `src/server/agent/portal/turn.ts`). Refusals before the stream starts are the
usual `{ ok: false, error: { code, message } }`: `400 bad_request`, `403 brand_forbidden`,
`429 daily_limit`, `429 too_many_in_flight`.

**Guards.** At most 20 messages per request, the question ≤ 2,000 characters, any message ≤ 8,000
and all of them together ≤ 40,000; 5 model round-trips and 12 tool calls per turn; effort `medium`
on the configured model (Settings → Assistant, same key as the internal assistant — none configured
means a polite error event); 2 turns running at once per login; 40 turns per login per UTC day. A
turn is reserved before it streams: under a per-login advisory lock, today's `portal_chat_turns`
rows are counted and the turn's row inserted (`error = 'in_progress'`), then filled in with the
question's answer, tool calls and cost when it ends (DDL in `src/db/schema.ts`), so simultaneous
requests cannot slip past the cap. The Overview's suggestions ask at once (router state); a
`/ai?q=` link only fills the composer.

**Previewing it as a client.** `staff-stream` (admin role checked in the function, like `staff`)
forwards to `POST /api/v1/viewPortalAs/chat/stream` on the staff token, which needs an approved
admin (`requireAdmin()`), writes a `portal.view_as.chat` audit entry per turn, and runs the same
turn as the previewed login — logged with `viewed_by`, not counted against their daily limit. The
JSON `viewPortalAs` op cannot carry a stream, hence the second function.

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

| this repo (source of truth for review)           | the Base44 sandbox                        |
| ------------------------------------------------ | ----------------------------------------- |
| `base44-portal/functions/portal/entry.ts`        | `base44/functions/portal/entry.ts`        |
| `base44-portal/client/portal.js`                 | `src/api/portal.js`                       |
| `base44-portal/client/viewAs.js`                 | `src/lib/viewAs.js`                       |
| `base44-portal/client/staff.js`                  | `src/api/staff.js`                        |
| `base44-portal/functions/portal-stream/entry.ts` | `base44/functions/portal-stream/entry.ts` |
| `base44-portal/functions/staff-stream/entry.ts`  | `base44/functions/staff-stream/entry.ts`  |

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
