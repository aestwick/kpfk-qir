-- 047: make the transcript search functions always use the full-text index.
-- Idempotent.
--
-- transcripts' heap is tiny (<1 MB — the text and tsvector live in TOAST), so
-- the planner prices a sequential scan at ~200 and picks it over the GIN index,
-- then spends ~22s detoasting every tsvector to evaluate `@@`. Measured on the
-- live DB: "prosegur" 22.8s seq scan vs 65ms with the index. Turning seqscan
-- off for just these functions (function-level SET; no effect elsewhere)
-- forces the bitmap index scan; their other lookups are all index-backed too
-- (episode_log pkey, transcript_cues(episode_id), transcript_chunks(episode_id)).

alter function public.search_transcripts_v2(uuid, text, text, text[], date, date, int, int)
  set enable_seqscan = off;

alter function public.episode_moments(uuid, bigint[], text, text)
  set enable_seqscan = off;
