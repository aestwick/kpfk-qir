-- Fix ghost episodes: status = 'transcribed' but no corresponding transcript row.
-- These episodes block the summarize pipeline because they fill every batch
-- but can never be summarized.
--
-- Known affected IDs: 10, 624–758, 793–821 (~124 episodes)
-- These are old/bad data from prior ingests. Real transcripts live in the
-- 126–1465 ID range (134 rows). Only ~2 episodes are legitimately blocked.
--
-- The ghost episodes likely have null air_date, which causes them to match
-- the summarize worker's quarter filter fallback clause
-- (air_date IS NULL AND created_at within quarter).
--
-- Root cause: the transcribe worker previously did not check whether the
-- transcript upsert succeeded before marking the episode as transcribed.
-- This has been fixed in the application code.

UPDATE episode_log
SET status = 'transcript_missing',
    error_message = 'Episode marked as transcribed but no transcript found in database (cleaned up by migration 011)'
WHERE status = 'transcribed'
  AND id NOT IN (SELECT DISTINCT episode_id FROM transcripts);
