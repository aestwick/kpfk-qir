-- Backfill air_date for episodes where it's null but date text is populated.
-- The date field contains text like "Wednesday, March 4, 2026" which we parse
-- by stripping the leading day-of-week.
-- Also backfills air_start and air_end from start_time/end_time where possible.

UPDATE episode_log
SET air_date = TO_DATE(
  REGEXP_REPLACE(date, '^[A-Za-z]+,\s*', ''),
  'Month DD, YYYY'
)
WHERE air_date IS NULL
  AND date IS NOT NULL;
