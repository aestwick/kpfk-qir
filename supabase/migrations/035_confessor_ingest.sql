-- Confessor ingest — an alternate episode source alongside RSS.
--
-- The Pacifica archive exposes a richer "Confessor" API (per-station host,
-- e.g. https://confessor.kpfk.org/_nu_do_api.php) whose `?req=fil&id=<slug>`
-- endpoint returns recent archived MP3s *with* the human-entered "pubfile"
-- metadata: host, guest name/topic, FCC issue tags (issue1..3), and free-text
-- notes/rundowns. RSS carries none of that. This migration lets a station pull
-- episodes from Confessor as the PRIMARY source and fall back to RSS per show
-- when Confessor is unconfigured or unreachable.
--
-- Human-authored metadata is preserved losslessly: the full pubfile array is
-- stored verbatim in episode_log.confessor_meta (jsonb), the known fields are
-- projected onto the existing host/guest/issue_category columns, and any human
-- narrative (notes / rundown / topic) is kept in human_summary. The AI
-- summarizer then fills gaps only — it never overwrites what a human wrote
-- (see workers/summarize.ts).

-- ── Station: per-station source selection + Confessor host ──────────────────
alter table public.stations
  add column if not exists confessor_base_url text,
  add column if not exists ingest_primary text not null default 'rss';

-- Constrain the source selector. Default 'rss' keeps every existing station on
-- its current behavior; only an explicitly flipped station uses Confessor.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stations_ingest_primary_check'
  ) then
    alter table public.stations
      add constraint stations_ingest_primary_check
      check (ingest_primary in ('rss', 'confessor'));
  end if;
end $$;

comment on column public.stations.confessor_base_url is
  'Full Confessor API endpoint up to the script (e.g. https://confessor.kpfk.org/_nu_do_api.php). The ?req=…&id=<slug>&json=1 query is appended by the worker. Null = Confessor not configured (ingest falls back to RSS).';
comment on column public.stations.ingest_primary is
  'Primary episode source: ''confessor'' (with RSS per-show fallback) or ''rss''. Defaults to ''rss''.';

-- ── Episode: provenance + lossless human metadata ──────────────────────────
alter table public.episode_log
  add column if not exists ingest_source text not null default 'rss',
  add column if not exists confessor_meta jsonb,
  add column if not exists human_summary text;

comment on column public.episode_log.ingest_source is
  'Where this episode row originated: ''confessor'' or ''rss''.';
comment on column public.episode_log.confessor_meta is
  'Verbatim Confessor pubfile array (human-entered host/guest/topic/issues/notes), preserved losslessly regardless of which fields were filled. Source of truth for the human metadata projected onto host/guest/issue_category/human_summary.';
comment on column public.episode_log.human_summary is
  'Human-written narrative (notes / rundown / topic) synthesized from the Confessor pubfile. Authoritative: preferred over the AI summary downstream.';

-- ── Flip KPFK to Confessor-primary (the only Confessor-verified host) ───────
-- Other stations stay on RSS (confessor_base_url null) until their host is
-- verified; the worker treats a null host as "RSS only".
update public.stations
set ingest_primary  = 'confessor',
    confessor_base_url = 'https://confessor.kpfk.org/_nu_do_api.php'
where slug = 'kpfk';
