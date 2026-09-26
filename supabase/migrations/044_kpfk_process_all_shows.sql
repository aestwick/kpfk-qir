-- KPFK: process every program, music included, going forward.
--
-- Why: the profanity/indecency compliance check only sees what the pipeline
-- transcribes, and the pipeline only pulls ACTIVE show_keys. Music shows were
-- left inactive (they rarely make the QIR), so the shows most likely to air an
-- uncensored lyric were never checked. KPFK already has excluded_categories =
-- [] and excluded_show_keys = [], so activation is the only gate left.
--
-- Steady-state stays current-quarter-scoped (transcribe/summarize/compliance
-- windows), so this does NOT reprocess past quarters — it applies from the next
-- ingest tick forward.
--
-- Three parts, all idempotent:

-- 1. Archive the bogus numeric show_keys (every station). discovery sync used to
--    scrape the archive home page's CATEGORY dropdown (<select id="ca_id">,
--    values "0".."14" named "Music", "News", "All Categories", ...) as if it were
--    programs (fixed in lib/archive-discover.ts). They aren't feeds; at KPFA and
--    WPFW several were even active. Archived (tombstone, migration 034) rather
--    than deleted so discovery never re-imports them. A numeric key alone isn't
--    proof (nothing forbids a real all-digit show key), so the match also
--    requires the archive's category-filter label as the name, no resolved feed
--    (category/feed_name null — a category id has no feed), and no episodes.
--    Labels are the full set seen across KPFK/KPFA/WPFW/KPFT at time of writing.
update public.show_keys k
set active = false,
    archived_at = now()
where k.key ~ '^[0-9]+$'
  and k.archived_at is null
  and k.category is null
  and k.feed_name is null
  and k.show_name in (
    'All Categories', 'Arts & Entertainment', 'Comedy & Satire', 'Community Access',
    'Culture', 'Español', 'Health & Fitness', 'Health & Spirituality', 'Local Music',
    'Local Public Affairs', 'Local Public Affairs (En Espanol)',
    'Local Public Affairs carried Nationally', 'Music', 'Music Mix', 'News',
    'News Program', 'News Special', 'Political Talk', 'Public Access',
    'Public Affairs - Local', 'Public Affairs- National+Syndicated',
    'Special Program', 'Spoken Word', 'Syndicated Music', 'Syndicated Program'
  )
  and not exists (
    select 1 from public.episode_log e
    where e.station_id = k.station_id and e.show_key = k.key
  );

-- 2. Activate every remaining live KPFK show (music, arts, the two Public
--    Affairs shows discovery added in Aug/Sep 2026 that were never reviewed).
update public.show_keys k
set active = true
from public.stations s
where s.id = k.station_id
  and s.slug = 'kpfk'
  and k.archived_at is null
  and not k.active;

-- 3. Keep it that way: programs discovery finds later arrive ACTIVE for KPFK
--    (workers/discover-sync.ts reads discovery_auto_activate; default false for
--    every other station).
insert into public.station_settings (station_id, key, value)
select s.id, 'discovery_auto_activate', 'true'::jsonb
from public.stations s
where s.slug = 'kpfk'
on conflict (station_id, key) do update set value = excluded.value;
