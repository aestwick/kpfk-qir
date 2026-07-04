-- Re-normalize program `category` values written by the Confessor ingest path.
--
-- Migration 039 cleaned the entity-encoded categories the CDATA RSS path had
-- written ("Espa&ntilde;ol" → "Español") and lib/rss.ts#rssText stopped the RSS
-- path from writing new ones. But KPFK switched to Confessor-primary ingest
-- (migration 035), and the Confessor `fil` endpoint emits the same pre-encoded
-- HTML entities in its `category`/`title` fields — workers/ingest.ts inserted
-- them verbatim, so "Espa&ntilde;ol" rows started accumulating again. Those rows
-- are invisible to the Episodes page genre filter (exact match on "Español")
-- and to the excluded_categories substring match.
--
-- lib/confessor.ts now decodes entities on fetch (fetchConfessorEpisodes) and in
-- the pubfile projections, so this stops recurring; this migration cleans the
-- rows already written. Idempotent: the replaces are no-ops once clean. Same
-- targeted entity set as 039 (&amp; and &ntilde; are the only ones observed).

update public.episode_log
set category = replace(replace(category, '&amp;', '&'), '&ntilde;', 'ñ')
where category ~ '&(amp|ntilde);';

update public.episode_log
set title = replace(replace(title, '&amp;', '&'), '&ntilde;', 'ñ')
where title ~ '&(amp|ntilde);';

update public.show_keys
set category = replace(replace(category, '&amp;', '&'), '&ntilde;', 'ñ')
where category ~ '&(amp|ntilde);';
