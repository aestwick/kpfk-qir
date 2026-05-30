-- Migration 022: Transcript full-text search (Phase 1, lexical FTS)
-- Idempotent: safe to re-run.
--
-- Implements the lexical tier of ideas/TRANSCRIPT_SEARCH_SPEC.md:
--   1. A document-level tsvector + GIN index on transcripts.transcript for
--      ranking episodes ("which episodes, best first").
--   2. A cue-level table (transcript_cues) carrying timed VTT cues with their own
--      tsvector + GIN index, for locating the matching moment ("which second")
--      so results can deep-link the audio at start_ms.
--   3. A search_transcripts() RPC that ranks episodes via the document index,
--      attaches a ts_headline snippet, and pulls the best-matching cue's start_ms
--      per episode — all scoped to one station.
--
-- 'simple' text-search config (NO stemming, NO stopword removal): exact-form
-- matching across English, Spanish, and any other language this corpus already
-- contains. Stemmed/conceptual discovery lives in the summary layer, not here.
-- Using 'english' would silently corrupt the Spanish-language transcripts.
--
-- transcripts / transcript_cues carry NO station_id of their own; they are
-- scoped to a station via the episode_id -> episode_log.station_id join (same as
-- the existing transcripts RLS in 014_rls.sql).

-- ---------------------------------------------------------------------------
-- 1. Document-level FTS on transcripts.transcript
-- ---------------------------------------------------------------------------
alter table public.transcripts
  add column if not exists transcript_fts tsvector
    generated always as (to_tsvector('simple', coalesce(transcript, ''))) stored;

create index if not exists idx_transcripts_fts
  on public.transcripts using gin (transcript_fts);

-- ---------------------------------------------------------------------------
-- 2. Cue-level table (timed surface parsed from the VTT)
-- ---------------------------------------------------------------------------
create table if not exists public.transcript_cues (
  id          bigint generated always as identity primary key,
  episode_id  bigint not null references public.episode_log(id) on delete cascade,
  cue_idx     int  not null,
  start_ms    int  not null,
  end_ms      int  not null,
  text        text not null,
  text_fts    tsvector generated always as
                (to_tsvector('simple', coalesce(text, ''))) stored
);

create index if not exists idx_transcript_cues_episode on public.transcript_cues(episode_id);
create index if not exists idx_transcript_cues_fts on public.transcript_cues using gin(text_fts);

-- One row set per episode: re-populating replaces an episode's cues, so a unique
-- (episode_id, cue_idx) keeps backfills/re-transcribes from duplicating cues.
create unique index if not exists idx_transcript_cues_episode_idx
  on public.transcript_cues(episode_id, cue_idx);

-- ---------------------------------------------------------------------------
-- 3. RLS — scope cues via the episode_log join, mirroring transcripts (014).
-- ---------------------------------------------------------------------------
alter table public.transcript_cues enable row level security;

drop policy if exists transcript_cues_select on public.transcript_cues;
create policy transcript_cues_select on public.transcript_cues
  for select using (exists (
    select 1 from public.episode_log e
    where e.id = transcript_cues.episode_id
      and e.station_id in (select public.user_station_ids())
  ));

drop policy if exists transcript_cues_write on public.transcript_cues;
create policy transcript_cues_write on public.transcript_cues
  for all using (exists (
    select 1 from public.episode_log e
    where e.id = transcript_cues.episode_id
      and e.station_id in (select public.user_station_ids())
  ))
  with check (exists (
    select 1 from public.episode_log e
    where e.id = transcript_cues.episode_id
      and e.station_id in (select public.user_station_ids())
  ));

-- ---------------------------------------------------------------------------
-- 4. search_transcripts() — ranked episode search with snippet + cue start_ms.
-- ---------------------------------------------------------------------------
-- security invoker (the default) so the function body runs under the caller's
-- RLS: the per-station policies on transcripts / episode_log are enforced even
-- if p_station_id were wrong. The explicit p_station_id filter is defense in
-- depth (house style), matching every other route.
create or replace function public.search_transcripts(
  p_station_id uuid,
  p_query      text,
  p_show_key   text default null,
  p_start_date date default null,
  p_end_date   date default null,
  p_limit      int  default 20,
  p_offset     int  default 0
)
returns table (
  episode_id  bigint,
  show_key    text,
  show_name   text,
  air_date    date,
  status      text,
  rank        real,
  snippet     text,
  start_ms    int,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  q tsquery;
begin
  -- Bound a pathological query so it can't pin a connection (spec §7.1).
  set local statement_timeout = '5s';

  -- websearch_to_tsquery lets staff type `"measles outbreak" -vaccine` naturally.
  q := websearch_to_tsquery('simple', coalesce(p_query, ''));
  -- Empty query (only punctuation/whitespace) matches nothing — return no rows.
  if q is null or numnode(q) = 0 then
    return;
  end if;

  return query
  with matched as (
    select
      e.id         as m_episode_id,
      e.show_key   as m_show_key,
      e.show_name  as m_show_name,
      e.air_date   as m_air_date,
      e.status     as m_status,
      e.created_at as m_created_at,
      t.transcript as m_transcript,
      ts_rank(t.transcript_fts, q) as m_rank
    from public.transcripts t
    join public.episode_log e on e.id = t.episode_id
    where e.station_id = p_station_id
      and t.transcript_fts @@ q
      and (p_show_key is null or e.show_key = p_show_key)
      and (p_start_date is null or coalesce(e.air_date, e.created_at::date) >= p_start_date)
      and (p_end_date   is null or coalesce(e.air_date, e.created_at::date) <= p_end_date)
  ),
  counted as (
    select count(*)::bigint as n from matched
  ),
  page as (
    select * from matched
    order by m_rank desc, m_air_date desc nulls last, m_episode_id desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select
    page.m_episode_id,
    page.m_show_key,
    page.m_show_name,
    page.m_air_date,
    page.m_status,
    page.m_rank,
    -- Non-HTML sentinels (private-use code points) the client swaps for <mark>
    -- after escaping, so a transcript can never inject markup. Capped to the
    -- current page only — ts_headline is the one expensive op on large docs.
    ts_headline('simple', page.m_transcript, q,
      'StartSel=' || E'' || ',StopSel=' || E'' ||
      ',MaxFragments=2,MinWords=6,MaxWords=20,FragmentDelimiter= … ') as snippet,
    cue.start_ms,
    counted.n as total_count
  from page
  cross join counted
  -- Best matching cue for this episode supplies the deep-link timestamp. No
  -- match -> start_ms is null and the UI shows the snippet without a deep-link
  -- (never fabricate a timestamp — spec §7.1).
  left join lateral (
    select c.start_ms
    from public.transcript_cues c
    where c.episode_id = page.m_episode_id
      and c.text_fts @@ q
    order by ts_rank(c.text_fts, q) desc, c.cue_idx asc
    limit 1
  ) cue on true
  order by page.m_rank desc, page.m_air_date desc nulls last, page.m_episode_id desc;
end;
$$;

revoke all on function public.search_transcripts(uuid, text, text, date, date, int, int) from public;
grant execute on function public.search_transcripts(uuid, text, text, date, date, int, int) to authenticated;
