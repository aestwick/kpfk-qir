-- Migration 024: Fix transcript search RPCs erroring on every call.
-- Idempotent: safe to re-run.
--
-- Bug: search_transcripts() (022) and search_transcripts_hybrid() (023) are
-- declared `stable` but their bodies run `set local statement_timeout = ...`.
-- Postgres forbids the SET *command* inside a non-volatile (stable/immutable)
-- function, so every call raised:
--
--   ERROR: 0A000: SET is not allowed in a non-volatile function
--   CONTEXT: SQL statement "set local statement_timeout = '5s'"
--
-- The route surfaced that as a 500 and the UI showed "No matches", so BOTH
-- Exact (lexical) and Smart (semantic, which fuses the same lexical branch)
-- returned nothing for every query.
--
-- Fix: keep the per-call statement-timeout guard but set it via a function-level
-- `SET statement_timeout` clause in the definition instead of a SET command in
-- the body. A function-level SET clause IS allowed on a stable function and has
-- the same semantics (applied for the duration of the call, restored on exit),
-- so the timeout protection is preserved without making the function volatile.
--
-- Only the timeout mechanism changes; the query logic, signature, return shape,
-- ranking, snippet sentinels and station scoping are identical to 022 / 023.

-- ---------------------------------------------------------------------------
-- 1. search_transcripts() — lexical FTS (was migration 022).
-- ---------------------------------------------------------------------------
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
set statement_timeout = '5s'   -- per-call guard (replaces the body SET LOCAL)
as $$
declare
  q tsquery;
begin
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
      'StartSel=' || chr(57344) || ',StopSel=' || chr(57345) ||
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

-- ---------------------------------------------------------------------------
-- 2. search_transcripts_hybrid() — RRF-fused lexical + semantic (was migration 023).
-- ---------------------------------------------------------------------------
create or replace function public.search_transcripts_hybrid(
  p_station_id      uuid,
  p_query           text,
  p_query_embedding text,            -- '[..]' vector literal, cast to vector below
  p_show_key        text default null,
  p_start_date      date default null,
  p_end_date        date default null,
  p_limit           int  default 20,
  p_offset          int  default 0,
  p_rrf_k           int  default 50, -- RRF damping constant
  p_candidates      int  default 200 -- ANN candidate pool pulled before fusing
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
  match_type  text,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = public, extensions
set statement_timeout = '8s'   -- per-call guard (replaces the body SET LOCAL)
as $$
declare
  q tsquery;
  v vector(1536);
begin
  -- websearch_to_tsquery lets staff type `"measles outbreak" -vaccine` naturally.
  q := websearch_to_tsquery('simple', coalesce(p_query, ''));

  -- A malformed/empty embedding degrades to lexical-only rather than erroring.
  begin
    v := nullif(p_query_embedding, '')::vector(1536);
  exception when others then
    v := null;
  end;

  -- Nothing to rank on at all -> no rows.
  if (q is null or numnode(q) = 0) and v is null then
    return;
  end if;

  return query
  with
  -- Lexical side: episodes whose transcript matches the tsquery, ranked by ts_rank.
  lex as (
    select
      e.id         as episode_id,
      ts_rank(t.transcript_fts, q) as lex_score,
      t.transcript as transcript,
      e.air_date   as air_date
    from public.transcripts t
    join public.episode_log e on e.id = t.episode_id
    where e.station_id = p_station_id
      and q is not null and numnode(q) > 0
      and t.transcript_fts @@ q
      and (p_show_key is null or e.show_key = p_show_key)
      and (p_start_date is null or coalesce(e.air_date, e.created_at::date) >= p_start_date)
      and (p_end_date   is null or coalesce(e.air_date, e.created_at::date) <= p_end_date)
  ),
  lex_ranked as (
    select episode_id, lex_score, transcript,
      row_number() over (order by lex_score desc, air_date desc nulls last, episode_id desc) as lex_rank
    from lex
  ),
  -- Semantic side: nearest chunks by cosine distance (ANN pool), then collapse to
  -- the single best-matching chunk per episode (its start_ms + content drive the
  -- deep-link / snippet when an episode is a semantic-only hit).
  sem_pool as (
    select
      ch.episode_id,
      ch.start_ms,
      ch.content,
      (ch.embedding <=> v) as dist
    from public.transcript_chunks ch
    join public.episode_log e on e.id = ch.episode_id
    where v is not null
      and e.station_id = p_station_id
      and (p_show_key is null or e.show_key = p_show_key)
      and (p_start_date is null or coalesce(e.air_date, e.created_at::date) >= p_start_date)
      and (p_end_date   is null or coalesce(e.air_date, e.created_at::date) <= p_end_date)
    order by ch.embedding <=> v
    limit greatest(p_candidates, 1)
  ),
  sem_best as (
    select distinct on (episode_id) episode_id, start_ms, content, dist
    from sem_pool
    order by episode_id, dist
  ),
  sem_ranked as (
    select episode_id, start_ms, content, dist,
      row_number() over (order by dist asc, episode_id desc) as sem_rank
    from sem_best
  ),
  -- Reciprocal Rank Fusion: 1/(k+rank) summed across the lists an episode appears
  -- in. Scale-free, so it needs no normalizing of ts_rank vs cosine distance.
  fused as (
    select
      coalesce(l.episode_id, s.episode_id) as episode_id,
      (coalesce(1.0 / (p_rrf_k + l.lex_rank), 0)
        + coalesce(1.0 / (p_rrf_k + s.sem_rank), 0))::real as score,
      l.transcript  as transcript,
      l.lex_rank    as lex_rank,
      s.start_ms    as sem_start_ms,
      s.content     as sem_content
    from lex_ranked l
    full outer join sem_ranked s on l.episode_id = s.episode_id
  ),
  counted as (select count(*)::bigint as n from fused),
  page as (
    select * from fused
    order by score desc, episode_id desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select
    page.episode_id,
    e.show_key,
    e.show_name,
    e.air_date,
    e.status,
    page.score as rank,
    -- Lexical hits get the highlighted ts_headline (same private-use sentinels as
    -- migration 022, swapped for <mark> client-side after escaping). Semantic-only
    -- hits have no exact term to highlight, so we surface the nearest chunk's text.
    case
      when page.lex_rank is not null then
        ts_headline('simple', page.transcript, q,
          'StartSel=' || chr(57344) || ',StopSel=' || chr(57345) ||
          ',MaxFragments=2,MinWords=6,MaxWords=20,FragmentDelimiter= … ')
      else left(coalesce(page.sem_content, ''), 300)
    end as snippet,
    -- Deep-link timestamp: prefer the exact lexical cue (exact word -> exact
    -- second, most trustworthy for an FCC proof), else the semantic chunk's
    -- start. Never fabricated — both are real offsets, null when neither exists.
    coalesce(cue.start_ms, page.sem_start_ms) as start_ms,
    case when page.lex_rank is not null then 'lexical' else 'semantic' end as match_type,
    counted.n as total_count
  from page
  join public.episode_log e on e.id = page.episode_id
  cross join counted
  left join lateral (
    select c.start_ms
    from public.transcript_cues c
    where page.lex_rank is not null
      and c.episode_id = page.episode_id
      and c.text_fts @@ q
    order by ts_rank(c.text_fts, q) desc, c.cue_idx asc
    limit 1
  ) cue on true
  order by page.score desc, page.episode_id desc;
end;
$$;

revoke all on function public.search_transcripts_hybrid(uuid, text, text, text, date, date, int, int, int, int) from public;
grant execute on function public.search_transcripts_hybrid(uuid, text, text, text, date, date, int, int, int, int) to authenticated;
