-- Phase B: Add station_id to tenant-scoped tables, backfill existing rows to
-- KPFK, and make uniqueness per-station. Additive + backfill only — no data
-- is dropped or truncated. All existing rows belong to KPFK (single tenant
-- history), so they backfill to the KPFK station seeded in 012.

-- The fixed KPFK station id from 012.
-- (Kept inline rather than via a sub-select so the backfill is deterministic.)

-- ---------------------------------------------------------------------------
-- Tables that get a station_id column. Order per table is mandatory:
--   ADD COLUMN (nullable) -> backfill -> SET NOT NULL
-- Never add a NOT NULL column to a populated table without backfilling first.
-- ---------------------------------------------------------------------------

-- episode_log
alter table public.episode_log
  add column if not exists station_id uuid references public.stations(id);
update public.episode_log
  set station_id = '00000000-0000-4000-8000-000000000001'::uuid
  where station_id is null;
alter table public.episode_log
  alter column station_id set not null;

-- show_keys
alter table public.show_keys
  add column if not exists station_id uuid references public.stations(id);
update public.show_keys
  set station_id = '00000000-0000-4000-8000-000000000001'::uuid
  where station_id is null;
alter table public.show_keys
  alter column station_id set not null;

-- qir_drafts
alter table public.qir_drafts
  add column if not exists station_id uuid references public.stations(id);
update public.qir_drafts
  set station_id = '00000000-0000-4000-8000-000000000001'::uuid
  where station_id is null;
alter table public.qir_drafts
  alter column station_id set not null;

-- transcript_corrections
alter table public.transcript_corrections
  add column if not exists station_id uuid references public.stations(id);
update public.transcript_corrections
  set station_id = '00000000-0000-4000-8000-000000000001'::uuid
  where station_id is null;
alter table public.transcript_corrections
  alter column station_id set not null;

-- compliance_wordlist
alter table public.compliance_wordlist
  add column if not exists station_id uuid references public.stations(id);
update public.compliance_wordlist
  set station_id = '00000000-0000-4000-8000-000000000001'::uuid
  where station_id is null;
alter table public.compliance_wordlist
  alter column station_id set not null;

-- usage_log: denormalized station_id for fast per-station cost rollups.
-- Backfill primarily via episode_id -> episode_log.station_id; usage_log rows
-- whose episode was deleted (episode_id is null) fall back to KPFK, since all
-- historical usage is KPFK's.
alter table public.usage_log
  add column if not exists station_id uuid references public.stations(id);
update public.usage_log u
  set station_id = e.station_id
  from public.episode_log e
  where u.episode_id = e.id and u.station_id is null;
update public.usage_log
  set station_id = '00000000-0000-4000-8000-000000000001'::uuid
  where station_id is null;
alter table public.usage_log
  alter column station_id set not null;

-- ---------------------------------------------------------------------------
-- Tables that inherit scope via FK (no station_id column):
--   transcripts      -> via episode_id -> episode_log
--   compliance_flags -> via episode_id -> episode_log
-- RLS (014) enforces their isolation through the episode_log join.
--
-- qir_settings is intentionally NOT given a station_id: it stays the GLOBAL
-- default layer. Per-station overrides live in station_settings (012); the
-- resolution order (override -> global -> hardcoded default) is wired in
-- Phase G.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Per-station uniqueness + access-pattern indexes.
-- ---------------------------------------------------------------------------

-- show_keys: a show key is only unique WITHIN a station. Drop any pre-existing
-- global unique on (key) (the table predates these migrations), then add the
-- composite. The DO block finds the constraint by shape so it works regardless
-- of its name.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'show_keys'
      and con.contype = 'u'
      and con.conkey = array[
        (select attnum from pg_attribute
         where attrelid = rel.oid and attname = 'key')
      ]
  loop
    execute format('alter table public.show_keys drop constraint %I', c.conname);
  end loop;
end $$;
-- also drop a bare unique index on (key) if one exists under the default name
drop index if exists public.show_keys_key_key;

alter table public.show_keys
  add constraint show_keys_station_key_unique unique (station_id, key);

-- qir_drafts: one final report per station per quarter.
drop index if exists public.idx_qir_draft_active;
create unique index if not exists idx_qir_draft_active
  on public.qir_drafts(station_id, year, quarter) where status = 'final';

-- Access-pattern indexes for the new per-station queries.
create index if not exists idx_episode_station_status
  on public.episode_log(station_id, status);
create index if not exists idx_qir_drafts_station_yq
  on public.qir_drafts(station_id, year, quarter);
create index if not exists idx_show_keys_station_active
  on public.show_keys(station_id, active);
create index if not exists idx_usage_station
  on public.usage_log(station_id);
