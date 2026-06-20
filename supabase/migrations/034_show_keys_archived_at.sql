-- Soft-delete (archive) support for show_keys.
--
-- archived_at NULL  = live show key (shown in the grid, eligible for ingest)
-- archived_at SET   = archived: hidden from the Shows grid by default, excluded
--                     from ingest, and never re-imported by the discovery sync.
--
-- Why a tombstone instead of a hard DELETE: discovery sync (workers/discover-sync)
-- decides what's "new" by diffing the archive's program list against the keys
-- already in show_keys. A hard-deleted key would look new again and get
-- re-inserted as inactive on the next sync. Keeping the row (archived) means the
-- key stays "known", so it never comes back — and Restore is just clearing the
-- column.
alter table show_keys add column if not exists archived_at timestamptz;

-- Partial index for the common "live keys for this station" lookups (ingest,
-- discovery dedupe, the default grid view).
create index if not exists idx_show_keys_station_live
  on show_keys (station_id)
  where archived_at is null;
