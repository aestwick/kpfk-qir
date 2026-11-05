-- 051: search upkeep fixes from review. Idempotent.
--
-- 1. refresh_search_vocab() tracked progress by episode id, but transcripts
--    land out of id order (priority queue, retries, re-transcriptions), so a
--    transcript whose episode id was below the watermark when it arrived was
--    never folded into search_vocab. Track by transcripts (created_at, id)
--    instead. Existing stations start 10 minutes before their first fill
--    (overlap only double-counts a few words' ndoc — harmless for ranking).
-- 2. search_transcripts_v2(): the "few transcript hits → also match phrases
--    per caption" gate (050) counted matches across ALL stations; count this
--    station's only.

alter table public.search_vocab_state
  add column if not exists last_created_at timestamptz,
  add column if not exists last_transcript_id int not null default 0;

update public.search_vocab_state
   set last_created_at = updated_at - interval '10 minutes'
 where last_created_at is null;

create or replace function public.refresh_search_vocab(p_station_id uuid, p_batch int default 150)
returns int
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_ts  timestamptz;
  v_tid int;
  v_ids bigint[];
  v_last_ts timestamptz;
  v_last_tid int;
begin
  insert into public.search_vocab_state (station_id, last_created_at) values (p_station_id, '-infinity')
    on conflict (station_id) do nothing;
  select coalesce(last_created_at, '-infinity'), last_transcript_id into v_ts, v_tid
    from public.search_vocab_state where station_id = p_station_id for update;

  with batch as (
    select t.id, t.episode_id, t.created_at
    from public.transcripts t
    join public.episode_log e on e.id = t.episode_id
    where e.station_id = p_station_id
      and (t.created_at, t.id) > (v_ts, v_tid)
    order by t.created_at, t.id
    limit greatest(p_batch, 1)
  ),
  last_row as (select created_at, id from batch order by created_at desc, id desc limit 1)
  select (select array_agg(episode_id::bigint) from batch), l.created_at, l.id
    into v_ids, v_last_ts, v_last_tid
  from last_row l;

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
     set last_created_at = v_last_ts, last_transcript_id = v_last_tid, updated_at = now()
   where station_id = p_station_id;
  return coalesce(array_length(v_ids, 1), 0);
end;
$$;
revoke all on function public.refresh_search_vocab(uuid, int) from public, authenticated, anon;
grant execute on function public.refresh_search_vocab(uuid, int) to service_role;

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
set enable_seqscan = off
set enable_indexscan = off
as $$
declare
  q   tsquery;
  qa  tsquery;
  opts text := 'StartSel=' || chr(57344) || ',StopSel=' || chr(57345);
  v_phrase boolean;
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
  v_phrase := position('<->' in q::text) > 0;

  return query
  with tmatch as materialized (
    select t.episode_id as m_id
    from public.transcripts t
    join public.episode_log e on e.id = t.episode_id
    where t.transcript_fts @@ q
      and e.station_id = p_station_id
  ),
  -- Phrase queries also match caption by caption: a transcript-level tsvector
  -- clamps word positions at 16,383, so a phrase said late in a long show
  -- can't match there. Only for phrases with few transcript hits (the gate is
  -- a one-time filter, so the caption scan never runs for common phrases).
  cmatch as (
    select distinct c.episode_id as m_id
    from public.transcript_cues c
    where v_phrase
      and (select count(*) from tmatch) < 200
      and c.text_fts @@ q
  ),
  matched as materialized (
    select x.m_id, e.air_date as m_air_date
    from (select m_id from tmatch union select m_id from cmatch) x
    join public.episode_log e on e.id = x.m_id
    where e.station_id = p_station_id
      and (p_show_keys is null or e.show_key = any(p_show_keys))
      and (p_start_date is null or e.air_date >= p_start_date)
      and (p_end_date   is null or e.air_date <= p_end_date)
  ),
  counted as (select count(*)::bigint as n from matched),
  recent as (
    select m_id from matched order by m_air_date desc nulls last, m_id desc limit 200
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
