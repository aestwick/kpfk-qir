-- Seed the remaining Pacifica stations alongside KPFK (seeded in 012).
-- These start with NO episodes/shows; existing data stays KPFK-only (013).
--
-- IMPORTANT: rss_base_url and mp3_filename_prefix are intentionally left NULL
-- for the four stations below. Their archive feed URLs and MP3 filename
-- conventions are not yet known here, and guessing them would silently break
-- ingest. Fill these in (per station) before enabling ingest for that station
-- -- see the Phase F worker config. station_id_patterns hold the call sign and
-- broadcast frequency for compliance station-ID detection.

insert into public.stations (slug, name, timezone, rss_base_url, mp3_filename_prefix, station_id_patterns)
values
  ('kpfa', 'KPFA, Berkeley',         'America/Los_Angeles', null, null, array['kpfa', '94.1']),
  ('wpfw', 'WPFW, Washington D.C.',  'America/New_York',    null, null, array['wpfw', '89.3']),
  ('kpft', 'KPFT, Houston',          'America/Chicago',     null, null, array['kpft', '90.1']),
  ('wbai', 'WBAI, New York City',    'America/New_York',    null, null, array['wbai', '99.5'])
on conflict (slug) do nothing;
