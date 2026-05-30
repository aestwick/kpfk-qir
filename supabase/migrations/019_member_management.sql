-- Member management: let a station's own admins read and manage that station's
-- memberships (previously only super_admins could, per 014_rls.sql). The
-- /api/members route authorizes callers in the app layer and writes via the
-- service role; these policies keep the RLS backstop aligned with that
-- capability (defense in depth) and scope it tightly to the admin's station.
--
-- super_admins remains writable only by super_admins (see 014_rls.sql) — a
-- station admin can manage their station's members but cannot grant global,
-- all-station access.

-- True when the current auth user may administer station `st`: a super_admin, or
-- an admin member of that station. security definer so it can read the
-- membership tables without recursing through their RLS policies.
create or replace function public.user_is_station_admin(st uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.super_admins sa where sa.user_id = auth.uid())
      or exists (
        select 1 from public.station_users su
        where su.user_id = auth.uid() and su.station_id = st and su.role = 'admin'
      );
$$;

revoke all on function public.user_is_station_admin(uuid) from public;
grant execute on function public.user_is_station_admin(uuid) to authenticated;

-- Station admins may read every membership row for stations they administer
-- (014's station_users_select only exposed a user's own rows + super_admins).
create policy station_users_admin_select on public.station_users
  for select using (public.user_is_station_admin(station_id));

-- Station admins may insert/update/delete membership rows for their station.
-- with_check pins the target row's station to one they administer, so they can't
-- grant access to a station they don't run.
create policy station_users_admin_manage on public.station_users
  for all using (public.user_is_station_admin(station_id))
  with check (public.user_is_station_admin(station_id));
