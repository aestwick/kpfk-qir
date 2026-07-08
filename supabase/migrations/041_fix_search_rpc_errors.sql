-- Migration 041: Fix both transcript-search RPCs erroring on every call.
-- Idempotent: safe to re-run (create or replace only).
--
-- Two distinct bugs, one symptom (the Search page showed "No matches" for
-- every query, because the route surfaced each error as a 500):
--
-- 1. search_transcripts() (lexical, the default mode) failed with
--      ERROR 42804: structure of query does not match function result type
--      DETAIL: Returned type integer does not match expected type bigint in column 1.
--    episode_log.id is integer in this database, but the RETURNS TABLE
--    declares episode_id bigint, and plpgsql RETURN QUERY does not coerce.
--    Fix: cast e.id::bigint in the query. The declared return type stays
--    bigint so the API shape (and transcript_cues/transcript_chunks, whose
--    episode_id columns are already bigint) is unchanged.
--
-- 2. search_transcripts_hybrid() (semantic mode) failed with
--      ERROR 42702: column reference "episode_id" is ambiguous
--    Its CTEs use bare column names (episode_id, start_ms, ...) that collide
--    with the function's own output columns, which plpgsql treats as
--    variables. Fix: prefix every CTE column (l_/s_/f_), mirroring the m_
--    convention migration 022 already used in the lexical function for
--    exactly this reason.
--
-- Only these mechanical fixes; query logic, signatures, return shapes,
-- ranking, snippet sentinels, timeouts and station scoping are identical
-- to migration 024.

-- ---------------------------------------------------------------------------
-- 1. search_transcripts() — lexical FTS.
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
set statement_timeout = '5s'
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
      e.id::bigint as m_episode_id,  -- episode_log.id is integer; RETURN QUERY needs the declared bigint
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
-- 2. search_transcripts_hybrid() — RRF-fused lexical + semantic.
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
set statement_timeout = '8s'
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
      e.id::bigint as l_episode_id,
      ts_rank(t.transcript_fts, q) as l_score,
      t.transcript as l_transcript,
      e.air_date   as l_air_date
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
    select l_episode_id, l_score, l_transcript,
      row_number() over (order by l_score desc, l_air_date desc nulls last, l_episode_id desc) as l_rank
    from lex
  ),
  -- Semantic side: nearest chunks by cosine distance (ANN pool), then collapse to
  -- the single best-matching chunk per episode (its start_ms + content drive the
  -- deep-link / snippet when an episode is a semantic-only hit).
  sem_pool as (
    select
      ch.episode_id as s_episode_id,
      ch.start_ms   as s_start_ms,
      ch.content    as s_content,
      (ch.embedding <=> v) as s_dist
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
    select distinct on (s_episode_id) s_episode_id, s_start_ms, s_content, s_dist
    from sem_pool
    order by s_episode_id, s_dist
  ),
  sem_ranked as (
    select s_episode_id, s_start_ms, s_content, s_dist,
      row_number() over (order by s_dist asc, s_episode_id desc) as s_rank
    from sem_best
  ),
  -- Reciprocal Rank Fusion: 1/(k+rank) summed across the lists an episode appears
  -- in. Scale-free, so it needs no normalizing of ts_rank vs cosine distance.
  fused as (
    select
      coalesce(l.l_episode_id, s.s_episode_id) as f_episode_id,
      (coalesce(1.0 / (p_rrf_k + l.l_rank), 0)
        + coalesce(1.0 / (p_rrf_k + s.s_rank), 0))::real as f_score,
      l.l_transcript as f_transcript,
      l.l_rank       as f_lex_rank,
      s.s_start_ms   as f_sem_start_ms,
      s.s_content    as f_sem_content
    from lex_ranked l
    full outer join sem_ranked s on l.l_episode_id = s.s_episode_id
  ),
  counted as (select count(*)::bigint as n from fused),
  page as (
    select * from fused
    order by f_score desc, f_episode_id desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select
    page.f_episode_id,
    e.show_key,
    e.show_name,
    e.air_date,
    e.status,
    page.f_score as rank,
    -- Lexical hits get the highlighted ts_headline (same private-use sentinels as
    -- migration 022, swapped for <mark> client-side after escaping). Semantic-only
    -- hits have no exact term to highlight, so we surface the nearest chunk's text.
    case
      when page.f_lex_rank is not null then
        ts_headline('simple', page.f_transcript, q,
          'StartSel=' || chr(57344) || ',StopSel=' || chr(57345) ||
          ',MaxFragments=2,MinWords=6,MaxWords=20,FragmentDelimiter= … ')
      else left(coalesce(page.f_sem_content, ''), 300)
    end as snippet,
    -- Deep-link timestamp: prefer the exact lexical cue (exact word -> exact
    -- second, most trustworthy for an FCC proof), else the semantic chunk's
    -- start. Never fabricated — both are real offsets, null when neither exists.
    coalesce(cue.start_ms, page.f_sem_start_ms) as start_ms,
    case when page.f_lex_rank is not null then 'lexical' else 'semantic' end as match_type,
    counted.n as total_count
  from page
  join public.episode_log e on e.id = page.f_episode_id
  cross join counted
  left join lateral (
    select c.start_ms
    from public.transcript_cues c
    where page.f_lex_rank is not null
      and c.episode_id = page.f_episode_id
      and c.text_fts @@ q
    order by ts_rank(c.text_fts, q) desc, c.cue_idx asc
    limit 1
  ) cue on true
  order by page.f_score desc, page.f_episode_id desc;
end;
$$;

revoke all on function public.search_transcripts_hybrid(uuid, text, text, text, date, date, int, int, int, int) from public;
grant execute on function public.search_transcripts_hybrid(uuid, text, text, text, date, date, int, int, int, int) to authenticated;
