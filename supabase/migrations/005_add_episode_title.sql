-- Add title column to store the original RSS episode title
ALTER TABLE episode_log ADD COLUMN IF NOT EXISTS title text;
