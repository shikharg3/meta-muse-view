-- Scheduled reports: own templates, per-schedule file names, and identity columns chosen like metrics
-- (docs/scheduled-reports.md). Run once, after 2026-10-28-report-modeling.sql:
--
--   ssh root@159.65.110.111 "sudo -u postgres psql -d meta -v ON_ERROR_STOP=1 -1 -f -" < deploy/ddl/2026-10-28-report-templates.sql

CREATE TABLE IF NOT EXISTS telegram_report_templates (
  id text PRIMARY KEY,
  name text NOT NULL,
  recipe jsonb NOT NULL,
  created_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE telegram_report_templates OWNER TO meta;

ALTER TABLE telegram_report_schedules ADD COLUMN IF NOT EXISTS filename text;

-- Identity columns (Date, Brand, Campaign, Ad set, …) used to be added by the engine; now they are
-- part of `columns` like metrics. Give existing schedules what they printed, minus the Account
-- column (dropped by request), in front of their metrics.
UPDATE telegram_report_schedules
SET columns =
  (CASE WHEN time_increment <> 'all_days' THEN '["dim:period"]'::jsonb ELSE '[]'::jsonb END)
  || (CASE breakdown
        WHEN 'none' THEN '[]'
        WHEN 'campaign' THEN '["dim:brand", "dim:campaign", "dim:campaign_id"]'
        WHEN 'adset' THEN '["dim:brand", "dim:campaign", "dim:adset", "dim:adset_id"]'
        WHEN 'ad' THEN '["dim:brand", "dim:campaign", "dim:adset", "dim:ad", "dim:ad_id"]'
        ELSE '["dim:value"]'
      END)::jsonb
  || columns
WHERE columns::text NOT LIKE '%"dim:%';
