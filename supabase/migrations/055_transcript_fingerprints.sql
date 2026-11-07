-- Rerun detection (lib/rerun.ts, run by the compliance worker).
--
-- One compact fingerprint per transcript: a ~1-in-8 hash sample of its 4-word
-- shingles (~1,000 ints for an hour of talk, a few KB). Comparing an episode
-- against months of the same show then reads fingerprints, not full
-- transcripts. Rows are derived data: an episode's own row is rewritten each
-- time it is compliance-checked (so a re-transcribe refreshes it); a prior with
-- no row, or one from an older `version` (FINGERPRINT_VERSION), is computed
-- from its transcript the first time it is needed as a comparison.
--
-- Not in the audit trigger loop (028): it's a cache of transcripts, which are
-- already audited, and it would only add noise.

create table if not exists public.transcript_fingerprints (
  episode_id   bigint primary key references public.episode_log(id) on delete cascade,
  version      smallint not null,
  fingerprint  bigint[] not null,
  computed_at  timestamptz not null default now()
);

-- Members may read their station's rows (mirrors transcripts/transcript_cues);
-- there is no write policy, so only the service role (workers) writes.
alter table public.transcript_fingerprints enable row level security;

drop policy if exists transcript_fingerprints_select on public.transcript_fingerprints;
create policy transcript_fingerprints_select on public.transcript_fingerprints
  for select using (exists (
    select 1 from public.episode_log e
    where e.id = transcript_fingerprints.episode_id
      and e.station_id in (select public.user_station_ids())
  ));

revoke all on public.transcript_fingerprints from anon;
