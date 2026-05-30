-- Migration 023: Transcript semantic search (Phase 2, embeddings / pgvector)
-- Idempotent: safe to re-run.
--
-- Implements the semantic tier of ideas/TRANSCRIPT_SEARCH_SPEC.md §6.2 / §11:
--   1. pgvector extension + a transcript_chunks table holding timed, embedded
--      passages of each transcript (chunked from the VTT cues so every chunk
--      carries a start_ms/end_ms range for the audio deep-link).
--   2. An HNSW (cosine) index on the embedding for fast approximate-NN recall.
--   3. RLS scoping cues/chunks via the episode_id -> episode_log.station_id join
--      (no station_id column of their own — same as transcripts / transcript_cues).
--   4. A search_transcripts_hybrid() RPC that FUSES the Phase-1 lexical FTS
--      ranking with the vector-distance ranking (Reciprocal Rank Fusion). It
--      returns the same shape as search_transcripts() plus a match_type, so the
--      existing /api/transcript-search plumbing and UI snippet/deep-link work
--      unchanged. Lexical-only search (search_transcripts, migration 022) is left
--      untouched and stays the free, deterministic default.
--
-- The query embedding is computed by the app (one OpenAI embed/query — Tier 2 is
-- "light" per §5) and passed in as text, cast to vector here, so the RPC stays
-- parameterized and PostgREST never has to coerce a JSON array to a vector.
--
-- Embedding model: text-embedding-3-small (1536 dims). Changing to a model with
-- a different dimension requires re-embedding the corpus AND altering this column
-- — the query and the stored vectors must share model + dimension.

-- pgvector lives in the extensions schema on Supabase but may already be enabled
-- in public on other setups; widen the search_path so `vector`, `<=>`, `hnsw`
-- and `vector_cosine_ops` resolve regardless of where the extension landed.
create extension if not exists vector;
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. transcript_chunks — timed, embedded passages parsed from the VTT cues.
-- ---------------------------------------------------------------------------
create table if not exists public.transcript_chunks (
  id          bigint generated always as identity primary key,
  episode_id  bigint not null references public.episode_log(id) on delete cascade,
  chunk_idx   int    not null,
  start_ms    int    not null,
  end_ms      int    not null,
  content     text   not null,
  embedding   vector(1536) not null
);

create index if not exists idx_transcript_chunks_episode
  on public.transcript_chunks(episode_id);

-- HNSW over cosine distance: good recall, no list training, handles the
-- incremental inserts the summarize worker / backfill produce.
create index if not exists idx_transcript_chunks_embedding
  on public.transcript_chunks using hnsw (embedding vector_cosine_ops);

-- One row set per episode: re-embedding replaces an episode's chunks, so a unique
-- (episode_id, chunk_idx) keeps backfills / re-summarizes from duplicating chunks.
create unique index if not exists idx_transcript_chunks_episode_idx
  on public.transcript_chunks(episode_id, chunk_idx);

-- ---------------------------------------------------------------------------
-- 2. RLS — scope chunks via the episode_log join, mirroring transcript_cues (022).
-- ---------------------------------------------------------------------------
alter table public.transcript_chunks enable row level security;

drop policy if exists transcript_chunks_select on public.transcript_chunks;
create policy transcript_chunks_select on public.transcript_chunks
  for select using (exists (
    select 1 from public.episode_log e
    where e.id = transcript_chunks.episode_id
      and e.station_id in (select public.user_station_ids())
  ));

drop policy if exists transcript_chunks_write on public.transcript_chunks;
create policy transcript_chunks_write on public.transcript_chunks
  for all using (exists (
    select 1 from public.episode_log e
    where e.id = transcript_chunks.episode_id
      and e.station_id in (select public.user_station_ids())
  ))
  with check (exists (
    select 1 from public.episode_log e
    where e.id = transcript_chunks.episode_id
      and e.station_id in (select public.user_station_ids())
  ));

-- ---------------------------------------------------------------------------
-- 3. search_transcripts_hybrid() — RRF-fused lexical + semantic ranking.
-- ---------------------------------------------------------------------------
-- security invoker (the default) so the body runs under the caller's RLS; the
-- explicit p_station_id filter is defense in depth (house style), matching every
-- other route and search_transcripts() in 022.
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
as $$
declare
  q tsquery;
  v vector(1536);
begin
  -- Bound a pathological query so it can't pin a connection (slightly higher than
  -- the lexical 5s since the ANN scan + fusion does more work).
  set local statement_timeout = '8s';

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
