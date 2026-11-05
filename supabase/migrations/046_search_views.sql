-- 046: search that works — fast, forgiving, and episode-level semantic.
-- Idempotent (create … if not exists / create or replace); additive only —
-- nothing is dropped or rewritten, the old search RPCs stay for compatibility.
--
-- Why (measured on the live DB, 2026-11-04):
--   * Every transcript search by a signed-in user timed out. Under RLS the
--     planner can't push the (non-leakproof) `@@` match into the GIN index
--     ahead of the security qual, so `search_transcripts` seq-scanned all
--     ~6.5k transcripts: "Prosegur" (1 hit) took 21.9s as `authenticated`
--     vs 0.3s as owner. PostgREST cuts at 8s → HTTP 500 → the page said
--     "No matches". Fix: SECURITY DEFINER search functions that check station
--     membership explicitly (user_station_ids(), the same rule RLS uses) and
--     then run index-backed queries.
--   * Exact-form matching only ('simple' config): "Hartmann" found 2 episodes
--     while Whisper wrote "Hartman" in 401; "movilizacion" missed
--     "movilización"; "immigrant" missed "immigrants". Fix: a per-station word
--     vocabulary (search_vocab, trigram-indexed, accent-folded) the app uses to
--     expand each query term into the spellings that actually occur.
--   * Per-chunk embeddings can't scale here (HNSW insert ≈1s/row; index already
--     larger than shared_buffers). Fix: one vector per episode
--     (episode_embeddings, no ANN index — exact scan over ~10k rows).
--   * Guests/hosts had no search at all. Fix: search_people() splits the
--     free-text host/guest fields into names and fuzzy-matches them.

set search_path = public, extensions;

create extension if not exists unaccent with schema extensions;

-- Lower-case + strip accents. IMMUTABLE wrapper (unaccent() itself is only
-- STABLE because its dictionary is configurable) so it can back stored columns.
create or replace function public.qir_fold(p text)
returns text
language sql
immutable
parallel safe
set search_path = public, extensions
as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p, '')))
$$;

-- Internal guard shared by every function below: the caller must be a member
-- of the station (or super-admin, via user_station_ids()), or the service role.
create or replace function public.qir_assert_station_member(p_station_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return;
  end if;
  if p_station_id is null or not exists (
    select 1 from public.user_station_ids() s where s = p_station_id
  ) then
    raise exception 'not a member of this station' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.qir_assert_station_member(uuid) from public;
grant execute on function public.qir_assert_station_member(uuid) to authenticated, service_role;

-- Broadcast Day / Show report read episode_log by date.
create index if not exists idx_episode_log_station_air
  on public.episode_log (station_id, air_date, air_start);

-- ---------------------------------------------------------------------------
-- 1. Word vocabulary (for typo / accent / plural expansion)
-- ---------------------------------------------------------------------------
create table if not exists public.search_vocab (
  station_id uuid not null references public.stations(id) on delete cascade,
  word       text not null,           -- lexeme as stored in transcript_fts
  folded     text not null,           -- qir_fold(word)
  ndoc       int  not null default 0, -- transcripts containing it
  primary key (station_id, word)
);
create index if not exists idx_search_vocab_folded on public.search_vocab (station_id, folded);
create index if not exists idx_search_vocab_trgm on public.search_vocab using gin (folded gin_trgm_ops);

create table if not exists public.search_vocab_state (
  station_id      uuid primary key references public.stations(id) on delete cascade,
  last_episode_id bigint not null default 0,
  updated_at      timestamptz not null default now()
);

alter table public.search_vocab enable row level security;
alter table public.search_vocab_state enable row level security;
drop policy if exists search_vocab_select on public.search_vocab;
create policy search_vocab_select on public.search_vocab
  for select using (station_id in (select public.user_station_ids()));
-- No write policies: only the service role / the definer refresh function write.

-- Fold the next batch of a station's transcripts (by episode id, past the
-- watermark) into its vocabulary. Returns how many transcripts it processed;
-- call repeatedly until 0. Service-role only (workers / backfill script).
create or replace function public.refresh_search_vocab(p_station_id uuid, p_batch int default 150)
returns int
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_last bigint;
  v_ids bigint[];
  v_max bigint;
begin
  insert into public.search_vocab_state (station_id) values (p_station_id)
    on conflict (station_id) do nothing;
  select last_episode_id into v_last from public.search_vocab_state
    where station_id = p_station_id for update;

  select array_agg(id order by id), max(id) into v_ids, v_max from (
    select t.episode_id as id
    from public.transcripts t
    join public.episode_log e on e.id = t.episode_id
    where e.station_id = p_station_id and t.episode_id > v_last
    order by t.episode_id
    limit greatest(p_batch, 1)
  ) b;
  if v_ids is null then
    return 0;
  end if;

  insert into public.search_vocab (station_id, word, folded, ndoc)
  select p_station_id, s.word, public.qir_fold(s.word), s.ndoc
  from ts_stat(format(
    'select transcript_fts from public.transcripts where episode_id = any(%L::bigint[])', v_ids
  )) s
  where length(s.word) between 2 and 40
  on conflict (station_id, word) do update set ndoc = search_vocab.ndoc + excluded.ndoc;

  update public.search_vocab_state
    set last_episode_id = v_max, updated_at = now()
    where station_id = p_station_id;
  return coalesce(array_length(v_ids, 1), 0);
end;
$$;
revoke all on function public.refresh_search_vocab(uuid, int) from public, authenticated, anon;
grant execute on function public.refresh_search_vocab(uuid, int) to service_role;

-- Spellings of each query term that actually occur in this station's
-- transcripts: accent/case variants always; simple plural/singular forms; and,
-- for terms that are rare or absent (likely misspelled), trigram look-alikes.
-- The app builds the expanded tsquery from these (lib/search-query.ts).
create or replace function public.search_vocab_variants(p_station_id uuid, p_terms text[])
returns table (term text, variant text, ndoc int, kind text, sim real)
language plpgsql
stable
security definer
set search_path = public, extensions
set pg_trgm.similarity_threshold = 0.45
as $$
begin
  perform public.qir_assert_station_member(p_station_id);
  return query
  with terms as (
    select distinct t as term, public.qir_fold(t) as f
    from unnest(coalesce(p_terms, '{}'::text[])) t
    where length(t) between 2 and 40
  ),
  exact as (
    select tm.term, v.word as variant, v.ndoc, 'exact'::text as kind, 1::real as sim
    from terms tm
    join public.search_vocab v on v.station_id = p_station_id and v.folded = tm.f
  ),
  inflect as (
    select tm.term, v.word, v.ndoc, 'inflection'::text, 0.9::real
    from terms tm
    join public.search_vocab v on v.station_id = p_station_id
      and v.folded in (tm.f || 's', tm.f || 'es', regexp_replace(tm.f, 'e?s$', ''))
      and v.folded <> tm.f
    where length(tm.f) >= 4
  ),
  exact_df as (
    select tm.term, tm.f, coalesce(sum(e.ndoc), 0) as df
    from terms tm left join exact e on e.term = tm.term
    group by tm.term, tm.f
  ),
  fuzzy as (
    select x.term, x.word, x.ndoc, 'fuzzy'::text, x.s
    from (
      select d.term, v.word, v.ndoc, similarity(v.folded, d.f) as s,
             row_number() over (partition by d.term order by similarity(v.folded, d.f) desc, v.ndoc desc) as rn
      from exact_df d
      join public.search_vocab v on v.station_id = p_station_id and v.folded % d.f
      where length(d.f) >= 4
        and d.df < 30                      -- only rare/absent terms get typo help
        and v.folded <> d.f
        and left(v.folded, 1) = left(d.f, 1) -- typos rarely change the first letter
        and (similarity(v.folded, d.f) >= 0.6 or v.ndoc >= 3)
    ) x
    where x.rn <= 4
  )
  select * from exact
  union all select * from inflect
  union all select * from fuzzy;
end;
$$;
revoke all on function public.search_vocab_variants(uuid, text[]) from public;
grant execute on function public.search_vocab_variants(uuid, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Transcript search v2 — index-backed, moment-aware
-- ---------------------------------------------------------------------------
-- p_tsquery      : to_tsquery('simple') text built by the app (expanded terms)
-- p_any_tsquery  : same terms OR'd — used only to find a moment when the full
--                  query matches no single cue (phrase split across cues)
-- p_show_keys    : null = all shows; else the feed keys of a show group
-- Ranking: ts_rank normalised by document length (flag 1), so a 3-hour talk
-- show doesn't outrank a focused segment just by being long; only the 1,000
-- most recent matches are ranked (rank detoasts each tsvector — the cost that
-- made broad words like "people" take ~56s).
create or replace function public.search_transcripts_v2(
  p_station_id   uuid,
  p_tsquery      text,
  p_any_tsquery  text default null,
  p_show_keys    text[] default null,
  p_start_date   date default null,
  p_end_date     date default null,
  p_limit        int default 20,
  p_offset       int default 0
)
returns table (
  episode_id   bigint,
  show_key     text,
  show_name    text,
  air_date     date,
  air_start    time,
  host         text,
  guest        text,
  status       text,
  rank         real,
  snippet      text,
  start_ms     int,
  cue_snippet  text,
  total_count  bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  q   tsquery;
  qa  tsquery;
  opts text := 'StartSel=' || chr(57344) || ',StopSel=' || chr(57345);
begin
  perform public.qir_assert_station_member(p_station_id);
  begin
    q := to_tsquery('simple', coalesce(p_tsquery, ''));
    qa := case when p_any_tsquery is null or p_any_tsquery = '' then null else to_tsquery('simple', p_any_tsquery) end;
  exception when others then
    raise exception 'invalid search query' using errcode = '22023';
  end;
  if q is null or numnode(q) = 0 then
    return;
  end if;

  return query
  with matched as materialized (
    select t.episode_id as m_id, e.air_date as m_air_date
    from public.transcripts t
    join public.episode_log e on e.id = t.episode_id
    where t.transcript_fts @@ q
      and e.station_id = p_station_id
      and (p_show_keys is null or e.show_key = any(p_show_keys))
      and (p_start_date is null or e.air_date >= p_start_date)
      and (p_end_date   is null or e.air_date <= p_end_date)
  ),
  counted as (select count(*)::bigint as n from matched),
  recent as (
    select m_id from matched order by m_air_date desc nulls last, m_id desc limit 1000
  ),
  ranked as (
    select r.m_id, ts_rank(t.transcript_fts, q, 1) as m_rank
    from recent r join public.transcripts t on t.episode_id = r.m_id
  ),
  page as (
    select rk.m_id, rk.m_rank, e.show_key, e.show_name, e.air_date, e.air_start,
           e.host, e.guest, e.status
    from ranked rk join public.episode_log e on e.id = rk.m_id
    order by rk.m_rank desc, e.air_date desc nulls last, rk.m_id desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select
    p.m_id::bigint, p.show_key, p.show_name, p.air_date, p.air_start, p.host, p.guest, p.status,
    p.m_rank,
    ts_headline('simple', t.transcript, q,
      opts || ',MaxFragments=2,MinWords=6,MaxWords=20,FragmentDelimiter= … '),
    cue.c_start,
    case when cue.c_text is null then null
         else ts_headline('simple', cue.c_text, coalesce(case when cue.c_full then q end, qa, q),
                opts || ',HighlightAll=true') end,
    counted.n
  from page p
  join public.transcripts t on t.episode_id = p.m_id
  cross join counted
  left join lateral (
    -- 1) a single cue matching the whole query
    (select c.start_ms as c_start, c.text as c_text, true as c_full, 1 as pri
       from public.transcript_cues c
      where c.episode_id = p.m_id and c.text_fts @@ q
      order by ts_rank(c.text_fts, q) desc, c.cue_idx
      limit 1)
    union all
    -- 2) a phrase split across two adjacent cues
    (select w.start_ms, w.txt, true, 2
       from (select c.start_ms, c.cue_idx,
                    c.text || ' ' || coalesce(lead(c.text) over (order by c.cue_idx), '') as txt
               from public.transcript_cues c where c.episode_id = p.m_id) w
      where to_tsvector('simple', w.txt) @@ q
      order by w.cue_idx
      limit 1)
    union all
    -- 3) the cue with most of the query's words
    (select c.start_ms, c.text, false, 3
       from public.transcript_cues c
      where qa is not null and c.episode_id = p.m_id and c.text_fts @@ qa
      order by ts_rank(c.text_fts, qa) desc, c.cue_idx
      limit 1)
    -- No outer ORDER BY: Append runs the branches in order, so LIMIT 1 stops
    -- at the first strategy that finds a cue (the costly cue-pair scan only
    -- runs when no single cue matched).
    limit 1
  ) cue on true
  order by p.m_rank desc, p.air_date desc nulls last, p.m_id desc;
end;
$$;
revoke all on function public.search_transcripts_v2(uuid, text, text, text[], date, date, int, int) from public;
grant execute on function public.search_transcripts_v2(uuid, text, text, text[], date, date, int, int) to authenticated, service_role;

-- Best moment in specific episodes for a query (used for meaning-matched hits
-- that the lexical pass didn't find). Prefers a cue with the query's words;
-- else, where per-chunk embeddings exist (older episodes), the nearest chunk.
create or replace function public.episode_moments(
  p_station_id  uuid,
  p_episode_ids bigint[],
  p_any_tsquery text default null,
  p_embedding   text default null
)
returns table (episode_id bigint, start_ms int, cue_text text)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  qa tsquery;
  emb vector(1536);
begin
  perform public.qir_assert_station_member(p_station_id);
  qa := case when coalesce(p_any_tsquery, '') = '' then null else to_tsquery('simple', p_any_tsquery) end;
  emb := case when p_embedding is null then null else p_embedding::vector(1536) end;
  return query
  select e.id::bigint, m.s, m.txt
  from public.episode_log e
  cross join lateral (
    (select c.start_ms as s, c.text as txt, 1 as pri
       from public.transcript_cues c
      where qa is not null and c.episode_id = e.id and c.text_fts @@ qa
      order by ts_rank(c.text_fts, qa) desc, c.cue_idx limit 1)
    union all
    (select k.start_ms, k.content, 2
       from public.transcript_chunks k
      where emb is not null and k.episode_id = e.id
      order by k.embedding <=> emb limit 1)
    limit 1
  ) m
  where e.station_id = p_station_id and e.id = any(p_episode_ids);
end;
$$;
revoke all on function public.episode_moments(uuid, bigint[], text, text) from public;
grant execute on function public.episode_moments(uuid, bigint[], text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Episode-level embeddings ("Smart" search by meaning)
-- ---------------------------------------------------------------------------
create table if not exists public.episode_embeddings (
  episode_id   bigint primary key references public.episode_log(id) on delete cascade,
  station_id   uuid not null references public.stations(id) on delete cascade,
  embedding    vector(1536) not null,
  content_hash text not null,
  model        text not null,
  updated_at   timestamptz not null default now()
);
create index if not exists idx_episode_embeddings_station on public.episode_embeddings (station_id);
alter table public.episode_embeddings enable row level security;
drop policy if exists episode_embeddings_select on public.episode_embeddings;
create policy episode_embeddings_select on public.episode_embeddings
  for select using (station_id in (select public.user_station_ids()));
-- Writes: service role only (summarize worker + backfill script).

create or replace function public.search_episodes_semantic(
  p_station_id uuid,
  p_embedding  text,
  p_show_keys  text[] default null,
  p_start_date date default null,
  p_end_date   date default null,
  p_limit      int default 50
)
returns table (episode_id bigint, distance real)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  emb vector(1536);
begin
  perform public.qir_assert_station_member(p_station_id);
  emb := p_embedding::vector(1536);
  return query
  select x.episode_id, (x.embedding <=> emb)::real
  from public.episode_embeddings x
  join public.episode_log e on e.id = x.episode_id
  where x.station_id = p_station_id
    and (p_show_keys is null or e.show_key = any(p_show_keys))
    and (p_start_date is null or e.air_date >= p_start_date)
    and (p_end_date   is null or e.air_date <= p_end_date)
  order by x.embedding <=> emb
  limit greatest(least(p_limit, 200), 1);
end;
$$;
revoke all on function public.search_episodes_semantic(uuid, text, text[], date, date, int) from public;
grant execute on function public.search_episodes_semantic(uuid, text, text[], date, date, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. People (hosts + guests)
-- ---------------------------------------------------------------------------
-- host/guest are free text ("Dr. Gerald Horne, historian; Ana Lopez"). Split on
-- , ; & / " and " " y ", drop honorifics and fragments that aren't names, and
-- fold for matching. One row per (episode, role, name).
create or replace function public.qir_episode_people(p_station_id uuid)
returns table (episode_id bigint, role text, name text, folded text, air_date date, air_start time, show_key text, show_name text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with raw as (
    select e.id, 'host'::text as role, e.host as val, e.air_date, e.air_start, e.show_key, e.show_name
      from public.episode_log e
     where e.station_id = p_station_id and coalesce(e.host, '') <> '' and e.status <> 'archived'
    union all
    select e.id, 'guest', e.guest, e.air_date, e.air_start, e.show_key, e.show_name
      from public.episode_log e
     where e.station_id = p_station_id and coalesce(e.guest, '') <> '' and e.status <> 'archived'
  ),
  parts as (
    select r.*, btrim(regexp_replace(
             regexp_replace(p, '\([^)]*\)', '', 'g'),
             '^(dr|rev|reverend|prof|professor|congressman|congresswoman|rep|sen|senator|col|colonel|mr|mrs|ms|judge|mayor|councilmember|attorney)\.?\s+', '', 'i'),
           ' .-') as nm
      from raw r,
           regexp_split_to_table(r.val, '\s*(?:;|,|&|/|\s+and\s+|\s+y\s+)\s*') p
  )
  select id::bigint, role, nm, public.qir_fold(nm), air_date, air_start, show_key, show_name
    from parts
   where length(nm) between 4 and 40
     and nm !~ '[0-9@]'
     and nm ~ '^[[:upper:]]'
     and array_length(regexp_split_to_array(nm, '\s+'), 1) between 2 and 5
$$;
revoke all on function public.qir_episode_people(uuid) from public, anon, authenticated;

create or replace function public.search_people(p_station_id uuid, p_query text, p_limit int default 20)
returns table (folded text, name text, appearances bigint, as_host bigint, as_guest bigint,
               first_date date, last_date date, shows text[], score real)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  f text := public.qir_fold(btrim(coalesce(p_query, '')));
begin
  perform public.qir_assert_station_member(p_station_id);
  if length(f) < 2 then return; end if;
  return query
  with ppl as (select * from public.qir_episode_people(p_station_id)),
  scored as (
    select p.*, greatest(similarity(p.folded, f), word_similarity(p.folded, f), word_similarity(f, p.folded),
                         case when p.folded like '%' || f || '%' then 0.9 else 0 end)::real as s
      from ppl p
  )
  select s.folded,
         mode() within group (order by s.name),
         count(distinct s.episode_id),
         count(distinct s.episode_id) filter (where s.role = 'host'),
         count(distinct s.episode_id) filter (where s.role = 'guest'),
         min(s.air_date), max(s.air_date),
         (array_agg(distinct coalesce(s.show_name, s.show_key)))[1:6],
         max(s.s)
    from scored s
   where s.s >= 0.45
   group by s.folded
   order by max(s.s) desc, count(distinct s.episode_id) desc
   limit greatest(least(p_limit, 100), 1);
end;
$$;
revoke all on function public.search_people(uuid, text, int) from public;
grant execute on function public.search_people(uuid, text, int) to authenticated, service_role;

-- Every appearance of any of the given (folded) name spellings.
create or replace function public.person_appearances(p_station_id uuid, p_folded text[])
returns table (episode_id bigint, role text, name text, air_date date, air_start time,
               show_key text, show_name text, headline text, issue_category text, status text)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.qir_assert_station_member(p_station_id);
  return query
  select distinct on (p.episode_id, p.role)
         p.episode_id, p.role, p.name, p.air_date, p.air_start, p.show_key, p.show_name,
         e.headline, e.issue_category, e.status
    from public.qir_episode_people(p_station_id) p
    join public.episode_log e on e.id = p.episode_id
   where p.folded = any(p_folded)
   order by p.episode_id, p.role;
end;
$$;
revoke all on function public.person_appearances(uuid, text[]) from public;
grant execute on function public.person_appearances(uuid, text[]) to authenticated, service_role;

analyze public.transcripts;
