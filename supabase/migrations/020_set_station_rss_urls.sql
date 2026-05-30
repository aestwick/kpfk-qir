-- Set archive feed config for the Pacifica stations seeded (NULL) in 015.
--
-- Background: the ingest worker builds each feed URL as rss_base_url || show.key
-- (rss_base_url includes the trailing '?id='), and parses air date/time from the
-- MP3 filename, which follows <prefix>_YYMMDD_HHMMSS<showkey>.mp3 where <prefix>
-- is mp3_filename_prefix (see lib/parse-mp3-url.ts).
--
-- Feed URL form (from the station archives): https://archive.<host>/getrss.php?id=<key>
--
-- mp3_filename_prefix is the leading token of the archive MP3 filename. VERIFIED
-- from sampled enclosures:
--   https://archive.wpfwfm.org/mp3/wpfw_260529_080000democragoodman.mp3  -> 'wpfw'
--   https://archive.kpft.org/mp3/kpft_260529_070000dn.mp3                -> 'kpft'
-- KPFA is INFERRED from the identical Pacifica Archive convention (prefix =
-- lowercase call sign); confirm against a real KPFA MP3 before relying on
-- URL-derived air dates for it. (A wrong prefix doesn't drop episodes — ingest
-- falls back to RSS pubDate — it only skips the more reliable filename-derived
-- date/time.)
--
-- WBAI is intentionally left NULL: its archive uses a different URL format (per
-- project owner) and is out of scope here. It stays skipped by ingest until set.
--
-- Note: setting these does not by itself ingest anything — each station still has
-- no show_keys rows, so the worker finds zero shows until those are added.

update public.stations
  set rss_base_url = 'https://archive.kpfa.org/getrss.php?id=',
      mp3_filename_prefix = 'kpfa'
  where slug = 'kpfa';

update public.stations
  set rss_base_url = 'https://archive.wpfwfm.org/getrss.php?id=',
      mp3_filename_prefix = 'wpfw'
  where slug = 'wpfw';

update public.stations
  set rss_base_url = 'https://archive.kpft.org/getrss.php?id=',
      mp3_filename_prefix = 'kpft'
  where slug = 'kpft';
