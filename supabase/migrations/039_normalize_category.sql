-- Normalize program `category` values + expose a distinct-category helper.
--
-- The show `category` (program genre, e.g. "Public Affairs", "Música") is resolved
-- from each feed's <category> by lib/rss.ts. CDATA-wrapped category nodes carried
-- pre-encoded HTML entities that the CDATA path passed through verbatim (CDATA
-- suppresses entity decoding), so the same genre landed both decoded and encoded:
--   "Arts & Entertainment"      vs "Arts &amp; Entertainment"
--   "Español"                   vs "Espa&ntilde;ol"
-- plus one spacing variant ("Public Affairs- …" vs "Public Affairs - …").
-- lib/rss.ts#rssText now decodes entities so this stops recurring; this migration
-- cleans the rows already written. Idempotent: the replaces are no-ops once clean.
--
-- Only &amp; and &ntilde; appear in the current data (verified across episode_log
-- + show_keys), so the decode is targeted; new ingests are handled generally in code.

-- ── Decode entities + fix the spacing variant (both tenant-scoped tables) ────
update public.episode_log
set category = replace(replace(category, '&amp;', '&'), '&ntilde;', 'ñ')
where category ~ '&(amp|ntilde);';

update public.episode_log
set category = replace(category, 'Public Affairs- ', 'Public Affairs - ')
where category like 'Public Affairs- %';

update public.show_keys
set category = replace(replace(category, '&amp;', '&'), '&ntilde;', 'ñ')
where category ~ '&(amp|ntilde);';

update public.show_keys
set category = replace(category, 'Public Affairs- ', 'Public Affairs - ')
where category like 'Public Affairs- %';

-- ── Distinct program categories for a station (genre filter dropdown) ────────
-- SECURITY INVOKER (default): RLS on episode_log enforces tenancy, so a caller
-- only ever sees their own station's categories regardless of the arg. Excludes
-- nulls and the inert PRA archive (status='archived', which has a null category
-- anyway).
create or replace function public.get_episode_categories(p_station_id uuid)
returns table(category text, n bigint)
language sql
stable
as $$
  select category, count(*)::bigint as n
  from public.episode_log
  where station_id = p_station_id
    and category is not null
    and status <> 'archived'
  group by category
  order by count(*) desc, category asc;
$$;

grant execute on function public.get_episode_categories(uuid) to authenticated;
