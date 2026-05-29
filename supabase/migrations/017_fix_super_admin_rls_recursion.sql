-- FIX: the super_admins-related policies in 014 inline a subquery that reads
-- public.super_admins directly. On the super_admins table that self-reference
-- makes Postgres throw "infinite recursion detected in policy for relation
-- super_admins" at plan time; the station_users/stations policies that read
-- super_admins trip the same recursion transitively. Because getStationContext
-- queries super_admins and station_users with the RLS client on every request,
-- this breaks ALL authenticated access the moment RLS is enabled.
--
-- Fix: move the membership check into a SECURITY DEFINER helper (same pattern as
-- user_station_ids()), whose internal read bypasses RLS, and recreate the
-- offending policies to call it instead of inlining the subquery.
-- (014 is append-only; we drop/recreate the specific policies here.)

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.super_admins where user_id = auth.uid());
$$;

revoke all on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated, anon;

-- super_admins: own row, or any row for super admins (no self-recursion now).
drop policy if exists super_admins_select on public.super_admins;
create policy super_admins_select on public.super_admins
  for select using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists super_admins_write on public.super_admins;
create policy super_admins_write on public.super_admins
  for all using (public.is_super_admin())
  with check (public.is_super_admin());

-- station_users: own membership rows, plus full management for super admins.
drop policy if exists station_users_select on public.station_users;
create policy station_users_select on public.station_users
  for select using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists station_users_write on public.station_users;
create policy station_users_write on public.station_users
  for all using (public.is_super_admin())
  with check (public.is_super_admin());

-- stations: writes restricted to super admins.
drop policy if exists stations_write on public.stations;
create policy stations_write on public.stations
  for all using (public.is_super_admin())
  with check (public.is_super_admin());
