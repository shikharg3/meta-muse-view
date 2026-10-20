# CSV import for ad accounts the Business Manager cannot read

Some client spend runs in ad accounts that MetaConsole's system-user token has no access to. Their
Ads Manager export is uploaded at `https://159.65.110.111/import`. The rows land in the ordinary
synced tables under the account's real Meta ids, so dashboards, client pages, reports, the agent and
the daily update read them exactly like synced data.

## Where it is reachable

Only on the hosts in `IMPORT_HOSTS` (the droplet `.env`: `IMPORT_HOSTS=159.65.110.111`). Anywhere
else `/import` is a 404 before auth (`src/server.ts`), and every server fn behind the page re-checks
the host and requires an admin (`src/server/fns/meta-import.ts`). Unset `IMPORT_HOSTS` turns the
feature off everywhere.

This hides the page; it is not the security boundary. The Host header is client-controlled, and
admin sign-in is what protects the import. The IP must be served over HTTPS: the session cookie is
`Secure`, so a browser drops it on plain `http://` and login silently bounces back to `/login`.
nginx: `deploy/159.65.110.111.conf`. The certificate is a 6-day Let's Encrypt IP certificate from
an isolated certbot (`/opt/certbot-ip`, config in `/etc/letsencrypt-ip`), renewed by
`deploy/certbot-ip.{service,timer}`; the domains' apt certbot is untouched.

## Exporting from Ads Manager

Template: `docs/csv-import-template.csv`, or "Download template" on the page. Column names are Ads
Manager's own English names; matching ignores case, and unknown columns are ignored and listed.

1. Ads tab (or Ad sets tab), the date range you need.
2. Breakdown → By time → **Day**.
3. Columns: **Account ID, Campaign ID, Campaign name, Ad set ID, Ad set name, Amount spent,
   Impressions** are required (Ad ID/Ad name for ad-level rows). Add Reach, Clicks (all), Link
   clicks and the conversion columns reported on (Registrations Completed, Purchases, Purchases
   conversion value, Leads, Landing page views, …).
4. Export → CSV, and upload it unedited. A spreadsheet re-save can round 18-digit ids, which the
   import refuses.

Rules the import enforces:

- One account per file; one row per entity per day; days as `YYYY-MM-DD`.
- Each row's level is its deepest id (ad → ad set → campaign → account). Every coarser row the file
  lacks is the sum of its children. A row the file does contain wins, with a warning when its spend
  disagrees with its children's sum.
- Every campaign needs ad set rows: the ad set carries the conversion event
  (`promoted_object.custom_event_type`) that labels the campaign's results, e.g. Registrations.
  "Result event" on the page sets it; Auto picks the conversion with the most volume.
- Reach summed from finer rows over-counts people reached by several ads. Include account- or
  campaign-level rows (a second export appended to the same file) for Meta's exact reach.
- A commit replaces every row of that account dated inside the file's range, at every level. Re-upload
  a corrected export to fix a mistake; "Delete" removes the account and everything imported for it.

After the first import, link the account to its client: add the `act_…` id to the client row's
"Other ad accounts" on the Notion campaigns board, or add it on the client page. Until then no client
total includes it. Import yesterday before 10:00 Berlin for it to be in that day's daily update.

## What the sync does with an imported account

`accounts.source = 'import'` marks it. The sync never calls Meta for it (the backfill and the
enumeration fallback read `source = 'meta'` only); calling Meta for an account the token cannot read
returns #100/33, whose field bisection would poison the shared `meta_field_blocklist`. Its spend
counts everywhere, but it is left out of everything that infers live delivery state, because a CSV
carries no account status or spend cap: spend-drop and account alerts, the Notion 🤖 Account Status
ladder and funds columns, daily-update delivery health, and sync coverage. Reset & resync keeps
imported rows. If Meta's enumeration ever returns the account, the sync takes it over
(`syncAccounts` stamps `source = 'meta'`) and the import page refuses it from then on.

## Schema

`deploy/ddl/2026-10-19-csv-import.sql` (applied explicitly; see the file for why not `drizzle-kit
push`): `accounts.source`, and `import_batches`, one row per accepted upload for the page's history.
