-- 033_ingest_source_and_health.sql
--
-- Two related ingest reliability features, both all-station (the ingest worker
-- already fans out one job per station, so nothing here is KPFK-specific):
--
--   1. A per-show ingest SOURCE. Until now every show was pulled one way:
--      fetch(rss_base_url || key) and parse the RSS <item> enclosures. Shows
--      whose audio isn't exposed as archive RSS (only via the nu_do API) could
--      never be ingested — they sat as active show_keys with zero episodes.
--      `source` lets a show declare where it's pulled from ('rss' default |
--      'nudo' backup). Per-show (not per-station) because a single station
--      mixes both — KPFK has RSS shows AND nu_do-only shows side by side.
--
--   2. Per-show ingest HEALTH. A feed that 404s or returns no items was
--      previously swallowed (console.warn + return 0) — invisible, which is why
--      silently-dead shows went unnoticed for months. These columns record the
--      outcome of each fetch so the Master Control overview can surface feeds
--      that were attempted but came back empty/broken.
--
-- Plus a per-station nu_do base URL, mirroring stations.rss_base_url. The nu_do
-- API KEY is intentionally NOT stored here (it's a secret; it lives in the
-- NUDO_API_KEY env var) — this column is only the non-secret endpoint root.
--
-- All additive and backfill-safe: source defaults to 'rss', so every existing
-- show keeps its current behavior; health columns start null (= never attempted).

ALTER TABLE show_keys
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'rss'
    CHECK (source IN ('rss', 'nudo'));

ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS last_ingest_at     timestamptz;
ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS last_ingest_status text;     -- ok | empty | http_<code> | error
ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS last_item_count    integer;  -- items the feed returned (feed health, not new-row count)
ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS last_ingest_error  text;

COMMENT ON COLUMN show_keys.source IS 'Ingest adapter for this show: ''rss'' (default — fetch rss_base_url||key) or ''nudo'' (pull via the nu_do API). Per-show because one station mixes both.';
COMMENT ON COLUMN show_keys.last_ingest_status IS 'Outcome of the most recent ingest fetch: ok | empty | http_<code> | error. Null = never attempted (e.g. inactive or category-excluded).';
COMMENT ON COLUMN show_keys.last_item_count IS 'Items the feed returned on the last fetch (feed-health signal — distinguishes a healthy feed with nothing new from a feed returning nothing).';

ALTER TABLE stations ADD COLUMN IF NOT EXISTS nudo_base_url TEXT;
COMMENT ON COLUMN stations.nudo_base_url IS 'Per-station nu_do API endpoint root (mirrors rss_base_url). The nu_do API key is a secret and lives in NUDO_API_KEY, not here. Null = nu_do not configured for this station.';

-- Surfacing query support: find active shows whose last attempted fetch failed.
CREATE INDEX IF NOT EXISTS idx_show_keys_ingest_health
  ON show_keys (station_id, last_ingest_status)
  WHERE active AND last_ingest_status IS NOT NULL AND last_ingest_status <> 'ok';
