-- Per-field source provenance — keep BOTH the human (Confessor) and AI value for
-- each dual-authored field, with a per-field "active" selector so a curator can
-- toggle which one is used downstream without losing the other.
--
-- The flat columns (host, guest, issue_category, summary) remain the RESOLVED
-- active value — everything downstream (QIR generation, CSV/text export, the
-- public read API, the episode table) keeps reading them unchanged. This jsonb
-- sidecar is purely the "both copies + which is live" record:
--
--   {
--     "host":           { "human": "...", "ai": "...", "active": "human" },
--     "guest":          { "human": "...", "ai": "...", "active": "human" },
--     "issue_category": { "human": "...", "ai": "...", "active": "ai" },
--     "summary":        { "human": "...", "ai": "...", "active": "human",
--                         "manual": "...", "pinned": true }
--   }
--
-- Default winner when both exist: human, EXCEPT issue_category which defaults to
-- AI (the model catches issues humans under-tag). `pinned` is set once a human
-- toggles/edits a field, so a later re-summarize won't auto-flip their choice.
-- See lib/field-sources.ts for the resolution logic.

alter table public.episode_log
  add column if not exists field_sources jsonb;

comment on column public.episode_log.field_sources is
  'Per-field human/ai/manual candidates + active selector for host/guest/issue_category/summary. The flat columns hold the resolved active value; this is the toggle layer (see lib/field-sources.ts).';
