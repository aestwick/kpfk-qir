# Spec: Transcript Search

> Status: **Phase 1 (Lexical FTS) implemented.** Phases 2 (embeddings) and 3
> ("ask the archive" RAG) remain design-only. What shipped for Phase 1:
> - Migration `022_transcript_fts.sql` — `transcripts.transcript_fts` tsvector +
>   GIN, the `transcript_cues` table (+ RLS via the episode_log join), and the
>   `search_transcripts()` RPC (ranked, station-scoped, `ts_headline` snippet,
>   cue `start_ms` deep-link, 5s statement timeout).
> - `lib/vtt.ts` (pure VTT parse + runtime aligner, unit-tested in
>   `lib/vtt.test.ts`), `lib/transcript-search.ts`, `app/api/transcript-search/route.ts`.
> - Cue population in `workers/transcribe.ts` (right after the VTT is built — note
>   this is the transcribe worker, where the VTT actually lives, not summarize as
>   the draft below assumed) + one-time backfill `scripts/backfill-transcript-cues.ts`.
> - UI: grid-wide `/dashboard/search` page + a "Search Transcripts" entry point on
>   the episodes page; hits deep-link to `/dashboard/episodes/{id}?seek=<seconds>`.
>
> Note: the actual next free migration number was **022** (highest existing is
> `021_show_keys_primary_language`; there is no "Show Groups" migration as §6.1
> guessed).

## 1. Problem & Motivation

Staff can currently filter the **episode list** by show name/key, by quarter,
and by an `updated_at` "since" cutoff (`app/api/episodes/route.ts`). None of
this ever looks **inside** the transcript text. There is no way to answer:

- "Find every time *measles* was mentioned on **Uprising** this quarter."
- "Where across the **entire grid**, in Q1, did we discuss the LA mayor's
  housing policy — and what exactly was said, with a timestamp?"

For an FCC Quarterly Issues Report tool this is the core missing capability:
proving *we served issue X — when, on which show, by whom, with a verbatim
quote* is literally the report being generated. Today that proof can only be
found by opening episodes one at a time and reading.

**Goal:** search transcript content (a) **within a single show** across its
episodes, optionally time-gated, and (b) **across all shows** within a date /
quarter range — fast, trustworthy, and deep-linked to the audio timestamp.

## 2. What exists today (build-on points)

| Capability | Where | Notes |
|---|---|---|
| Filter episodes by show | `app/api/episodes/route.ts:35` (`ilike show_name`), `:34` (exact `show_key`) | metadata only |
| Filter by quarter → date range | `app/api/episodes/route.ts:38–46` | `air_date` w/ `created_at` fallback |
| `since` filter | `app/api/episodes/route.ts:48–49` | `updated_at` only |
| Show + quarter UI controls | `app/dashboard/episodes/page.tsx:301–314` | debounced 350ms → URL params |
| Transcript text + VTT storage | `transcripts` table (`lib/types.ts:87–96`) | `transcript`, `vtt`, `english_*`, `language`, `episode_id` |
| Per-episode summary + category | `episode_log` (AI outputs) | **already-distilled semantic layer — reuse it (§3)** |
| FK index on transcripts | `supabase/migrations/002_add_indexes.sql:4` | `transcripts(episode_id)` only — **no text index** |

**No full-text search, no text index (GIN/tsvector), no embeddings exist
today.** A naive `ILIKE '%term%'` would be a full scan of large text blobs and
must not ship.

## 3. Key design insight: two layers, not one

Every episode already carries a `gpt-4o-mini` summary + category in
`episode_log`. That is a small, issue-framed, **already-distilled** semantic
layer. Treat search as two layers:

1. **Discovery** — search the **summaries / categories** (small, fast, already
   FCC-issue-shaped). Answers "did we cover immigration in Q1, on which shows?"
   cheaply, with **no new infrastructure**.
2. **Evidence** — search the **raw transcript text** for the verbatim quote +
   timestamp that proves it.

Most user value is the combination: discover via summaries, confirm via
transcript. The summary-search slice is near-free and maps directly to the
report's purpose — it should not be skipped in favor of a flashier transcript
index.

## 4. What we're up against (scale, cost, NOT abuse)

This is an **internal tool for a handful of authenticated staff** (auth +
multi-tenant RLS already enforced). The threat model is **not** public abuse /
DoS / scraping. The real constraints, in priority order:

1. **AI cost control** — a runaway client loop or impatient repeated "ask"
   queries are the only thing that costs real money.
2. **DB load from bad queries** — solved by a proper index + pagination +
   statement timeout.
3. **Provider TPM/RPM limits** — negligible at this concurrency (the nightly
   pipeline hits OpenAI/Groq far harder).

**Scale estimate** (verify before building): ~30–50 shows, quarterly cadence,
each transcript ≈ 10k–30k words ≈ 50–150 KB. A couple years ≈ low-thousands of
episodes, a few hundred MB to ~1–2 GB of text. **Trivial for Postgres FTS;
cheap to embed once.** No exotic infrastructure is warranted.

## 5. The three tiers of search

| Tier | Answers | Latency | Cost/query | Rate limiting |
|---|---|---|---|---|
| **1. Lexical (Postgres FTS)** | exact words, names, places | <100ms | ~$0 | none (pagination + index + statement timeout) |
| **2. Semantic (pgvector)** | concepts even if the words weren't said | ~200ms | fractions of a cent | light (one embed call/query) |
| **3. LLM / RAG ("ask the archive")** | "which episodes covered X, summarize what was said" | 2–8s | 1–10¢ | **real guardrails (§8)** |

**Most value-per-effort: Tier 1 first.** It is reliable, instant, free,
deterministic (an auditor trusts "the word appears at 00:12:03"), and it is the
retrieval layer the other tiers build on. Tiers 2 and 3 are *additive* on the
same plumbing — no rework.

**Deliberately not starting with LLM search.** It is the flashiest demo but the
worst first step: highest cost, slowest, hardest to trust ("did it hallucinate
the quote?"), and strictly worse than FTS for "find where we said X." It belongs
as the **capstone**, and must **cite real transcript timestamps** rather than
free-generate, so every AI answer is independently verifiable.

## 6. Data model

### 6.1 Phase 1 — FTS index (new migration, next free number)

> Note: Show Groups already targets `021`. Use the next available number
> (e.g. `022_transcript_fts.sql`).

**Document-level FTS** — discovery + ranking ("which episodes, best first"):

```sql
-- Generated tsvector + GIN index on the primary transcript text.
-- 'simple' config: NO stemming, NO stopword removal — exact-form matching
-- across English, Spanish, anything. (See P2 below: 'english' would silently
-- corrupt the Spanish-language transcripts this corpus already contains.)
alter table public.transcripts
  add column if not exists transcript_fts tsvector
    generated always as (to_tsvector('simple', coalesce(transcript, ''))) stored;

create index if not exists idx_transcripts_fts
  on public.transcripts using gin (transcript_fts);
```

**Cue-level FTS** — evidence + location ("which moment, with a timestamp"). The
document tsvector and `ts_headline` carry NO audio position, so the `▶ 00:12:03`
deep-link needs a separate, timed surface parsed from the VTT cues:

```sql
create table if not exists public.transcript_cues (
  id          bigint generated always as identity primary key,
  episode_id  uuid not null references public.episode_log(id) on delete cascade,
  cue_idx     int  not null,
  start_ms    int  not null,
  end_ms      int  not null,
  text        text not null,
  text_fts    tsvector generated always as
                (to_tsvector('simple', coalesce(text, ''))) stored
);
create index if not exists idx_transcript_cues_episode on public.transcript_cues(episode_id);
create index if not exists idx_transcript_cues_fts on public.transcript_cues using gin(text_fts);
```

Notes:
- **Why two indexes, one per job:** `ts_rank` over the whole transcript is the
  right *ranking* signal ("which episodes"); the cue table is the right
  *location* signal ("which second"). Search ranks episodes via the document
  index, then pulls matching cues **for those episodes** to attach `start_ms`.
- **Populate cues** in the summarize worker right after the transcript/VTT is
  written (parse VTT → cue rows via `lib/vtt.ts`). **Backfill** the existing
  corpus once (separate, re-runnable step).
- **Stemming trade-off (stated as a choice):** `'simple'` means `immigrant`
  won't match `immigrants`/`immigration`. Stemmed/conceptual discovery already
  lives in the **summary layer (§3)**, so this is an acceptable loss for the
  transcript tier — staff search the exact word and want the exact moment. If
  stemmed in-transcript search is later wanted for English shows, add a second
  `english`-config tsvector over `english_transcript` and route by `language`.
  **Defer until asked.**
- `transcripts` (and `transcript_cues`) are scoped to a station **via the
  `episode_id → episode_log.station_id` join** (no `station_id` column of their
  own — see CLAUDE.md). Search queries MUST join and filter on
  `episode_log.station_id`. RLS is inherited via that join; the new column /
  table do not change the policy surface.

### 6.2 Phase 2 — embeddings (deferred per §10; optional recall upgrade)

- Enable `pgvector`; add `transcript_chunks(episode_id, chunk_idx, content,
  embedding vector(1536), start_ms, end_ms)` (chunked so retrieval can cite a
  timestamp range).
- Backfill-embed the existing corpus once; embed each new episode in the
  **summarize worker** (`workers/summarize.ts`) right after the summary step.
- Hybrid rank: combine FTS rank + vector distance.

## 7. API

### 7.1 Phase 1 — `GET /app/api/transcript-search/route.ts` (new)

Query params:
- `q` — required, **min 2–3 chars**; parsed with `websearch_to_tsquery` so
  users can type `"measles outbreak" -vaccine` naturally.
- `show_key` — optional, scope to one show (the "within a show" mode).
- `quarter` **or** `start_date`/`end_date` — optional time gate (reuse the
  quarter→range logic already in the episodes route / `lib/qir-format.ts`).
- `page`, `limit` — pagination.

Behavior:
- **Start FROM `transcripts`, INNER JOIN `episode_log`** (stated explicitly so
  it is never widened to a left join). Episodes stuck at `status='transcribed'`
  with **no `transcripts` row** (the ghost-episode pattern, P4) simply can't
  match transcript text and correctly never appear — no null-snippet rows, no
  special-casing.
- Filter by **`station_id`** via the request-scoped RLS client from
  `lib/auth.ts#getStationContext`, plus an explicit `.eq('station_id', …)` —
  defense in depth, same as every route.
- Rank episodes by `ts_rank(transcript_fts, query)`, recency tiebreaker.
- For the ranked page, pull matching rows from **`transcript_cues`** (§6.1) for
  those episodes to attach `start_ms` for the deep-link.
- Return per result: episode id, show name, air date, **`ts_headline`
  snippet** with the match highlighted, and the cue **`start_ms`** for audio
  deep-linking.
- **Hard rule — never fabricate a timestamp.** If no cue matches, return
  `start_ms = null` and the UI shows the snippet with no deep-link. A wrong time
  in an FCC proof is worse than no time. (Same rule for the lean runtime-aligner
  fallback, below.)
- **Cap `ts_headline` to the current page of results**, never the whole match
  set (it is the one expensive FTS op on large docs).
- Apply a **statement timeout** (e.g. 5s) so a pathological query can't pin a
  connection.

**Lean fallback (no migration, if the cue table is deferred):** parse the
matched episode's VTT into `{start_ms, end_ms, text}` in `lib/vtt.ts`, normalize
whitespace/case, find the first cue containing the term, return its `start_ms` —
current page only, cache parsed cues per episode within a request. Fragile where
the reflowed plain transcript and cue text diverge (punctuation, Whisper
reflow), and common words mis-hit. **Recommendation: ship the cue table** — the
aligner is the fragile thing you'd unit-test to death anyway, and the table
makes the timestamp a first-class, indexed fact that scales.

### 7.2 Summary/discovery search

May piggyback on the existing episodes route (add `ilike` over the stored
summary field) **or** be folded into the same `transcript-search` endpoint with
a `scope=summary|transcript|both` param. Either is cheap; pick during build.

### 7.3 Phase 3 — `POST /app/api/transcript-search/ask` (deferred)

Retrieve-then-synthesize only (§8). Streamed response with a hard token cap, or
a BullMQ job (queue infra already exists) if answers get long.

## 8. Rate limiting & cost guardrails (Tier 3 only)

Tier 1 needs **no rate limiting** beyond pagination + statement timeout. The
"ask" feature needs all of:

- **Min query length + debounce** so partial typing never fires a call.
- **Per-user / per-station cap** (e.g. N asks/hour) surfaced as a friendly
  "you've hit today's AI-search limit," **logged to `usage_log`** so it appears
  in existing cost analytics like every other API call.
- **Cache identical queries** (query hash → result) — staff re-run the same
  searches near a filing deadline; caching is the cheapest rate limiter.
- **Retrieve → synthesize, never the reverse.** Pull top-k chunks via Tier
  1/2, feed only those to the LLM, require it to **cite episode + timestamp**.
  Bounds cost and eliminates hallucinated quotes.

## 9. UI

### 9.1 Within-show search (extends the episodes page)

Add a second debounced box (reuse the 350ms pattern) beside the existing show
filter on `app/dashboard/episodes/page.tsx`:

```
[ Show: Uprising ▾ ]  [ Quarter: 26-Q1 ▾ ]  [ 🔎 Search transcripts… "measles" ]
```

- Results reuse the existing episode table; each matched row gains a
  **highlighted snippet** and a hit count.
- Click row → episode detail, deep-linked to the matched **VTT timestamp** so
  the audio player seeks there.
- Existing show + quarter filters become AND-conditions on the search.

### 9.2 Grid-wide search (new `/dashboard/search` page)

For "anywhere, any show, any time frame":

```
🔎  [ measles outbreak                         ]   [ Search ]
Filters:  Show: [ All ▾ ]   From [date] To [date]  (or Quarter ▾)

Results (37 hits · 12 episodes)
  Uprising — 2026-01-14   "…latest measles outbreak data from the county…"  ▶ 00:12:03
  Sojourner Truth — 2026-02-02  "…vaccination rates and measles concerns…"  ▶ 00:41:55
```

Grouped by episode; each snippet clickable → seeks audio at the timestamp.
Show is a (multi-)select; time frame is a quarter dropdown (reuse existing
logic) or explicit From/To.

## 10. Decision — keep the schema lean

**Default to no `pgvector`** until real staff queries show the "we discussed it
without saying the words" gap actually bites. Proof is lexical; conceptual
discovery is the summary layer (§3). Revisit on evidence, not on spec. Phase 1
and Phase 3 are both unaffected by this decision.

## 11. Phasing

> **Phase 3 does NOT depend on Phase 2.** The 1→2→3 numbering is not a
> dependency chain. RAG retrieves top-k via Tier 1 FTS alone; embeddings only
> improve recall and can slot in whenever. Build order is **Phase 1 → (Phase 3
> may follow directly)**; Phase 2 is an optional recall upgrade on the same
> plumbing.

1. **Phase 1 — Lexical FTS** (migration §6.1 + `/api/transcript-search` §7.1 +
   both UIs §9). No rate limiting beyond pagination/timeout. **~80% of the
   value.** Ship first.
   - Cheap companion: **summary/category search** across the grid by issue +
     date range (§7.2) — near-zero cost, directly on-mission.
2. **Phase 2 — Semantic** (pgvector §6.2, embed in summarize worker, hybrid
   rank). Optional recall upgrade. Deferred per §10 — not a prerequisite for
   anything else.
3. **Phase 3 — "Ask the archive" (RAG)** retrieving via Tier 1 FTS, with the
   full §8 cost-cap / cache / citation treatment. May follow Phase 1 directly.

## 12. Security / multi-tenant checklist

- All search queries go through the **request-scoped RLS client**
  (`getStationContext`) **and** an explicit `.eq('station_id', …)`.
- `transcripts` is filtered via its `episode_log.station_id` join (no own
  `station_id` column).
- Never let a `show_key` / date filter widen scope across stations.
- Tier 3 prompts must not leak cross-station transcripts into context — the
  retrieval step is station-filtered before the LLM ever sees text.

## 13. Engineering directives (for the build)

**No god files — split by responsibility:**

| Module | Responsibility |
|---|---|
| `app/api/transcript-search/route.ts` | **Thin:** auth, param validation, pagination, response shaping. No SQL beyond calling the lib. |
| `lib/transcript-search.ts` | Query construction, ranking, scope filtering. |
| `lib/vtt.ts` | VTT parse + cue model (and the runtime alignment fn, if the fallback is chosen). **Pure, no DB.** |
| `lib/types.ts` | Result / row types. |
| `workers/summarize.ts` | Untouched except the **cue-populate** step (and, if Phase 2, the embed step). |

**Reuse, don't reinvent:**
- Quarter → date-range from `lib/qir-format.ts`.
- Station scope from `lib/auth.ts#getStationContext` + an explicit
  `.eq('station_id', …)` on **every** query (defense in depth, house style).
- The 350ms debounce pattern and the episode table component from
  `app/dashboard/episodes/page.tsx`.

**Standards:** small single-responsibility modules, named exports, no
cross-layer leakage. **Parameterized queries only.** `websearch_to_tsquery` for
all user input. Statement timeout (~5s), pagination, `ts_headline` capped to the
current page. Migration = next free number (**021 is Show Groups → use 022+**),
idempotent (`if not exists`), with the one-time **backfill as a separate,
re-runnable step**.

## 14. Tests

The **cue-location path is the fragile, audit-critical piece** — unit-test
`lib/vtt.ts` (and the cue parser) against real VTT fixtures including:

- **(a)** a match spanning two cues,
- **(b)** a common-word match (must not mis-hit), and
- **(c)** a no-match that returns **`null`** — never a guessed time.
