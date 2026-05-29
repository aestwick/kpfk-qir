-- Station-aware variant of get_episode_counts_by_show. The original (007) has
-- no station parameter and groups by show_key across ALL stations, which
-- over-counts now that show_key is only unique per (station_id, key) (013).
-- This overload scopes the count to one station. The no-arg 007 version is left
-- in place (append-only migrations); callers should use this parameterized one.
CREATE OR REPLACE FUNCTION get_episode_counts_by_show(p_station_id uuid)
RETURNS TABLE(show_key text, count bigint)
LANGUAGE sql STABLE
AS $$
  SELECT show_key, COUNT(*) as count
  FROM episode_log
  WHERE station_id = p_station_id
  GROUP BY show_key;
$$;
