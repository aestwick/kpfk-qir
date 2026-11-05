-- Names in transcripts: per-show correction scope, a per-show name list
-- ("vocabulary"), suggested corrections, and tracking for re-applying rules to
-- transcripts already stored. Design + measurements: docs/names-vocabulary-scan.md.
--
-- Why: Whisper spells the same hosts wrong week after week ("Carrie Harrison",
-- "Kevin Camps", "Matt Cedillo"). A misspelled name is invisible to search, ends
-- up in summaries, and the QIR lists hosts and guests. Most variants are only
-- safe to fix inside one show ("Nick Richard" is a real name elsewhere), so rules
-- need a show scope; and rules used to touch only FUTURE transcripts.
--
-- All parts idempotent.

-- ---------------------------------------------------------------------------
-- 1. transcript_corrections: show scope + backfill bookkeeping
-- ---------------------------------------------------------------------------
-- show_key: when set, the rule applies only to episodes of that show — every
-- feed in its show_keys.show_group, resolved at run time so a group rename
-- doesn't orphan the rule. Null = station-wide (or episode_id for one episode).
alter table public.transcript_corrections
  add column if not exists show_key text;

-- backfilled_at: when this rule was last re-applied to STORED transcripts. Null
-- means "not yet" — the corrections worker picks it up, rewrites matching
-- transcripts (text, captions, search cues, semantic chunks) and stamps it. The
-- API clears it whenever the rule's pattern, replacement, flags or scope change.
-- Existing rules start null, so they backfill on the first run after deploy.
alter table public.transcript_corrections
  add column if not exists backfilled_at timestamptz;

create index if not exists idx_transcript_corrections_pending_backfill
  on public.transcript_corrections (station_id)
  where active and backfilled_at is null;

-- ---------------------------------------------------------------------------
-- 2. transcript_vocabulary: correctly spelled names, per show
-- ---------------------------------------------------------------------------
-- One row per (show, name). show_key null = station-wide (call letters, network
-- names). Resolved through show_group at run time like the rule scope. Feeds the
-- Whisper vocabulary hint (talk shows only) and the suggested-corrections miner.
-- `active = false` keeps a name OUT (e.g. a CMS spelling the station overrides)
-- — the nightly CMS sync never re-adds a name that exists in any state.
create table if not exists public.transcript_vocabulary (
  id          bigint generated always as identity primary key,
  station_id  uuid not null references public.stations(id) on delete cascade,
  show_key    text,
  name        text not null check (length(btrim(name)) between 2 and 80),
  source      text not null default 'manual'
                check (source in ('manual', 'confessor', 'cms', 'website', 'correction')),
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists uq_transcript_vocabulary_name
  on public.transcript_vocabulary (station_id, coalesce(show_key, ''), lower(name));
create index if not exists idx_transcript_vocabulary_show
  on public.transcript_vocabulary (station_id, show_key);

-- ---------------------------------------------------------------------------
-- 3. transcript_correction_suggestions: miner output awaiting a human
-- ---------------------------------------------------------------------------
-- The nightly miner proposes "variant → correct" for a show. Nothing rewrites a
-- transcript until a person approves it in Settings → Corrections; approval
-- creates a transcript_corrections row (correction_id) which then backfills.
-- Rejected rows stay so the same suggestion never comes back.
create table if not exists public.transcript_correction_suggestions (
  id                bigint generated always as identity primary key,
  station_id        uuid not null references public.stations(id) on delete cascade,
  show_key          text,
  variant           text not null,
  correct           text not null,
  occurrences       integer not null default 0,
  episodes          integer not null default 0,
  sample_episode_id integer references public.episode_log(id) on delete set null,
  sample_text       text,
  status            text not null default 'suggested'
                      check (status in ('suggested', 'approved', 'rejected')),
  correction_id     integer references public.transcript_corrections(id) on delete set null,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        uuid
);

create unique index if not exists uq_transcript_correction_suggestions
  on public.transcript_correction_suggestions
  (station_id, coalesce(show_key, ''), lower(variant), lower(correct));
create index if not exists idx_transcript_correction_suggestions_status
  on public.transcript_correction_suggestions (station_id, status);

-- ---------------------------------------------------------------------------
-- 4. RLS — same shape as transcript_corrections (014): station members read and
--    write their station's rows; the API layers editor-role gating on top.
-- ---------------------------------------------------------------------------
alter table public.transcript_vocabulary enable row level security;
alter table public.transcript_correction_suggestions enable row level security;

drop policy if exists vocabulary_select on public.transcript_vocabulary;
create policy vocabulary_select on public.transcript_vocabulary
  for select using (station_id in (select public.user_station_ids()));
drop policy if exists vocabulary_write on public.transcript_vocabulary;
create policy vocabulary_write on public.transcript_vocabulary
  for all using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));

drop policy if exists correction_suggestions_select on public.transcript_correction_suggestions;
create policy correction_suggestions_select on public.transcript_correction_suggestions
  for select using (station_id in (select public.user_station_ids()));
drop policy if exists correction_suggestions_write on public.transcript_correction_suggestions;
create policy correction_suggestions_write on public.transcript_correction_suggestions
  for all using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));

-- ---------------------------------------------------------------------------
-- 5. Audit — attach the generic row-change trigger (migration 028) so every
--    name/suggestion edit is recorded like the rest of the tenant tables.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['transcript_vocabulary', 'transcript_correction_suggestions']
  loop
    if to_regprocedure('public.audit_row_change()') is null then
      raise notice 'audit: audit_row_change() missing, skipping %', t;
      continue;
    end if;
    execute format('drop trigger if exists trg_audit on public.%I;', t);
    execute format(
      'create trigger trg_audit after insert or update or delete on public.%I
         for each row execute function public.audit_row_change();', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. mine_name_variants — the miner's candidate search, run in the database so
--    transcripts never leave it. For every multi-word name in the station's
--    vocabulary, look in that show's recent transcripts (all feeds of its
--    show_group) for "<First> <Word>" or "<Word> <Last>" where BOTH words are
--    capitalized (Whisper capitalizes names; this drops "Kevin has"), the pair
--    differs from the name, and is trigram-similar to it. Returns aggregates
--    only. Pure read; SECURITY INVOKER (callers: service-role worker).
--    Measured 2026-11-05: finds Kevin Camps, Carrie Harrison, Sonali Kohatkar,
--    Brian DeShazer, Matt Cedillo, Nana Jumfi, Nick Richard on 60 days of KPFK.
-- ---------------------------------------------------------------------------
create or replace function public.mine_name_variants(
  p_station_id     uuid,
  p_since          date,
  p_min_similarity real default 0.4,
  p_min_count      integer default 3
)
returns table (
  show_key          text,
  name              text,
  variant           text,
  occurrences       integer,
  episodes          integer,
  sample_episode_id integer
)
language sql
stable
set search_path = public
as $$
  with grp as (
    -- Same identity as lib/shows.ts#showGroupKey: trimmed group, else key, case-folded.
    select k.key, lower(coalesce(nullif(btrim(k.show_group), ''), k.key)) as g
    from show_keys k
    where k.station_id = p_station_id
  ),
  vocab as (
    select distinct v.show_key, btrim(v.name) as name
    from transcript_vocabulary v
    where v.station_id = p_station_id
      and v.active
      and v.show_key is not null
      and btrim(v.name) ~ '\s'
  ),
  vg as (
    select v.name, v.show_key, gk.key as ep_key
    from vocab v
    join grp g1 on g1.key = v.show_key
    join grp gk on gk.g = g1.g
  ),
  parts as (
    select name, show_key, ep_key,
      regexp_replace(split_part(name, ' ', 1), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') as f,
      regexp_replace(regexp_replace(name, '^.*\s', ''), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') as l
    from vg
  ),
  eps as (
    select e.id, e.show_key, t.transcript
    from episode_log e
    join transcripts t on t.episode_id = e.id
    where e.station_id = p_station_id
      and e.air_date >= p_since
      and t.transcript is not null
  ),
  c as (
    select p.name, p.show_key, e.id as ep, m[1] as cand
    from parts p
    join eps e on e.show_key = p.ep_key
    cross join lateral regexp_matches(
      e.transcript,
      '(\m' || p.f || '\s+[[:alpha:]''’-]+\M|\m[[:alpha:]''’-]+\s+' || p.l || '\M)',
      'g'
    ) m
    where e.transcript ~* ('\m(' || p.f || '|' || p.l || ')\M')
  )
  select c.show_key,
         c.name,
         mode() within group (order by c.cand) as variant,
         count(*)::integer as occurrences,
         count(distinct c.ep)::integer as episodes,
         max(c.ep)::integer as sample_episode_id
  from c
  where c.cand ~ '^[[:upper:]][^[:space:]]*[[:space:]]+[[:upper:]]'
    and lower(c.cand) <> lower(c.name)
    and similarity(lower(c.cand), lower(c.name)) >= p_min_similarity
  group by c.show_key, c.name, lower(c.cand)
  having count(*) >= p_min_count
$$;

revoke all on function public.mine_name_variants(uuid, date, real, integer) from public, anon, authenticated;
