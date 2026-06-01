-- Migration 027: Per-station show-name strip prefixes
-- Idempotent: safe to re-run
--
-- RSS channel titles often carry a station prefix (e.g. "KPFK - The Car Show").
-- When resolving a show's DISPLAY name we want to drop that prefix (and any
-- leading "the") so the name begins at the first meaningful word. The prefixes
-- are station-specific, so they belong in station config — not hard-coded.
--
-- show_name_strip_prefixes: ordered list of prefixes to strip from auto-derived
-- (feed_name/show_name) display names. The first matching prefix wins. Null/empty
-- means no stripping. Applied only to derived names — never to a manual
-- display_name override or a hand-entered show_group label. See lib/shows.ts.

ALTER TABLE stations ADD COLUMN IF NOT EXISTS show_name_strip_prefixes TEXT[];

COMMENT ON COLUMN stations.show_name_strip_prefixes IS 'Ordered prefixes stripped from auto-derived show display names (e.g. {"KPFK -"}). First match wins. Display-only; never affects grouping or manual overrides. See lib/shows.ts.';

-- Seed KPFK with its known prefix so existing names tidy up immediately.
UPDATE stations
  SET show_name_strip_prefixes = ARRAY['KPFK -']
  WHERE slug = 'kpfk' AND show_name_strip_prefixes IS NULL;
