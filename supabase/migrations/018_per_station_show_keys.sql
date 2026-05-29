-- Phase H: Make show keys unique PER STATION (not globally).
--
-- 013 added UNIQUE(station_id, key) on show_keys but had to KEEP the old global
-- UNIQUE(key) in place, because a foreign key (show_contacts.show_key_fkey)
-- depended on it. That global unique prevents two stations from ever sharing a
-- show key — but Pacifica stations DO share program names (Democracy Now! airs
-- on KPFK, WBAI, KPFA, ...), so per-station keys are required before any second
-- station can onboard.
--
-- This drops the dependent FK and the global unique, leaving only the composite
-- UNIQUE(station_id, key) from 013. After this, the same key may exist once per
-- station. QIR keeps its text-key model: episode_log.show_key joins shows within
-- a station via (station_id, show_key).
--
-- NOTE: the FK is dropped with CASCADE per project owner's decision. The
-- show_contacts table keeps its show_key values (no data is deleted); it simply
-- loses the referential-integrity check against show_keys.key.

-- Drop the dependent foreign key first (CASCADE covers any further dependents).
alter table public.show_contacts
  drop constraint if exists show_contacts_show_key_fkey cascade;

-- Now the global unique on show_keys.key can go. The composite
-- UNIQUE(station_id, key) added in 013 remains and is now the only uniqueness
-- guarantee on the key column.
alter table public.show_keys
  drop constraint if exists show_keys_key_key cascade;
