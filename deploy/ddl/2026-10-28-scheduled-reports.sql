-- Generalise the daily ad-set report into scheduled report recipes (docs/scheduled-reports.md).
-- Run once, after 2026-10-28-adset-reports.sql, in one transaction:
--
--   ssh root@159.65.110.111 "sudo -u postgres psql -d meta -v ON_ERROR_STOP=1 -1 -f -" < deploy/ddl/2026-10-28-scheduled-reports.sql
--
-- Existing rows keep exactly what they sent before: the OneAgency ad-set CSV for yesterday, daily.

ALTER TABLE adset_report_schedules RENAME TO telegram_report_schedules;
ALTER TABLE telegram_report_schedules RENAME CONSTRAINT adset_report_schedules_pkey TO telegram_report_schedules_pkey;
ALTER TABLE telegram_report_schedules RENAME CONSTRAINT adset_report_schedules_client_id_fkey TO telegram_report_schedules_client_id_fkey;
ALTER TABLE telegram_report_schedules RENAME CONSTRAINT adset_report_schedules_hour_check TO telegram_report_schedules_hour_check;
ALTER TABLE telegram_report_schedules RENAME CONSTRAINT adset_report_schedules_minute_check TO telegram_report_schedules_minute_check;

ALTER TABLE telegram_report_schedules
  ADD COLUMN name text,
  ADD COLUMN brands jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN campaign_ids jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN columns jsonb NOT NULL
    DEFAULT '["spend","impressions","clicks","cpc","cpm","ctr","registrations","purchases"]',
  ADD COLUMN breakdown text NOT NULL DEFAULT 'adset',
  ADD COLUMN time_increment text NOT NULL DEFAULT '1',
  ADD COLUMN range_preset text NOT NULL DEFAULT 'yesterday',
  ADD COLUMN markup double precision,
  ADD COLUMN cadence text NOT NULL DEFAULT 'daily'
    CHECK (cadence IN ('daily', 'weekdays', 'weekly', 'monthly')),
  ADD COLUMN weekday integer CHECK (weekday BETWEEN 1 AND 7),
  ADD COLUMN month_day integer CHECK (month_day BETWEEN 1 AND 28);

UPDATE telegram_report_schedules s
  SET name = c.name || ' · ad sets · yesterday'
  FROM clients c WHERE c.id = s.client_id AND s.name IS NULL;
ALTER TABLE telegram_report_schedules ALTER COLUMN name SET NOT NULL;
-- The recipe is the row's content from now on; the default only served the rows above.
ALTER TABLE telegram_report_schedules ALTER COLUMN columns DROP DEFAULT;

-- `run_date` used to be the REPORTED day (yesterday) and is now the Berlin date of the send. Shift
-- what is claimed, or today's already-sent report would be sent again.
UPDATE telegram_report_schedules SET run_date = run_date + 1 WHERE run_date IS NOT NULL;
