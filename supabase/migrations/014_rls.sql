-- Phase C: Row Level Security — the hard backstop. Cross-station reads/writes
-- become impossible at the database level regardless of app-layer bugs.
--
-- Note on the worker path: Supabase's service_role bypasses RLS by design, so
-- background workers (which use the service-role client) keep functioning.
-- For workers the app-layer station_id filter is therefore the only guard and
-- is enforced/reviewed in Phase F.

-- ---------------------------------------------------------------------------
-- Membership helper: the set of station_ids the current auth user may access.
-- Union of their station_users rows and, if they are a super_admin, all
-- stations. security definer so it can read membership tables under RLS.
-- ---------------------------------------------------------------------------
create or replace function public.user_station_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select station_id from public.station_users where user_id = auth.uid()
  union
  select s.id from public.stations s
  where exists (select 1 from public.super_admins sa where sa.user_id = auth.uid());
$$;

revoke all on function public.user_station_ids() from public;
grant execute on function public.user_station_ids() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Enable RLS on every tenant-scoped table and the tenant/membership tables.
-- ---------------------------------------------------------------------------
alter table public.episode_log            enable row level security;
alter table public.show_keys              enable row level security;
alter table public.qir_drafts             enable row level security;
alter table public.transcript_corrections enable row level security;
alter table public.compliance_wordlist    enable row level security;
alter table public.usage_log              enable row level security;
alter table public.transcripts            enable row level security;
alter table public.compliance_flags       enable row level security;
alter table public.stations               enable row level security;
alter table public.station_users          enable row level security;
alter table public.super_admins           enable row level security;
alter table public.station_settings       enable row level security;

-- ---------------------------------------------------------------------------
-- Direct station_id tables: members of the station get full access; writes are
-- gated on station membership (role-gating can be layered on later per plan).
-- ---------------------------------------------------------------------------

-- episode_log
create policy episode_log_select on public.episode_log
  for select using (station_id in (select public.user_station_ids()));
create policy episode_log_write on public.episode_log
  for all using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));

-- show_keys
create policy show_keys_select on public.show_keys
  for select using (station_id in (select public.user_station_ids()));
create policy show_keys_write on public.show_keys
  for all using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));

-- transcript_corrections
create policy corrections_select on public.transcript_corrections
  for select using (station_id in (select public.user_station_ids()));
create policy corrections_write on public.transcript_corrections
  for all using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));

-- compliance_wordlist
create policy wordlist_select on public.compliance_wordlist
  for select using (station_id in (select public.user_station_ids()));
create policy wordlist_write on public.compliance_wordlist
  for all using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));

-- usage_log
create policy usage_log_select on public.usage_log
  for select using (station_id in (select public.user_station_ids()));
create policy usage_log_write on public.usage_log
  for all using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));

-- qir_drafts: members get full access to their station's drafts; finalized
-- reports are additionally readable by anyone (the public report pages),
-- scoped tightly to status='final'.
create policy qir_drafts_select on public.qir_drafts
  for select using (station_id in (select public.user_station_ids()));
create policy qir_drafts_public_final on public.qir_drafts
  for select using (status = 'final');
create policy qir_drafts_write on public.qir_drafts
  for all using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));

-- ---------------------------------------------------------------------------
-- FK-scoped tables (no station_id column): isolate via the episode_log join.
-- ---------------------------------------------------------------------------

-- transcripts
create policy transcripts_select on public.transcripts
  for select using (exists (
    select 1 from public.episode_log e
    where e.id = transcripts.episode_id
      and e.station_id in (select public.user_station_ids())
  ));
create policy transcripts_write on public.transcripts
  for all using (exists (
    select 1 from public.episode_log e
    where e.id = transcripts.episode_id
      and e.station_id in (select public.user_station_ids())
  ))
  with check (exists (
    select 1 from public.episode_log e
    where e.id = transcripts.episode_id
      and e.station_id in (select public.user_station_ids())
  ));

-- compliance_flags
create policy compliance_flags_select on public.compliance_flags
  for select using (exists (
    select 1 from public.episode_log e
    where e.id = compliance_flags.episode_id
      and e.station_id in (select public.user_station_ids())
  ));
create policy compliance_flags_write on public.compliance_flags
  for all using (exists (
    select 1 from public.episode_log e
    where e.id = compliance_flags.episode_id
      and e.station_id in (select public.user_station_ids())
  ))
  with check (exists (
    select 1 from public.episode_log e
    where e.id = compliance_flags.episode_id
      and e.station_id in (select public.user_station_ids())
  ));

-- ---------------------------------------------------------------------------
-- Tenant / membership tables.
-- ---------------------------------------------------------------------------

-- stations: a user may read the stations they belong to (super_admins see all
-- via user_station_ids). Only super_admins may write. Public report pages
-- resolve a station by slug server-side using the service-role client.
create policy stations_select on public.stations
  for select using (id in (select public.user_station_ids()));
create policy stations_write on public.stations
  for all using (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()))
  with check (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()));

-- station_users: a user may read their own membership rows; only super_admins
-- may manage memberships.
create policy station_users_select on public.station_users
  for select using (
    user_id = auth.uid()
    or exists (select 1 from public.super_admins sa where sa.user_id = auth.uid())
  );
create policy station_users_write on public.station_users
  for all using (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()))
  with check (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()));

-- super_admins: a user may read their own row; only super_admins may manage.
create policy super_admins_select on public.super_admins
  for select using (
    user_id = auth.uid()
    or exists (select 1 from public.super_admins sa where sa.user_id = auth.uid())
  );
create policy super_admins_write on public.super_admins
  for all using (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()))
  with check (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()));

-- station_settings: members of the station may read/write their overrides.
create policy station_settings_select on public.station_settings
  for select using (station_id in (select public.user_station_ids()));
create policy station_settings_write on public.station_settings
  for all using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));
