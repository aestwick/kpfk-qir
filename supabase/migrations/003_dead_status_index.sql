-- Add index for dead-letter episodes (persistent failures with retry_count >= 3)
-- The 'dead' status is set by the auto-retry worker when retry_count >= 3
CREATE INDEX IF NOT EXISTS idx_episode_retry_count ON episode_log(retry_count)
  WHERE status = 'failed';
