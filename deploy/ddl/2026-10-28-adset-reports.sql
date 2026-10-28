-- Daily ad-set CSV reports delivered to Telegram. Renamed and generalised the same day by
-- 2026-10-28-scheduled-reports.sql (docs/scheduled-reports.md); apply both, in order.
-- Additive only. Apply explicitly rather than with `drizzle-kit push` (see 2026-10-19-csv-import.sql):
--
--   ssh root@159.65.110.111 "sudo -u postgres psql -d meta -v ON_ERROR_STOP=1 -1 -f -" < deploy/ddl/2026-10-28-adset-reports.sql

CREATE TABLE IF NOT EXISTS adset_report_schedules (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  chat_id text NOT NULL,
  hour integer NOT NULL DEFAULT 10 CHECK (hour BETWEEN 0 AND 23),
  minute integer NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 59),
  active boolean NOT NULL DEFAULT true,
  run_date date,
  sent_at timestamp with time zone,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- The app connects as `meta`; tables created by the postgres superuser must be handed over.
ALTER TABLE adset_report_schedules OWNER TO meta;
