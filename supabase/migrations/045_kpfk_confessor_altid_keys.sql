-- KPFK: line up show_keys with Confessor altids so every airing gets picked up.
--
-- Why: ingest asks Confessor `?req=fil&id=<show key>`, and the file on the
-- archive is named after the same altid (kpfk_260927_020000allabove.mp3). A
-- show_keys row whose key isn't an altid gets an empty answer from Confessor
-- and ingests nothing, silently. The hand-entered January rows used name slugs
-- (`alloftheabove`, `theawareshow`, ...); for four shows the real altid row was
-- either discovered inactive (activated by 044) or never discovered at all.
-- Reported by Paul (archive captions) on 2026-09-27: ~38 airings since late
-- July never processed. Runs after 044, so the discovered altid rows
-- (allabove, lstation, reggaecent, cinemascore, codepinradio, makingcontact,
-- calstalacommunnewshour) are already active by the time this applies.
--
-- The backfill itself needs no SQL: a show with no episodes yet ingests its
-- whole Confessor window on its next tick (workers/ingest.ts,
-- CONFESSOR_BACKFILL_NUM), and those airings are in the current quarter.
--
-- Three parts, all idempotent:

-- 1. The Aware Show (altid `aware`) isn't in the archive home page's program
--    dropdown, which is what discovery sync scrapes, so no row was ever
--    created for it. Name/category from the Pacifica catalog
--    (archive.kpfk.org/fe_feed/fe_catalog_kpfk.json).
insert into public.show_keys (station_id, key, show_name, category, active)
select s.id, 'aware', 'The Aware Show', 'Health & Spirituality', true
from public.stations s
where s.slug = 'kpfk'
on conflict (station_id, key) do update
  set active = true, archived_at = null;

-- 2. Retire the name-slug rows those altids replace. Archived (tombstone,
--    migration 034) rather than deleted so discovery never re-imports them,
--    and only when they never produced an episode (none of them has).
update public.show_keys k
set active = false,
    archived_at = now()
from public.stations s
where s.id = k.station_id
  and s.slug = 'kpfk'
  and k.key in ('alloftheabove', 'nightscapesheartmindsoulofthec', 'theawareshow', 'reggaecentral')
  and k.archived_at is null
  and not exists (
    select 1 from public.episode_log e
    where e.station_id = k.station_id and e.show_key = k.key
  );

-- 3. World Massive, Sat 2026-09-26 2:00 AM: went `dead` after three Groq
--    timeouts (524) during the post-outage catch-up. Give it a fresh retry
--    budget. Guarded on status so a re-run after it succeeds is a no-op.
update public.episode_log e
set status = 'pending',
    retry_count = 0,
    error_message = null,
    updated_at = now()
from public.stations s
where s.id = e.station_id
  and s.slug = 'kpfk'
  and e.mp3_url = 'https://archive.kpfk.org/mp3/kpfk_260926_020000potira.mp3'
  and e.status in ('dead', 'failed');

-- 4. Special Music Programming (Tuesdays 11 PM) is music, but Confessor files
--    it under "Special Program", and with no curated category ingest copied
--    that onto every episode, so it sat with the talk specials in the genre
--    filter and the public API. Set the show's category and correct the
--    episodes already ingested (a snapshot column; ingest won't revisit them).
update public.show_keys k
set category = 'Music'
from public.stations s
where s.id = k.station_id
  and s.slug = 'kpfk'
  and k.key = 'specialmusicprogramm'
  and k.category is distinct from 'Music';

update public.episode_log e
set category = 'Music',
    updated_at = now()
from public.stations s
where s.id = e.station_id
  and s.slug = 'kpfk'
  and e.show_key = 'specialmusicprogramm'
  and e.category is distinct from 'Music';
