-- Add missing indexes for commonly queried columns
CREATE INDEX IF NOT EXISTS idx_episode_status_airdate ON episode_log(status, air_date);
CREATE INDEX IF NOT EXISTS idx_episode_mp3url ON episode_log(mp3_url);
CREATE INDEX IF NOT EXISTS idx_transcripts_episode ON transcripts(episode_id);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
