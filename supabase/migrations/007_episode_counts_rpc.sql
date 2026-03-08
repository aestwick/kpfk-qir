-- RPC function to get episode counts grouped by show_key
-- Replaces the N+1 pattern of fetching all rows and counting in JS
CREATE OR REPLACE FUNCTION get_episode_counts_by_show()
RETURNS TABLE(show_key text, count bigint)
LANGUAGE sql STABLE
AS $$
  SELECT show_key, COUNT(*) as count
  FROM episode_log
  GROUP BY show_key;
$$;
