-- Phase A: Multi-tenant foundation — tenant tables + seed KPFK as first station.
-- No behavior change yet; later migrations add station_id columns (013) and RLS (014).

-- Tenant key. Every tenant-scoped table will reference stations(id).
create table if not exists public.stations (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,                       -- URL-safe tenant key, e.g. 'kpfk'
  name text not null,                              -- display name, e.g. 'KPFK, Los Angeles'
  timezone text default 'America/Los_Angeles',
  -- RSS base used by workers/ingest.ts. Stored as the full prefix up to and
  -- including '?id=' so the worker appends the show key: rss_base_url || show.key
  -- (e.g. 'https://archive.kpfk.org/getrss.php?id=').
  rss_base_url text,
  -- Replaces the hardcoded 'kpfk' prefix in lib/parse-mp3-url.ts's filename regex
  -- (matches '<prefix>_YYMMDD_HHMMSS<suffix>.mp3').
  mp3_filename_prefix text,
  -- Replaces the hardcoded station-ID detection alternation in workers/compliance.ts.
  station_id_patterns text[],
  created_at timestamptz default now()
);

-- Maps auth users to stations with a role. Many-to-many.
create table if not exists public.station_users (
  id bigserial primary key,
  station_id uuid not null references public.stations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor', 'admin')),
  created_at timestamptz default now(),
  unique (station_id, user_id)
);
create index if not exists idx_station_users_user on public.station_users(user_id);
create index if not exists idx_station_users_station on public.station_users(station_id);

-- Global super admins who can access all stations (used by RLS in 014).
-- Chosen over a boolean column for cleaner RLS membership queries.
create table if not exists public.super_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);

-- Per-station setting overrides. Global qir_settings remains the fallback layer
-- (resolution order wired up in Phase G).
create table if not exists public.station_settings (
  id bigserial primary key,
  station_id uuid not null references public.stations(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz default now(),
  unique (station_id, key)
);

-- Seed KPFK as the first station with a fixed UUID so later migrations and
-- backfills can reference it deterministically.
insert into public.stations (id, slug, name, timezone, rss_base_url, mp3_filename_prefix, station_id_patterns)
values (
  -- Fixed KPFK station id (valid hex UUID); referenced by the 013 backfill.
  '00000000-0000-4000-8000-000000000001'::uuid,
  'kpfk',
  'KPFK, Los Angeles',
  'America/Los_Angeles',
  'https://archive.kpfk.org/getrss.php?id=',
  'kpfk',
  array['kpfk', '90.7', 'ninety point seven']
)
on conflict (slug) do nothing;
