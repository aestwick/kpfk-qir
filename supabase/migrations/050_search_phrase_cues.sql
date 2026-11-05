-- 050: quoted phrases said late in long shows are found again. Idempotent.
--
-- Postgres caps tsvector word positions at 16,383; later words all sit at that
-- position, so a phrase (`<->`) said past roughly the first 100 minutes of a
-- long talk show never matches the transcript-level tsvector. Measured: "The
-- Hidden History of the War on Voting" matched 2 transcripts while 2 more say
-- it 53 and 84 minutes in. For phrase queries with few transcript hits, also
-- match per caption (transcript_cues.text_fts — short, no clamp): 0.28s live.
-- Same signature/output as 048; SET clauses restated (create or replace
-- resets them).

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
    where t.transcript_fts @@ q
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
