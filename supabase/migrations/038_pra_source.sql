-- PRA (Pacifica Radio Archives) as a third episode source.
--
-- Alongside 'rss' and 'confessor', episodes can now originate from an operator's
-- own audio server — specifically the Cloudflare R2 `pra` bucket holding the
-- digitized Pacifica Radio Archives (1,946 .mp3 objects under a
-- "Flash Drive (64gb)/<collection>/…" key layout). These are archival segments,
-- not broadcasts: they have no air date/time and no broadcast show. episode_log
-- is the shared source of truth that kpfk-web reads, so the rows live here, but
-- they are marked distinctly (ingest_source = 'pra') and carry just enough
-- provenance to be reconciled against the bucket — folder, title, and the PRA
-- catalog code. Everything downstream (summaries, tagging, streaming, access
-- restrictions) is handled in kpfk-web.
--
-- ingest_source is plain text (no DB check constraint — only stations.ingest_primary
-- is constrained), so 'pra' needs no constraint change; the TS union in lib/types.ts
-- is updated alongside.

-- ── Episode: PRA provenance ─────────────────────────────────────────────────
alter table public.episode_log
  add column if not exists source_ref    text,
  add column if not exists source_folder text;

comment on column public.episode_log.source_ref is
  'For ingest_source = ''pra'': the PRA catalog code parsed from the object key '
  '(leading [A-Z]{2,3}\d+ plus optional track/part suffix, upper-cased — e.g. '
  '''AZ1797A''). NOT unique: a base code can span many track files (audiobooks '
  'reuse it per chapter). NULL when the leaf has no parseable code (336 of 1,946). '
  'Use mp3_url (UNIQUE) as the natural/idempotency key, never source_ref.';

comment on column public.episode_log.source_folder is
  'For ingest_source = ''pra'': the object key minus the "Flash Drive (64gb)/" '
  'prefix and minus the leaf filename — i.e. the PRA collection/sub-collection '
  'path (e.g. "PZ1002 Voices that Change the World/AZ1797 Letters and Politics '
  'History of Religion"). Preserves the archive hierarchy losslessly for kpfk-web.';

comment on column public.episode_log.ingest_source is
  'Where this episode row originated: ''confessor'', ''rss'', or ''pra'' '
  '(operator audio server / Pacifica Radio Archives R2 bucket).';
