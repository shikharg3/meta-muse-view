-- Scheduled reports: campaign/ad set renames, column headers and the split (ReportAdjustments,
-- docs/scheduled-reports.md). Additive; run after 2026-10-28-report-templates.sql:
--
--   ssh root@159.65.110.111 "sudo -u postgres psql -d meta -v ON_ERROR_STOP=1 -1 -f -" < deploy/ddl/2026-10-28-report-adjustments.sql

ALTER TABLE telegram_report_schedules ADD COLUMN IF NOT EXISTS adjustments jsonb NOT NULL DEFAULT '{}';
