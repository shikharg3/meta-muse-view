-- Modeled scheduled reports: interrupted days replaced by an estimate (src/server/modeling.ts,
-- docs/scheduled-reports.md). Additive; metadata-only on Postgres 11+.
--
--   ssh root@159.65.110.111 "sudo -u postgres psql -d meta -v ON_ERROR_STOP=1 -1 -f -" < deploy/ddl/2026-10-28-report-modeling.sql

ALTER TABLE telegram_report_schedules ADD COLUMN IF NOT EXISTS modeled boolean NOT NULL DEFAULT false;
