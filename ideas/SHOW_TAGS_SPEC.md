# Show & Episode Tagging — Implementation Spec

Status: **draft for review** (no code shipped). Decisions captured from the
design conversation are in §1; open questions are resolved in §11.

Target branch: `claude/amazing-pasteur-h32rtm`.

---

## 1. Goal & owner decisions

Generate **tags** from transcripts to make show/episode content discoverable,
organizable, and recommendable — and to feed a **separate donor-facing repo/DB**.

Locked decisions:

- **Two levels.** *Episode tags* are the raw per-episode signal. *Show tags* are
  a rollup over a logical show (`show_group`, never the name — see `lib/shows.ts`)
  and are the surfaced unit.
- **Donor-facing destination.** Tags cross a **publish boundary** into another
  system. This repo produces a curated feed and exposes it; the donor app pulls
  it. We do **not** push into the donor DB (no credential/schema coupling).
- **Hybrid taxonomy.** A curated base vocabulary the model maps onto, PLUS
  optional emergent free-form tags that staff review and promote (same
  review-and-activate flow as discovery-sync show onboarding).
- **Donor-facing facet.** Tags carry a `facet` (`theme` for donor-facing impact
  themes vs `issue` for FCC-style buckets). The FCC `issue_category` stays a
  separate compliance concern — tags never feed it.
- **Rationale is captured.** `episode_tags.source` + an optional justification,
  and a `show_keys.notes` column for inline grouping/curation rationale. Richer
  cross-cutting rationale lives in the decision log (see `ideas/DECISION_LOG.md`).

## 2. Why this fits the codebase

- The summarize worker already runs an LLM pass over the **full transcript**
  (`workers/summarize.ts:147`) emitting structured JSON. Adding a `tags` array is
  **output tokens only** — no new API call, no new worker, near-zero added cost.
- Episode embeddings already exist (`transcript_chunks`, `lib/transcript-embeddings.ts`)
  and give a ready similarity signal for recommendations (Phase 4).
- Two governance patterns to mirror: the **two-layer `compliance_wordlist`**
  (global base rows `station_id IS NULL` + per-station rows; migrations 030/032)
  and **editable settings/prompts in the DB** (`lib/settings.ts`).
- Per CLAUDE.md: register new tenant tables in the **audit trigger loop
  (migration 028)** and any new app-layer audit event in `lib/audit.ts`.

## 3. Data model — `supabase/migrations/033_tags.sql`

Next migration number is **033** (032_seed_global_wordlist_base is latest).

```sql
-- Taxonomy. Two-layer like compliance_wordlist: station_id NULL = global base
-- (super-admin managed, applies to every station); per-station rows are local
-- additions. `published` is the donor-facing gate; `active` is the discovery gate.
create table if not exists public.tags (
  id           bigserial primary key,
  station_id   uuid references public.stations(id) on delete cascade,  -- NULL = global base
  slug         text not null,            -- stable key; donor join key (never the label)
  label        text not null,            -- display; staff may reword freely
  facet        text not null default 'theme' check (facet in ('theme','issue')),
  active        boolean not null default true,   -- eligible for tagging/discovery
  published     boolean not null default false,  -- eligible for donor-facing export
  notes         text,                    -- curator rationale for the tag
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
create unique index if not exists idx_tags_station_slug
  on public.tags (coalesce(station_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);

-- Episode → tag. Scoped via episode_id -> episode_log.station_id (like transcripts).
create table if not exists public.episode_tags (
  episode_id    bigint not null references public.episode_log(id) on delete cascade,
  tag_id        bigint not null references public.tags(id) on delete cascade,
  confidence    real not null default 1.0,        -- 0..1; thresholds gate export
  source        text not null default 'llm' check (source in ('llm','manual')),
  justification text,                              -- model's one-line reason, or curator note
  created_at    timestamptz not null default now(),
  primary key (episode_id, tag_id)
);
create index if not exists idx_episode_tags_tag on public.episode_tags (tag_id);

-- Inline grouping/curation rationale on shows (mirrors transcript_corrections.notes).
alter table public.show_keys add column if not exists notes text;
```

**Show-level rollup** (`show_tags`) is a **view**, not a table — derived, always
fresh, no sync job. It aggregates episode tags up to the logical show by
`coalesce(show_group, key)` within a station, scoring by frequency + recency:

```sql
create or replace view public.show_tags as
select e.station_id,
       coalesce(sk.show_group, e.show_key) as show_group,
       et.tag_id,
       count(*)                       as episode_count,
       max(e.air_date)                as last_aired,
       avg(et.confidence)             as avg_confidence
from public.episode_tags et
join public.episode_log e on e.id = et.episode_id
left join public.show_keys sk
       on sk.station_id = e.station_id and sk.key = e.show_key
group by e.station_id, coalesce(sk.show_group, e.show_key), et.tag_id;
```

**RLS** (mirror migrations 014/030): members read base (`station_id IS NULL`) +
their own station's tags; only super-admins write base rows; station admins write
their own. `episode_tags` follows the episode's station via the join, as
`transcript_chunks` does. **Audit:** add `tags` and `episode_tags` to the trigger
loop in migration 028 (and `show_keys.notes` is already covered).

## 4. Extraction — `workers/summarize.ts`

1. Extend `SummaryResponse` (`workers/summarize.ts:10`) with
   `tags: { slug: string; confidence: number; justification?: string }[]` and an
   optional `emergent_tags: string[]` for proposals outside the taxonomy.
2. Inject the **active taxonomy** (slug + label, base ∪ station) into the system
   prompt; instruct the model to map onto existing slugs and only propose an
   emergent tag when nothing fits. Prompt stays DB-editable (`lib/settings.ts`).
3. After the existing episode update (~`workers/summarize.ts:187`), upsert
   `episode_tags` (resolve slugs → tag_id; skip unknown non-emergent slugs).
   Emergent proposals land as **inactive, unpublished** `tags` rows for review —
   nothing auto-exports.
4. Best-effort, like the embedding block (`:216`): a tag failure must never fail a
   successfully-summarized episode. Log an audit event (`tags.extracted`,
   registered in `lib/audit.ts`).

## 5. Taxonomy seed & hybrid governance

- Seed a starter **global base** (`station_id NULL`) of donor-relevant `theme`
  tags (immigrant rights, housing/homelessness, public health, youth education,
  labor, climate, civil rights, local government…) plus the FCC `issue` set —
  one seed migration, mirroring `032_seed_global_wordlist_base`.
- Emergent tags surface in a review grid; promoting one flips `active` (and
  `published` when donor-ready) — the same opt-out onboarding as shows.

## 6. Backfill

Tag the existing catalog from the **stored `summary` + `headline`**, not full
transcripts (≈100× cheaper tokens, good enough for tagging). Reuse the one-time
backfill-script pattern from the embeddings work; record it in the **maintenance
log** (`activity='tag_backfill'`, counts + cost in metadata).

## 7. Curation UI — Settings → Tags

A new tab (pattern: existing corrections CRUD): manage the taxonomy
(slug/label/facet/active/published/notes), review & promote emergent tags, and
override episode tags manually (`source='manual'`). Super-admins edit base rows;
station admins edit their own.

## 8. Donor-facing publish API

```
GET /api/public/show-tags?station=<slug>
  → [ { show_group, display_name,
        tags: [ { slug, label, facet, score } ],
        updated_at } ]
```

Export gates (both required): tag `active AND published`, **and** the rollup's
`episode_count`/`avg_confidence` clears a configurable threshold. Emergent/
low-confidence tags never leave. Reads from the `show_tags` view joined to
`tags`; public-readable like finalized `qir_drafts`. `updated_at`/`generated_at`
let the donor app cache. Stable join keys: `station_slug` + `show_group` + tag
`slug`.

## 9. Recommendations (Phase 4, later)

Start with **tag overlap** (explainable: "both cover housing + local politics"),
then layer **embedding similarity** using a per-show centroid over the existing
`transcript_chunks` vectors. Ship tags-only first.

## 10. Logging hooks

- **Audit:** `tags.extracted` / `tags.published` events in `lib/audit.ts`; table
  mutations auto-captured once `tags`/`episode_tags` join the migration-028 loop.
- **Decision log:** taxonomy/promotion choices recorded in `ideas/DECISION_LOG.md`
  (and the future `decision_log` table).
- **Maintenance log:** backfills/re-extractions recorded with counts + cost.

## 11. Open questions — resolved

| # | Question | Decision |
|---|----------|----------|
| 1 | Surfacing target | Separate **donor-facing** repo/DB via pull API (§8) |
| 2 | Vocabulary | **Hybrid** — curated base + reviewed emergent |
| 3 | Push vs pull | **Pull** API; no donor-DB coupling |
| 4 | Show identity | `coalesce(show_group, key)` per station — never name |
| 5 | Rollup storage | **View**, not table (derived, always fresh) |
| 6 | Backfill cost | From stored summary+headline, not transcripts |
| 7 | Relation to FCC `issue_category` | Separate; tags never feed compliance |

## 12. Phasing

1. **Migration 033** — tags, episode_tags, show_tags view, RLS, audit + seed.
2. **Extraction** — `SummaryResponse` + prompt + `episode_tags` write.
3. **Backfill** — from stored summaries.
4. **Curation UI** — Settings → Tags.
5. **Publish API** — `/api/public/show-tags` + gates.
6. **Recommendations** — tag overlap, then embeddings (later).

Phases 1–2 are the MVP; 3–5 make it usable and donor-ready; 6 is the upside.
