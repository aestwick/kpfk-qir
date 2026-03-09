-- Fix ghost episodes: status = 'transcribed' but no corresponding transcript row.
-- These episodes block the summarize pipeline because they fill every batch
-- but can never be summarized.
--
-- Root cause: the transcribe worker previously did not check whether the
-- transcript upsert succeeded before marking the episode as transcribed.
-- This has been fixed in the application code.

UPDATE episode_log
SET status = 'transcript_missing',
    error_message = 'Episode marked as transcribed but no transcript found in database (cleaned up by migration 011)'
WHERE status = 'transcribed'
  AND id NOT IN (SELECT DISTINCT episode_id FROM transcripts);
