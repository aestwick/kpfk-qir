-- 049: transcript search — bitmap scans only. Idempotent.
--
-- With seqscan off (047/048), a VERY common word ("people": 5,837 of 6,536
-- transcripts) made the planner walk idx_transcripts_episode and evaluate `@@`
-- per row, detoasting every tsvector: 27.6s. The GIN bitmap scan answers the
-- same match from the index alone: 0.56s (measured live). Disabling plain index
-- scans for just these functions leaves bitmap scans as the only path; the
-- per-episode lookups (cues/chunks by episode_id, episode_log by id) run as
-- bitmap scans on the same btree indexes at no measurable cost.

alter function public.search_transcripts_v2(uuid, text, text, text[], date, date, int, int)
  set enable_indexscan = off;

alter function public.episode_moments(uuid, bigint[], text, text)
  set enable_indexscan = off;
