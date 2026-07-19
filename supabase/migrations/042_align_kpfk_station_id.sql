-- Align KPFK's station id with the canonical source of truth (the "beacon"
-- fundraising/giving system), which owns station identity across the operator's
-- apps. QIR originally seeded KPFK with a placeholder UUID
-- (00000000-0000-4000-8000-000000000001, migration 012) because no canonical id
-- existed yet; beacon's KPFK id is e4e747d0-b001-4b6c-be2c-ef5fe35dda95. This
-- migration repoints QIR's KPFK to that id so a future cross-app integration can
-- join on a single shared identifier instead of a GUID-mapping table.
--
-- station_id is a plain PK referenced by 10 FKs (all ON UPDATE NO ACTION, none
-- deferrable), so the change is done as: create the new canonical row -> repoint
-- every child -> delete the old placeholder row. The whole thing runs in one
-- DO block (one statement = one transaction), so any failure rolls back cleanly
-- and no partial/orphaned state is possible. FK checks stay ON throughout, which
-- also makes it self-protecting against a concurrent writer (a stray old-id
-- child left behind makes the final DELETE fail and the whole swap roll back).
--
-- Idempotent: guarded on the placeholder row still existing, so a deploy that
-- runs after the swap was applied by hand (via ops) is a harmless no-op.
-- Nothing here is keyed on the UUID literal in code/views/policies — tenant
-- isolation is data-driven through user_station_ids()/station_users — so
-- repointing the rows is the entire job. Public report URLs resolve by slug
-- ('kpfk'), not id, so filed FCC links are unaffected.

do $$
declare
  old_id constant uuid := '00000000-0000-4000-8000-000000000001';
  new_id constant uuid := 'e4e747d0-b001-4b6c-be2c-ef5fe35dda95';
  has_old boolean;
  has_new boolean;
begin
  select exists (select 1 from public.stations where id = old_id) into has_old;
  select exists (select 1 from public.stations where id = new_id) into has_new;

  -- Already aligned (placeholder gone): nothing to do.
  if not has_old then
    raise notice '042: KPFK placeholder id % absent - already aligned, skipping.', old_id;
    return;
  end if;

  -- Both rows present should never happen; refuse to guess rather than corrupt.
  if has_new then
    raise exception '042: both placeholder % and target % station rows exist - resolve manually.', old_id, new_id;
  end if;

  -- Defensive: the placeholder row must actually be KPFK.
  if not exists (select 1 from public.stations where id = old_id and slug = 'kpfk') then
    raise exception '042: station % is not slug=kpfk - aborting.', old_id;
  end if;

  -- 1. Free the unique slug, then materialize the canonical KPFK row at the
  --    beacon id as a faithful copy of the placeholder (preserving created_at,
  --    tier, ingest config, etc.).
  update public.stations set slug = 'kpfk__migrating_042' where id = old_id;

  insert into public.stations
    (id, slug, name, timezone, rss_base_url, mp3_filename_prefix, station_id_patterns,
     created_at, show_name_strip_prefixes, tier, confessor_base_url, ingest_primary)
  select
     new_id, 'kpfk', name, timezone, rss_base_url, mp3_filename_prefix, station_id_patterns,
     created_at, show_name_strip_prefixes, tier, confessor_base_url, ingest_primary
  from public.stations
  where id = old_id;

  -- 2. Repoint every child (all 10 FKs to stations). audit_log MUST be repointed
  --    here, before the DELETE below, so its ON DELETE SET NULL cannot null out
  --    KPFK's historical audit attribution.
  update public.episode_log            set station_id = new_id where station_id = old_id;
  update public.usage_log              set station_id = new_id where station_id = old_id;
  update public.show_keys              set station_id = new_id where station_id = old_id;
  update public.qir_drafts             set station_id = new_id where station_id = old_id;
  update public.compliance_wordlist    set station_id = new_id where station_id = old_id;
  update public.transcript_corrections set station_id = new_id where station_id = old_id;
  update public.station_settings       set station_id = new_id where station_id = old_id;
  update public.station_users          set station_id = new_id where station_id = old_id;
  update public.api_keys               set station_id = new_id where station_id = old_id;
  update public.audit_log              set station_id = new_id where station_id = old_id;

  -- 3. Drop the old placeholder row. No child references it now, so the FK
  --    (NO ACTION) is satisfied; if any stray reference remained this would fail
  --    and roll back the entire swap.
  delete from public.stations where id = old_id;

  raise notice '042: KPFK station id aligned % -> %.', old_id, new_id;
end $$;
