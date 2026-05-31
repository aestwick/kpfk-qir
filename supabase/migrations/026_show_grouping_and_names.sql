-- Migration 026: Explicit show grouping + display-name resolution
-- Idempotent: safe to re-run
--
-- A single logical show can air on more than one feed, each with its own
-- show_key (e.g. a 6am and a 9am broadcast). It can also carry alternate name
-- spellings across systems (the archive RSS title vs. the hand-entered name).
--
-- These columns separate the show's *identity* (for grouping/merging) from its
-- *name* (purely for display/listing):
--
--   show_group   — explicit grouping identity. Feeds that share a non-null
--                  show_group (within a station) are treated as ONE logical
--                  show in the QIR picker and report. Null = standalone, in
--                  which case the feed's own key is its effective group. This
--                  is the reliable merge key — names are never used to merge.
--   feed_name    — name auto-derived from the RSS channel <title> at ingest.
--   display_name — manual override for the displayed name. Wins over feed_name.
--
-- Resolved display name = coalesce(display_name, feed_name, show_name, key).
-- Effective group        = coalesce(show_group, key).
-- Both columns are nullable; existing rows stay null until set.

ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS show_group TEXT;
ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS feed_name TEXT;
ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS display_name TEXT;

COMMENT ON COLUMN show_keys.show_group IS 'Explicit grouping identity: feeds sharing a non-null show_group (per station) are one logical show. Null = standalone (effective group is the key). Reliable merge key independent of name spelling.';
COMMENT ON COLUMN show_keys.feed_name IS 'Display name auto-derived from the RSS channel <title> at ingest. Display-only.';
COMMENT ON COLUMN show_keys.display_name IS 'Manual override for the displayed show name. Wins over feed_name/show_name. Display-only.';

-- Speeds up grouping feeds by their show_group within a station.
CREATE INDEX IF NOT EXISTS idx_show_keys_station_group
  ON show_keys (station_id, show_group)
  WHERE show_group IS NOT NULL;
