-- CSV import of ad accounts the system-user token cannot read (src/server/fns/meta-import.ts).
-- Additive only. Apply explicitly rather than with `drizzle-kit push`, which also proposes a
-- needless primary-key rename on insights_breakdown_daily (see the 2026-08-13 check-in plan):
--
--   ssh root@159.65.110.111 "sudo -u postgres psql -d meta -v ON_ERROR_STOP=1 -1 -f -" < deploy/ddl/2026-10-19-csv-import.sql
--
-- `ADD COLUMN ... DEFAULT` with a constant is metadata-only on Postgres 11+: no table rewrite.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'meta';

CREATE TABLE IF NOT EXISTS import_batches (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  file_name text,
  file_sha256 text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  rows_by_level jsonb NOT NULL,
  spend double precision NOT NULL,
  uploaded_by text NOT NULL,
  uploaded_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_batches_account_idx ON import_batches (account_id, uploaded_at);

-- The app connects as `meta`; tables created by the postgres superuser must be handed over.
ALTER TABLE import_batches OWNER TO meta;
