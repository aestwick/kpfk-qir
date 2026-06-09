-- Transcription provider selection.
--
-- The pipeline can now transcribe with one of three speech-to-text engines,
-- chosen per station (station_settings override → this global default):
--   groq        — Whisper large-v3, audio chunked locally with ffmpeg (current
--                 behavior; remains the default so nothing changes on upgrade)
--   assemblyai  — fetches the source MP3 by URL (no local chunking)
--   deepgram    — Nova-2, fetches the source MP3 by URL (no local chunking)
--
-- The chosen provider's API key must be present in the worker environment
-- (GROQ_API_KEY / ASSEMBLYAI_API_KEY / DEEPGRAM_API_KEY). An unknown value
-- falls back to 'groq' in code, so this row can never strand the pipeline.
insert into public.qir_settings (key, value) values
  ('transcription_provider', '"groq"')
on conflict (key) do nothing;
