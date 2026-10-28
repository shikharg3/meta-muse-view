-- Scheduled reports: "_modeled" in the file name becomes a per-schedule choice instead of automatic
-- (docs/scheduled-reports.md). Additive; run after 2026-10-28-report-adjustments.sql:
--
--   ssh root@159.65.110.111 "sudo -u postgres psql -d meta -v ON_ERROR_STOP=1 -1 -f -" < deploy/ddl/2026-10-28-report-filename-modeled.sql

ALTER TABLE telegram_report_schedules
  ADD COLUMN IF NOT EXISTS filename_modeled boolean NOT NULL DEFAULT false;
