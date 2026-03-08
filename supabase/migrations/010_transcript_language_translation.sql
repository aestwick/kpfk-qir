-- Add language detection and English translation columns to transcripts table
-- Supports Spanish-language shows that need English translations for compliance review

ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS english_transcript TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS english_vtt TEXT DEFAULT NULL;

COMMENT ON COLUMN transcripts.language IS 'ISO 639-1 language code detected by Whisper (e.g. es, en)';
COMMENT ON COLUMN transcripts.english_transcript IS 'English translation of transcript (populated on demand for non-English episodes)';
COMMENT ON COLUMN transcripts.english_vtt IS 'English translation of VTT captions (populated on demand for non-English episodes)';
