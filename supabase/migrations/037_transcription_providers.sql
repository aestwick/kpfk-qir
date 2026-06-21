-- 037_transcription_providers.sql
-- Pluggable speech-to-text providers (Groq Whisper, Deepgram, AssemblyAI) with a
-- configurable priority order + automatic fallback, plus optional diarization.
--
-- 1. Record which engine produced each transcript (for cost attribution, debugging
--    fallbacks, and surfacing diarization capability per row).
-- 2. Seed the global default provider order + enable toggles and the diarization
--    flag into qir_settings (the default layer; stations may override via
--    station_settings, resolved in lib/settings.ts).

-- ── transcripts: provenance columns ─────────────────────────────────────────
alter table transcripts add column if not exists provider text;
alter table transcripts add column if not exists model text;

comment on column transcripts.provider is
  'Speech-to-text engine that produced this transcript: groq | deepgram | assemblyai. Null for pre-037 rows.';
comment on column transcripts.model is
  'Concrete model/tier used (e.g. whisper-large-v3, nova-2, universal).';

-- ── qir_settings: provider order + diarization defaults ─────────────────────
-- Array order = priority. The worker tries each enabled provider whose API key is
-- present until one succeeds. Groq stays primary by default (lowest cost, current
-- behaviour); Deepgram then AssemblyAI act as fallbacks. Seeded only if absent so
-- a re-run never clobbers an operator's tuned order.
insert into qir_settings (key, value)
values (
  'transcription_providers',
  '[{"provider":"groq","enabled":true},{"provider":"deepgram","enabled":true},{"provider":"assemblyai","enabled":true}]'::jsonb
)
on conflict (key) do nothing;

-- Diarization (speaker labels) on by default; emitted into the VTT as WebVTT
-- voice spans by providers that support it (Deepgram, AssemblyAI).
insert into qir_settings (key, value)
values ('diarization_enabled', 'true'::jsonb)
on conflict (key) do nothing;
