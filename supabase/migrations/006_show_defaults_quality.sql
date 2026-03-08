-- Migration 006: Show Defaults & Quality Flag Support
-- Idempotent: safe to re-run

-- Add default_category to show_keys for auto-categorization
ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS default_category TEXT;

-- Add indexes for quality flag detection and episode queries
CREATE INDEX IF NOT EXISTS idx_episode_log_show_key ON episode_log(show_key);
CREATE INDEX IF NOT EXISTS idx_episode_log_air_date_status ON episode_log(air_date, status);
CREATE INDEX IF NOT EXISTS idx_compliance_flags_resolved ON compliance_flags(resolved) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_compliance_flags_episode_id ON compliance_flags(episode_id);

-- Add episode_id to transcript_corrections for episode-scoped corrections
ALTER TABLE transcript_corrections ADD COLUMN IF NOT EXISTS episode_id INTEGER REFERENCES episode_log(id) ON DELETE CASCADE;
