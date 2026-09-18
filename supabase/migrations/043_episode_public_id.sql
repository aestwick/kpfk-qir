-- 043_episode_public_id.sql
-- Opaque public identifier for episodes exposed through the /api/v1 read API.
--
-- episode_log.id is a bigserial: stable and never reused, but it leaks row
-- counts and ingest ordering to any external consumer, and it ties the public
-- contract to a physical storage detail. public_id is the identifier external
-- consumers key on: opaque, stable for the life of the row, and safe to hand
-- out. The integer id stays the internal primary key (and remains accepted on
-- the /api/v1/episodes/{id} routes so links already issued keep resolving).
--
-- Idempotent — safe to re-run if applied by hand before deploy.

alter table public.episode_log
  add column if not exists public_id uuid;

-- Backfill existing rows before the NOT NULL. gen_random_uuid() is core in
-- Postgres 13+; pgcrypto provides it on older servers and is present on Supabase.
update public.episode_log
   set public_id = gen_random_uuid()
 where public_id is null;

alter table public.episode_log
  alter column public_id set default gen_random_uuid();

alter table public.episode_log
  alter column public_id set not null;

create unique index if not exists episode_log_public_id_key
  on public.episode_log (public_id);

-- Keyset pagination index for GET /api/v1/episodes: the feed walks
-- (updated_at, id) ascending within one station, filtered to published rows.
create index if not exists episode_log_feed_keyset_idx
  on public.episode_log (station_id, updated_at, id);
