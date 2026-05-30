-- Migration 021: Show primary language
-- Idempotent: safe to re-run
--
-- Adds a per-show primary language so staff can record the language a program
-- airs in (e.g. KPFK's Spanish, Armenian, Korean blocks). Stored as a free-form
-- ISO 639-1 code (matching transcripts.language) so the two line up. Nullable;
-- existing rows stay null until set.

ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS primary_language TEXT;

COMMENT ON COLUMN show_keys.primary_language IS 'ISO 639-1 code for the language this show primarily airs in (e.g. en, es). Null = unspecified.';
