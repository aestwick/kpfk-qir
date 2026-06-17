-- API keys — programmatic, station-scoped read access for external consumers
-- (e.g. a sibling podcast app pulling captions/VTT and generating tags). Each
-- key authenticates as exactly ONE station and carries a scope set + a
-- per-minute rate limit. The raw secret is never stored: we keep a sha256 hash
-- (key_hash) plus a short, non-secret key_prefix for identification in the UI.
--
-- The keyed read API (app/api/v1/*) runs as the service role (RLS bypassed) and
-- guards tenancy with an explicit station_id filter on every query — mirroring
-- the worker convention (see 014_rls.sql header). The RLS below is the hard
-- backstop for any OTHER access path: keys are secret, so there is no public
-- policy; members may read their station's key metadata, and only station admins
-- (or super_admins) may mint/revoke. The API authenticator reads key_hash via
-- the service role, so anon/authenticated clients never select the hash.

create table if not exists public.api_keys (
  id               bigint generated always as identity primary key,
  station_id       uuid not null references public.stations(id) on delete cascade,
  name             text not null,
  -- First chars of the raw key (e.g. "qir_live_ab12"). Non-secret; shown in the
  -- UI so an operator can recognize which key a row corresponds to.
  key_prefix       text not null,
  -- sha256(raw key), hex. Unique so lookups are a single indexed equality.
  key_hash         text not null unique,
  -- Granted read scopes. Defaults cover the common podcast-app needs; add
  -- 'transcripts' explicitly to expose captions/VTT.
  scopes           text[] not null default array['qir','episodes','shows','usage'],
  rate_limit_per_min int not null default 60,
  active           boolean not null default true,
  last_used_at     timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now()
);

comment on table public.api_keys is 'Station-scoped API keys for the programmatic read API (app/api/v1/*). Stores a sha256 hash of the secret, never the secret itself.';

create index if not exists idx_api_keys_station on public.api_keys (station_id);
-- key_hash already has a unique index from the column constraint.

-- ---------------------------------------------------------------------------
-- RLS — secret table. No public policy. Members read their station's key
-- metadata; only station admins / super_admins write. Mirrors the
-- user_is_station_admin() pattern from 019_member_management.sql.
-- ---------------------------------------------------------------------------
alter table public.api_keys enable row level security;

drop policy if exists api_keys_select on public.api_keys;
create policy api_keys_select on public.api_keys
  for select using (station_id in (select public.user_station_ids()));

drop policy if exists api_keys_admin_write on public.api_keys;
create policy api_keys_admin_write on public.api_keys
  for all using (public.user_is_station_admin(station_id))
  with check (public.user_is_station_admin(station_id));

-- ---------------------------------------------------------------------------
-- Audit — wire the append-only audit trigger onto api_keys so every mint /
-- revoke / edit is recorded (see 028_audit_log.sql; new tenant tables must be
-- attached here). key_hash is short so it isn't redacted, but it is only a hash.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_audit on public.api_keys;
create trigger trg_audit after insert or update or delete on public.api_keys
  for each row execute function public.audit_row_change();
