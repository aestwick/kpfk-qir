-- Two-layer compliance wordlist: a GLOBAL base list (super-admin managed, applies
-- to every station) PLUS per-station additions. The compliance worker flags on the
-- union (station rows ∪ global base). Stations can add their own local terms but
-- cannot remove a globally-required term — compliance rules are federal, so the
-- base is centralized while local context (station sponsors, local false-positive
-- names) stays per-station. See CLAUDE.md "Compliance settings".
--
-- A global-base row is identified by station_id IS NULL (previously NOT NULL,
-- migration 013). Existing per-station rows are untouched.

alter table public.compliance_wordlist
  alter column station_id drop not null;

-- RLS: members may READ their station's rows + the global base; station members
-- write their own station rows; only super-admins write the global base.
drop policy if exists wordlist_select on public.compliance_wordlist;
drop policy if exists wordlist_write on public.compliance_wordlist;
drop policy if exists wordlist_write_station on public.compliance_wordlist;
drop policy if exists wordlist_write_global on public.compliance_wordlist;

create policy wordlist_select on public.compliance_wordlist
  for select using (
    station_id is null
    or station_id in (select public.user_station_ids())
  );

-- Per-station writes (members of that station). station_id IS NULL rows fall
-- through to the global policy below, so a station member can't touch the base.
create policy wordlist_write_station on public.compliance_wordlist
  for all
  using (station_id in (select public.user_station_ids()))
  with check (station_id in (select public.user_station_ids()));

-- Global-base writes (station_id IS NULL): super-admins only.
create policy wordlist_write_global on public.compliance_wordlist
  for all
  using (
    station_id is null
    and exists (select 1 from public.super_admins sa where sa.user_id = auth.uid())
  )
  with check (
    station_id is null
    and exists (select 1 from public.super_admins sa where sa.user_id = auth.uid())
  );
