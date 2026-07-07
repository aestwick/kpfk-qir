-- Audit-driven processing priority.
--
-- The Show Audit tool is compliance-facing: staff pick specific shows and ask
-- the pipeline to *complete the data* for any episodes that aren't done yet.
-- This flag lets those episodes jump the general backlog and — unlike the normal
-- cron path — be processed regardless of which quarter they aired in.
--
-- Workers honor it two ways (see workers/transcribe|summarize|compliance.ts):
--   1. candidate selection includes `priority` rows even when out of the current
--      quarter, and
--   2. ordering is `priority desc, created_at asc`, so flagged episodes run first.
-- The flag is cleared once an episode reaches its terminal (compliance_checked)
-- state, so the partial index below only ever holds outstanding priority work.
ALTER TABLE episode_log
  ADD COLUMN IF NOT EXISTS priority boolean NOT NULL DEFAULT false;

-- Partial index: workers look up the small set of outstanding priority rows to
-- run them first; restricting to `priority` keeps the index tiny.
CREATE INDEX IF NOT EXISTS idx_episode_priority
  ON episode_log(station_id, status, created_at)
  WHERE priority;
