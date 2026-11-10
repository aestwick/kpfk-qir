# CLAUDE.md — Project Guide for Claude Code

## What This Project Is

**QIR.KPFK.ORG** automates FCC Quarterly Issues Report generation for KPFK 90.7FM (Pacifica Radio, Los Angeles).

Every quarter, KPFK has to prove to the FCC that it's serving its community — documenting which shows covered which issues (education, health, immigration, etc.) with dates, times, durations, and guests. Someone used to do this manually by listening to shows and typing up a report. This app automates the entire thing: it listens to the shows (via transcription), understands what was discussed (via AI summarization), categorizes the content, and generates the formatted report ready for filing.

It replaced 4 fragile n8n workflows that kept breaking. It costs a few dollars per quarter in AI processing and runs itself.

## How It Works

It's a batch processing pipeline with a web dashboard:

```
RSS Ingest → Audio Chunking (ffmpeg) → Speech-to-Text (Groq Whisper) → Summarization (GPT-4o-mini) → Report Generation
```

All state lives in Postgres (Supabase). The pipeline is driven by a `status` field on each episode:

```
pending → transcribed → summarized
                                  ↘ (curated into QIR draft → finalized)
failed ← (any stage can fail)
unavailable ← (404 MP3)
```

Background workers (BullMQ + Redis) process episodes through each stage. An hourly cron triggers ingest, which chains into transcription, which chains into summarization. The dashboard lets staff monitor progress, fix errors, edit outputs, and generate the final QIR.

## Stack

- **Next.js 15.5** (App Router, React 19) — dashboard UI + API routes + public QIR pages. Route `params`/`searchParams` and `headers()`/`cookies()` are async (await them); `lib/api-handler.ts#withApiKey` awaits `params` for every `/api/v1` route
- **Supabase** (PostgreSQL + Auth) — all persistent state
- **BullMQ + Redis** — background job queues with hourly cron
- **Groq API** (whisper-large-v3-turbo by default; per-station choice) — audio transcription
- **OpenAI API** (gpt-4o-mini) — summarization and curation
- **ffmpeg** — audio chunking (15-min M4A segments, mono, 16kHz, 64k AAC)
- **Docker Compose** — production deployment on VPS
- **Tailwind CSS** — styling (no component library)

## File Map

### Core Pipeline (read these first)

```
workers/
  index.ts          — BullMQ worker setup, cron scheduling, stage chaining
  ingest.ts         — Episode ingest. Per station, source = Confessor API
                      (?req=fil — carries human host/guest/issue metadata) when
                      it's the primary + configured, else RSS; Confessor falls
                      back to RSS per show on failure. fetch → parse → dedupe
                      (by mp3_url) → insert episodes as pending
  transcribe.ts     — Resolve provider plan → run transcription (priority order,
                      auto-fallback via lib/transcription) → corrections → store
                      transcript + VTT. Groq path ffmpeg-chunks; Deepgram/
                      AssemblyAI take mp3_url directly. Diarized speaker labels →
                      WebVTT voice spans. Records provider/model per transcript.
                      Applies show/episode-scoped correction rules; sends the
                      optional name hint (talk shows only).
  summarize.ts      — Load transcript → OpenAI → parse JSON → update episode metadata.
                      Records AI copy + resolves human/AI winner per field
                      (lib/field-sources.ts)
  generate-qir.ts   — Group episodes → OpenAI curation → build draft
  discover-sync.ts  — Daily: scrape each station's archive program list →
                      insert NEW show_keys as inactive (opt-out onboarding)
  confessor-resync.ts — Nightly: re-read Confessor for the last 60 days → refresh
                      human copies on existing episodes; re-summarize when the
                      resolved host/guest moved (lib/confessor-resync.ts)
  corrections.ts    — Transcript names: re-apply pending correction rules to
                      STORED transcripts (startup + on rule change); nightly
                      CMS-host sync + suggested-corrections miner
```

### Library / Shared

```
lib/
  supabase.ts       — Supabase clients (admin for server, browser for client)
  transcription/    — Pluggable speech-to-text. index.ts: provider registry +
                      resolveProviderPlan (priority/enable from settings) +
                      runTranscription (fallback) + cost rates + config status.
                      groq.ts (chunked Whisper), deepgram.ts / assemblyai.ts
                      (URL-based, diarizing). vtt.ts: speaker-aware VTT builder.
                      Names: corrections.ts (one rule engine: scope, VTT-safe
                      apply, SQL prefilter), repair.ts (rules → stored
                      transcripts), vocabulary.ts (Whisper name hint + echo
                      guard), names.ts, store.ts (DB loaders), miner.ts +
                      suggestions.ts (nightly miner), cues.ts (cue rebuild),
                      chunking.ts (ffmpeg chunk args), benchmark.ts (scoring)
  confessor.ts      — Confessor archive API client (?req=fil) + pubfile projection
                      (host/guest/issues/human_summary) with loose-JSON parsing
  field-sources.ts  — Per-field human/ai/manual provenance engine (build/apply/
                      resolve/toggle); shared by workers + episode detail UI
  queue.ts          — BullMQ queue instances (ingest, transcribe, summarize, generate-qir)
  settings.ts       — Settings cache (60s TTL) reading from qir_settings table
  usage.ts          — Cost logging helpers (Groq per-second, OpenAI per-token)
  audit.ts          — Append-only audit log helper + the event registry (see Audit Logging)
  types.ts          — TypeScript interfaces for all database tables
  qir-format.ts     — Report formatting and date range helpers
  verify-week.ts    — Broadcast-week verification engine (pure): expands the CMS
                      schedule into expected blocks, matches airings by show
                      identity + time overlap (driver: scripts/verify-week.ts)
  redis.ts          — Shared lazy ioredis client (used by locks, ratelimit, api-cache)
  api-auth.ts       — API-key auth for the public read API (hash lookup + scopes)
  ratelimit.ts      — Redis sliding-window rate limiter (per key)
  api-cache.ts      — Redis response cache with versioned invalidation
  api-handler.ts    — withApiKey() wrapper: auth → scope → rate-limit → cache → ETag
  compliance-tier.ts — Pure triage tiers for compliance flags (high-risk words,
                      safe harbor at the moment it aired); used by /api/compliance/triage
  fetch-all.ts      — fetchAllRows(): pages past PostgREST's 1000-row cap. Use it for
                      any read that can exceed 1000 rows (it silently truncates otherwise)
  search-query.ts   — Pure: search box → expanded to_tsquery (quotes/-x/OR, variants)
  transcript-search.ts — Search RPC calls (exact + by-meaning fusion), vocab refresh
  broadcast-format.ts  — Shared air date/time/offset formatters + episode/day/person links
  broadcast-day.ts, show-report.ts, people.ts, show-catalog.ts — pure logic for the find views
  episode-feed.ts   — Pure logic behind GET /api/v1/episodes: the published-status
                      contract, field allowlist, param parsing/validation, keyset
                      cursor codec, response envelopes, public_id ref resolution
```

### API Routes

```
app/api/
  health/route.ts           — GET liveness check
  dashboard/route.ts        — GET aggregated dashboard stats (single endpoint)
  episodes/route.ts         — GET list (paginated, filterable, CSV export) / POST bulk-retry
  episodes/[id]/route.ts    — GET detail / PATCH update,retry,re-transcribe,re-summarize
  episodes/counts/route.ts  — GET status distribution counts
  jobs/route.ts             — GET queue status / POST trigger manual job
  qir/route.ts              — GET list drafts / POST generate / PATCH finalize / DELETE
  qir/export/route.ts       — GET export as CSV or text
  downloads/route.ts        — GET batch download transcripts, VTTs, episode CSV
  settings/route.ts         — GET all / PUT upsert setting
  corrections/route.ts      — CRUD for transcript corrections (show_key scope;
                              edits clear backfilled_at → stored-text repair)
  corrections/vocabulary/   — per-show name list (transcript_vocabulary)
  corrections/suggestions/  — miner suggestions: approve (→ rule) / reject
  usage/route.ts            — GET cost analytics with date range
  audit/route.ts            — GET audit log (super-admin only, paginated, filterable)
  audit/event/route.ts      — POST client-reported auth/station events (allowlisted)
  admin/overview/route.ts   — GET all-station pipeline overview / POST master controls
                              (super-admin only: pause_all, pause/resume_station,
                              advance, retry/clear failed; see Pipeline Pause)
  keys/route.ts             — CRUD for API keys (JWT auth, admin-gated): POST mint
                              (raw secret returned once), GET list (prefix only),
                              PATCH revoke/activate, DELETE
  v1/                       — Public read API (API-key auth, GET-only). See "Public Read API".
    qir/route.ts                  — finalized reports (filter year/quarter/status)
    qir/[year]/[quarter]/route.ts  — one finalized report + curated entries (URL /qir/2026/q2)
    episodes/route.ts             — published episode feed (keyset cursor + updated_since)
    episodes/[id]/route.ts        — episode detail by public_id (?include=transcript)
    episodes/[id]/transcript/route.ts — captions: VTT (?format=vtt) or JSON
    shows/route.ts                — program list
    usage/route.ts                — AI cost/usage summary
```

### Dashboard Pages (all `'use client'`)

```
app/dashboard/              (menu label in quotes — the menu itself is lib/nav.ts)
  layout.tsx                — Auth wrapper, sidebar shell, phone header, error boundary
  page.tsx                  — "Home": pipeline viz, stats, cost analytics, activity feed
  episodes/page.tsx         — "Episodes": table with filters, sort, bulk actions
  episodes/[id]/page.tsx    — Episode detail: audio player, transcript, edit summary
  day/page.tsx              — "What aired": broadcast day log (?date=&at=)
  show-report/page.tsx      — "What a show covered" over a period (?show=&from=&to=)
  people/page.tsx           — "Who was on": hosts & guests, spelling-forgiving (?q=|name=)
  shows/page.tsx            — "Shows": directory of the station's programs
  shows/[showKey]/page.tsx  — One show's episodes
  shows/audit/page.tsx      — "Show check-up": per-show completeness + issues report
  search/page.tsx           — "What was said": transcript search → audio moment
  generate/page.tsx         — "Quarterly report": QIR draft builder (?quarter=YYYY-Qn)
  compliance/triage/page.tsx — "Review flags": triage by tier (lib/compliance-tier.ts) —
                              A listen-now / B glance / C safe harbor / D other checks;
                              inline audio, 1–5 keys to decide, bulk close for C and
                              switched-off checks; data from GET /api/compliance/triage
  compliance/page.tsx       — "All flags" (the filterable table); compliance/grid — "Flags by time slot"
  settings/page.tsx         — "Settings" (tabs addressable: ?tab=shows|members|…)
  api-keys/page.tsx         — "API keys" (station admin)
  jobs/page.tsx             — "Processing queue" (active station)
  activity/page.tsx         — "Processing log"
  master/page.tsx           — "All stations" (super-admin only): all-station pipeline
                              activity + per-station pause/resume, run-now, retry/clear
  usage/page.tsx            — "AI costs" (super-admin)
  users/page.tsx            — "All users" (super-admin)
  audit/page.tsx            — "Change history": audit log viewer (super-admin only)
  downloads/page.tsx        — "Downloads": batch export hub
```

**Navigation has one definition: `lib/nav.ts`** (`NAV_GROUPS`). The sidebar
(`app/components/sidebar-nav.tsx`), breadcrumbs, episode "← back to" origins and
the phone header all read it — add/rename a page there, never in a component.
Items carry `minRole` (viewer/editor/admin/super) to hide links people can't use;
that is a convenience only — pages/APIs still enforce access. Role comes from
`app/components/nav-access.tsx` (the user's own `station_users` row, or
super-admin). `reserved: true` items are slots for pages not built yet (Broadcast
day, Show coverage, Guests & people) — delete the flag when the page ships. The
sidebar also shows the FCC filing-deadline chip (`filingStatus()`: due the 10th
of the month after the quarter, in the station's time zone) and a badge with this
quarter's unreviewed critical compliance flags. Rationale:
`docs/navigation-proposal.md`.

### Public Pages

```
app/
  page.tsx                  — Redirects to /dashboard
  login/page.tsx            — Supabase email/password auth (honours a same-origin ?next=)
  compliance-report/page.tsx — Printable compliance report. Staff-only: the server renders
                              a shell; flags load client-side through the authenticated
                              /api/compliance/report (never read with the service role here)
  [station]/[year]/[quarter]/page.tsx — Public finalized QIR at /kpfk/2026/q2 (folder is `[quarter]`, never `q[quarter]`: Next has no partial dynamic segments, so that supplies no param; `parseQuarterSegment` in lib/qir-format.ts strips the `q`) (per-station, print-friendly; dynamic so each view, incl. anonymous, is audited)
```

### Shared Components

```
app/components/
  skeleton.tsx              — Loading placeholders (cards, rows, blocks)
  error-boundary.tsx        — React error boundary with retry
  empty-state.tsx           — Reusable empty state with optional action
```

### Database

```
supabase/migrations/
  001_usage_settings_drafts.sql — Creates usage_log, qir_settings, qir_drafts,
                                  transcript_corrections tables + default settings
  ...
  012_stations.sql              — Tenant tables (stations, station_users,
                                  super_admins, station_settings) + KPFK seed
  013_station_id_columns.sql    — Adds station_id to tenant tables, backfills
                                  KPFK, per-station uniqueness + indexes
  014_rls.sql                   — user_station_ids() + RLS policies on all
                                  tenant tables
  015_seed_pacifica_stations.sql — Seeds KPFA, WPFW, KPFT, WBAI
  ...
  033_api_keys.sql              — api_keys table (station-scoped) + RLS
                                  (admin-write, member-read) + audit trigger
  034_show_keys_archived_at.sql — show_keys.archived_at soft-delete tombstone
  035_confessor_ingest.sql      — stations.ingest_primary + confessor_base_url;
                                  episode_log.ingest_source/confessor_meta/
                                  human_summary; flips KPFK to Confessor-primary
  036_field_sources.sql         — episode_log.field_sources (per-field human/ai/
                                  manual copies + active selector)
  037_transcription_providers.sql — transcripts.provider/model; seeds
                                  transcription_providers (order+enable) +
                                  diarization_enabled defaults in qir_settings
  ...
  047_transcript_names.sql      — transcript_corrections.show_key + backfilled_at;
                                  transcript_vocabulary; transcript_correction_
                                  suggestions; mine_name_variants() RPC
  048_seed_kpfk_vocabulary.sql  — KPFK show names (Confessor DJ list, kpfk.org,
                                  Ace's confirmations)
  053_lockdown_public_exposure.sql — closes what the public anon key reached:
                                  qir_settings/schema_migrations service-only,
                                  drops episode_log "Public read access" (anon
                                  keeps published-only, 6-column read for the
                                  public site's episode player), legacy RPC,
                                  shared-DB contacts/tags/show_page tables
  054_role_aware_write_policies.sql — user_has_station_role(); *_write policies
                                  need editor; station pause/spend keys super-
                                  admin only; usage_log service-role only
```

**Migrations are tracked** — QIR has its own tracker, **`public.schema_migrations`**
(filename + applied_at), driven by **`scripts/migrate.sh`**: each file in
`supabase/migrations/` runs at most once, in filename order, each in its own
transaction with its bookkeeping row (needs `DATABASE_URL` — the *direct*
5432 connection, not the pooler; psql runs in a throwaway Docker container).
Run during deploy (DECISION_LOG A12.1) so schema and code land together.
Do **not** confuse this with `supabase_migrations.schema_migrations` (the
Supabase CLI's table) — that one belongs to the KPFK CMS repo, which shares
this Supabase project; QIR migrations must never be registered there. New
migrations: add the next-numbered `NNN_name.sql` file and let `migrate.sh`
apply it — prefer idempotent SQL so a hand-applied hotfix can be re-run
harmlessly at deploy.

**Key tables:**
- `episode_log` — Core episode data + processing status + AI outputs (`station_id`-scoped)
- `transcripts` — Full transcript text + VTT captions (1:1 with episode; scoped via episode)
- `show_keys` — Show metadata (key, name, category, active; `station_id`-scoped, unique per `(station_id, key)`). A single logical show can span **multiple feeds/keys** (e.g. a 6am + 9am airing). Grouping is by the explicit `show_group` column (`coalesce(show_group, key)`) — **never the name**, which can differ across feeds. The displayed name resolves as `display_name` (manual override) → `feed_name` (auto-derived from the RSS channel title at ingest) → `show_name` (legacy) → `key`; see `lib/shows.ts`.
- `usage_log` — Every API call logged with cost (`station_id`-scoped)
- `qir_settings` — **Global** key-value config (default layer under `station_settings`)
- `qir_drafts` — Versioned QIR reports (draft/final; `station_id`-scoped)
- `transcript_corrections` — Find-and-replace rules applied post-transcription (`station_id`-scoped)
- `stations` / `station_users` / `super_admins` / `station_settings` — multi-tenant tables (see Multi-Station Model)
- `api_keys` — Station-scoped keys for the public read API. Stores `key_hash` (sha256 of the secret — never the secret), `key_prefix` (non-secret, for UI), `scopes[]`, `rate_limit_per_min`, `active`, `last_used_at`. RLS: members read their station's key metadata, only admins/super-admins write (migration 033).

### Config & Deploy

```
Dockerfile              — Node 20 + ffmpeg, builds Next.js, CMD start:all
docker-compose.yml      — qir-app (port 3100) + qir-redis
next.config.js          — output: standalone
tailwind.config.ts      — Default Tailwind config
package.json            — Scripts: dev, build, workers, start:all
```

## Key Patterns

**Episode status flow:** `pending → transcribed → summarized → (curated into QIR)`
Failures at any stage set `status = 'failed'` with `error_message` and increment `retry_count`.

**Worker chaining:** Ingest completion auto-triggers transcription (if new episodes found). Transcription completion auto-triggers summarization (if episodes transcribed). QIR generation is manual only.

**Steady-state is current-quarter-scoped; backfills opt out via a window.** The transcribe + summarize + compliance candidate queries are pinned to the **current calendar quarter** — via `getProcessingWindowBounds()` in `lib/quarters.ts`, which is `getCurrentQuarterBounds()` plus a **`QUARTER_GRACE_DAYS` (10-day) grace window**: during the first 10 days of a quarter the start reaches back to the previous quarter's start, so late-evening last-day airings ingested after the 00:00 UTC flip (and backfills/retries) still drain before the FCC filing deadline. Dashboards/backlog counts keep the strict `getCurrentQuarterBounds()`. A historical one-off (e.g. retro-generating WPFW's Q4 2020 QIR from an archive backup) gets past that gate by passing an explicit `{ window: { start, end } }` in the transcribe/summarize job data; `resolveWindow(job)` uses it instead of the current quarter, and the continue/backoff/chain re-enqueues (`workers/index.ts`) thread the same window through the whole drain. QIR *generation* was never quarter-locked (`generate-qir.ts` is parameterized by `year`/`quarter`). A windowed backfill also **bypasses the per-station pause** across **all three expensive stages** (transcribe/summarize/**compliance** processors + the transcribe→summarize→compliance chain treat a `window`-bearing job as an explicit operator action) so a *parked* station can still drain a one-off backfill end-to-end — the **global** kill switch still stops it. `scripts/backfill-quarter.ts --kick` re-enqueues the windowed chain **and** a windowed compliance sweep (which checks episodes already `summarized` before the chain reached compliance). Driver: **`scripts/backfill-quarter.ts`** (`npm run backfill-quarter -- --station <slug> --year <Y> --quarter <Q> --urls <file>`) inserts a flat list of archive MP3 URLs as `pending` episodes (dates/show keys parsed from the filename, show names + categories resolved from each show's live feed, duration filled from the audio at transcription), kicks the windowed chain, and — with `--generate` — enqueues the draft once they've summarized. The Generate page's quarter picker reaches back 6 years so a backfilled quarter is reviewable/finalizable in the UI.

**Search & the "find" views** (migrations 046_search_views … 052; note main also has unrelated 046–048 files — the tracker keys on full filename, so both sets apply once). Four dashboard views answer the everyday questions, each with URL-held state so links can be shared: **What aired** `/dashboard/day?date=&at=` (`/api/broadcast-day`, `lib/broadcast-day.ts` — station-local day log; same-show feeds folded, `2kpfk_` online-feed copies flagged), **What was said** `/dashboard/search` (`/api/transcript-search`), **What a show covered** `/dashboard/show-report?show=&from=&to=` (`/api/show-report`, `lib/show-report.ts`, by `show_group`), **Who was on** `/dashboard/people?q=|name=` (`/api/people`, `lib/people.ts`). Shared UI pieces live in `app/components/browse-ui.tsx`; shared date/time/link helpers in `lib/broadcast-format.ts` (`episode_log.duration` is **minutes**; air_date/air_start are station-local wall time). Transcript search is `lib/transcript-search.ts` → `search_transcripts_v2()`: the typed query is parsed in `lib/search-query.ts` (quotes, `-x`, `OR`) and each word widened to the spellings that actually occur, via the per-station vocabulary `search_vocab` (accent twins, plurals, and — for rare/absent words only — trigram look-alikes: "Hartmann" → Whisper's "Hartman"). Things that bit, all measured on live: (1) under RLS the planner seq-scanned every transcript (22s) — the search RPCs are therefore `SECURITY DEFINER` with an explicit `qir_assert_station_member()` check; (2) `transcripts`' heap is tiny (text is TOASTed) so the planner still preferred seq/index scans that detoast every tsvector — the functions `SET enable_seqscan/enable_indexscan = off` (bitmap only); (3) ranking detoasts too, so only the 200 most recent matches are ranked (`total_count` still counts all); (4) tsvector positions clamp at 16,383, so quoted phrases late in long shows are also matched per caption (`transcript_cues`). "By meaning" search uses **one vector per episode** (`episode_embeddings`: title/host/guests/issues/summary; `npm run backfill-episode-embeddings`, ~$0.02 for the archive) fused with the exact pass by reciprocal rank — per-chunk embeddings were retired because HNSW inserts cost ~1s/row on this instance (the worker stored ~1 in 5 while paying for all). The summarize worker embeds each batch and folds new transcripts into the vocabulary (`refresh_search_vocab`, watermarked; `npm run refresh-search-vocab` to catch up). `npm run search-benchmark` replays the fixed real-question set in `docs/search-benchmark.json` against a running app as a signed-in user.

**Broadcast-week verification** (`npm run verify-week -- --station <slug>`) answers "did what aired match what we expected to air?" for a date window (default: the last 7 station-local days). The *expected* side comes read-only from the sibling CMS app's tables in the shared database — `cms_schedule_published` (concrete per-date rows) when present for a date, else the recurring `cms_schedule_slots` weekly grid — matched to QIR airings (`episode_log`) by show identity + time overlap. Identity resolves as: the slot's CMS show → its `cms_show_source.qir_show_key` mappings + `program_slug`, **expanded through QIR's own `show_keys.show_group`** (one logical show spans multiple feed keys — e.g. the overnight strip logs six hourly keys), with a normalized-name fallback for label-only slots. Blocks whose show has no *active* `show_keys` row report as "not tracked" (QIR deliberately skips music/arts shows), not "missing". Layer 1 (always, free) reports per day: aired / partial / missing blocks, unscheduled airings (and what they displaced), plus pipeline issues — including `pending` episodes stranded behind the current-quarter gate (after the grace window; fix: `backfill-quarter --kick`). Layer 2 (`--verify`, ~150–200 gpt-4o-mini calls/week ≈ a few cents, logged to `usage_log` as operation `verify`) reads each transcript and checks the content actually supports the claimed show — catching reruns, pledge drives, substitute programming, and dead air the log alone can't reveal. Its prompt is the `verify_prompt` setting (default `DEFAULT_VERIFY_PROMPT` in `lib/settings.ts`, per-station override like every other AI prompt), and the pass honors the spend limits (skipped/aborted when over budget). Output: terminal summary + markdown/JSON reports in `reports/` (gitignored); each run leaves an `audit_log` row (`verify.week.complete`). It's a review aid, not pass/fail — preemptions are legitimate; a human decides. The engine is pure and unit-tested (`lib/verify-week.ts`); the driver (`scripts/verify-week.ts`) needs the worker env and is read-only apart from usage + audit logging.

**Transcription is provider-pluggable with fallback** (`lib/transcription/`). The worker resolves a per-station, ordered provider plan from the `transcription_providers` setting (array order = priority; each entry has an `enabled` toggle), keeping only providers whose API key is present in the env, then tries each in turn until one succeeds (`runTranscription`). **Groq** keeps the ffmpeg-chunk path, with its Whisper model chosen per station by the `transcription_model` setting (dropdown on the Groq row; catalog + per-hour prices in `lib/groq-models.ts`, default **turbo** at $0.04/hr vs large-v3 at $0.111/hr; all transcription rates live in `lib/transcription/pricing.ts`); **Deepgram** (nova-2) and **AssemblyAI** (universal) take the `mp3_url` directly (no ffmpeg) and **diarize** (speaker labels), gated by `diarization_enabled`. A genuine 404 (`AudioUnavailableError`) is terminal → episode marked `unavailable` (no fallthrough — no provider can fetch a missing file); other provider errors fall through to the next, and only an all-providers failure marks the episode `failed`. Each transcript records the `provider`/`model` that produced it; usage cost is logged at the actual provider's rate (`lib/usage.ts`). Speaker labels are emitted into the VTT as WebVTT `<v Speaker N>` voice spans — `lib/vtt.ts#parseVtt` strips those tags so transcript-search cues stay clean, and the plain `transcript` column stays speaker-free so summarization is undisturbed. Order/toggles + the diarization switch are edited at **Settings → Pipeline → Transcription Providers** (per-station override); the dashboard badges each provider configured/missing from `providerConfigStatus()` (key **presence** only, never the value). Defaults keep Groq primary (lowest cost, prior behaviour) with Deepgram then AssemblyAI as fallbacks — reorder to put a diarizing provider first for speaker captions on every episode.

**Episode source is per-station (Confessor primary, RSS fallback).** `stations.ingest_primary` (`'rss'` default | `'confessor'`) + `stations.confessor_base_url` pick where `workers/ingest.ts` pulls episodes. When Confessor is the primary AND a host is configured, ingest calls the archive's Confessor API (`?req=fil&id=<show key>` via `lib/confessor.ts`) — which, unlike RSS, returns the **human-entered `pubfile`** (host, guest name/topic, FCC `issue1..3`, free-text notes/rundown). If Confessor fails for a show, that show falls back to its RSS feed; everything else (dedupe by `mp3_url`, `pending` insert, the transcribe→summarize chain) is identical regardless of source. **Human metadata is preserved losslessly**: the full pubfile array is stored verbatim in `episode_log.confessor_meta` (jsonb), projected onto `host`/`guest`/`issue_category`, and any narrative kept in `human_summary`. Only KPFK is Confessor-primary (the only verified host, migration 035); other stations stay RSS until their host is confirmed.

**Per-field source provenance (human vs AI, both kept).** For the four dual-authored fields (`host`, `guest`, `issue_category`, `summary`), the app keeps **both** the human (Confessor) and AI copies plus a per-field `active` selector in `episode_log.field_sources` (jsonb) — the flat columns hold the *resolved* active value so every downstream reader (QIR, exports, public API, episode table) is unchanged. Logic lives in `lib/field-sources.ts` (pure, shared by workers + UI): ingest seeds the human copy (`buildHumanFieldSources`); summarize records the AI copy and resolves the winner (`applyAi`) — **human wins by default, but `issue_category` defaults to AI** (the model catches issues humans under-tag); a hand edit or the per-field toggle (`setFieldChoice`, `PATCH …{action:'set-field-source'}`) **pins** the field so a later re-summarize won't override the choice. Nothing is destroyed on conflict — both copies persist and the UI (`FieldSourcesCard` on the episode detail page) shows a `human ≠ AI` badge and a "repeated on N episodes — likely generic" warning when a human summary is byte-identical across a show (boilerplate guard, surfaced via `humanSummaryRepeats` from the episode GET).

**Confessor edits after air are pulled in by a nightly re-sync, not by ingest.** `workers/ingest.ts` is **insert-only** — it dedupes by `mp3_url` and `continue`s on an episode it has seen — so the human pubfile is a snapshot taken once, usually within an hour of air. A producer who fills in a guest the next morning or adds the FCC issue tags later was, until this, editing into a void. The logic lives in **`lib/confessor-resync.ts`**; **`workers/confessor-resync.ts`** runs it daily at 11:23 UTC for every station with a `confessor_base_url` (60 days = Confessor's whole `fil` window, apply on, honors pause), and when a write moves a **published** episode's resolved **host or guest** — the two values the summarizer is fed (`aiInputsChanged`) — it sends that episode back through summarize (status `transcribed` + `priority`, so the quarter window can't strand it; the chained compliance pass clears `priority`; flag triage survives). Human-summary/issue-tag changes reach the flat columns directly and do not re-summarize. The operator CLI **`scripts/resync-confessor.ts`** (`npm run resync-confessor -- --station kpfk [--days 30] [--show <key>] [--apply] [--resummarize]`) re-reads `?req=fil` for the shows that have episodes in the window, matches live rows to existing episodes by normalized `mp3_url`, and refreshes the **human** copies via `applyHuman` (`lib/field-sources.ts`). **Dry run is the default**; `--apply` writes. `applyHuman` is the counterpart to `applyAi` and is what keeps the re-sync non-destructive: it never touches the `ai` copy, never touches a `manual` override, and never changes which source wins on a **pinned** field — a pinned field still gets its human copy refreshed (so the dashboard and the `human ≠ AI` badge stay honest) while the pinned choice keeps driving the flat column. Clearing is deliberate: a segment deleted upstream nulls the human copy and an un-pinned field falls back to AI. Two limits worth knowing: Confessor's `fil` window (`days` in the response, 60 for most KPFK shows) means episodes past it can never be re-read at any `--days` value; and every updated row's `updated_at` moves, so a large first run appears as a burst in the next `/api/v1/episodes?updated_since=` delta. Measured on `bradcast2` over 60 days: 40/40 live rows matched a stored episode and 5 carried changed human metadata (summary 5, guest 2), all `null → content`.

**Pipeline pause is layered** (`lib/settings.ts#isPipelinePaused(stationId?)`). A **global** master flag (`qir_settings.pipeline_paused`) pauses everything — it's the only signal that can BullMQ-`pause()` the *shared* worker pool wholesale (`workers/index.ts#syncPipelineMode`). Each station may *additionally* be paused on its own via `station_settings(station_id,'pipeline_paused')`; since the shared pool can't be paused per station, per-station pause is enforced one level up — the ingest dispatcher skips paused stations on fan-out, the auto-chain hooks skip them, and each stage processor (`transcribe`/`summarize`/`compliance`) early-skips a job whose station is paused. Effective state = `global OR station`. The Jobs page (active station) drives the global flag; the super-admin **Master Control** (`/dashboard/master` ↔ `api/admin/overview`) drives per-station pause/resume, run-now, and failed-job retry/clear across all stations. `isStationPaused(stationId)` reads a station's own flag in isolation (for the master view). Both pause reads are uncached (control signal).

**Settings are in the database**, not env vars. Categories, batch sizes, models, prompts — all editable from the dashboard without redeploying.

**Compliance config is centralized (master-level)** because FCC rules are federal/uniform. The `compliance_prompt` and the `compliance_blocking` gate are **global-only** (`lib/settings.ts` reads them with no `stationId`; edited only via `PUT /api/settings {scope:'global'}`, super-admin-gated). `compliance_checks_enabled` is **central default + local override** (super-admin sets the global default with `scope:'global'`; a station admin may still override for their station). The `compliance_wordlist` is **two-layer**: rows with `station_id IS NULL` are the global base (super-admin managed, apply to every station); per-station rows are local additions. The compliance worker flags on the **union** (`station_id = me OR station_id IS NULL`); RLS lets members read the base + their own rows but only super-admins write base rows (migration 030). Only station-ID detection stays per-station (`stations.station_id_patterns`). **The AI pass** (`runAiComplianceCheck`) reads the **whole** transcript in 15k-char windows with the global-only `compliance_model` (default **gpt-4.1-mini**, `DEFAULT_COMPLIANCE_MODEL` in `lib/openai-models.ts`; dropdown on the Compliance Prompt card) and can return `profanity` / `indecency` / `payola_plugola` / `sponsor_id` flags. It exists mainly to catch what the word list can't: Whisper self-censors lyric profanity (`f***ing`, `p***`), and minced/variant forms ("effing", "rhymes with itch"). Each AI flag obeys its `compliance_checks_enabled` toggle (payola/sponsor are **off** — they were almost all pledge premiums and event listings), safe harbor downgrades AI profanity/indecency to warnings like the word list, and AI profanity the list already caught is dropped. The word list matches with Unicode-aware boundaries (`lib/compliance-match.ts`) — plain `\b` made "vehículo"/"artículo" hit "culo" (19% of all profanity flags before the fix). **Blocking** (`isComplianceBlocking()`, consumed in `generate-qir.ts`): when on, an episode with an unresolved **critical** flag (review_status ≠ `dismissed`) is held out of the QIR draft; warnings never block.

**Auth is active** — `dashboard/layout.tsx` requires a Supabase session and redirects to `/login` otherwise. (An older note about an "auth bypass" is obsolete.)

**Transcript corrections** are applied as post-processing after the provider returns text. They support plain text and regex patterns, and a scope: station-wide, one **show** (`show_key`, every feed of its `show_group`) or one episode. Managed from Settings → Corrections. **Rules also fix stored transcripts**: a rule with `backfilled_at` null (new, edited, re-enabled, or approved) is re-applied by the corrections worker to every stored transcript in its scope — transcript text, VTT cue text (never timings or `<v>` tags), `transcript_cues`, and re-embedded `transcript_chunks` — then stamped (`lib/transcription/repair.ts`). Text only, no audio. A rule whose replacement re-matches itself ("Cary" → "Cary Harrison") is skipped for stored text. All rule logic lives in `lib/transcription/corrections.ts` (JS regex — never translated to SQL except as a superset prefilter, because Postgres reads `\b` as backspace).

**Names: vocabulary hint + suggested corrections** (design + measurements: `docs/names-vocabulary-scan.md`). `transcript_vocabulary` holds each show's correctly spelled hosts/regulars (`show_key` null = station-wide terms). It is seeded from Confessor's DJ list (migration 048), and the corrections worker copies new website (CMS) hosts in nightly; a name switched **off** is never re-added. Two consumers: (1) the **Whisper hint** — when `vocabulary_hint_enabled` (per station, default **off**), Groq gets a short comma list (station terms, show names, that episode's Confessor names; ≤600 UTF-8 bytes) as `prompt`; **never for Music** (every prompt made music transcripts worse, and Groq's no_speech_prob can't detect music), a rejected prompt retries the chunk without it, and segments that echo the list back are dropped. (2) the **nightly miner** — `mine_name_variants()` (SQL, pg_trgm) finds capitalized pairs near a show's known names in its last 60 days of transcripts; `lib/transcription/suggestions.ts` filters noise; results wait in `transcript_correction_suggestions` until a person approves (creates a show-scoped rule → repair) or rejects (sticks). Measure changes with `npm run benchmark-names` (fixed episode set incl. music, ~$0.30/run on turbo).

**Cost tracking** is automatic. Every Groq and OpenAI API call is logged to `usage_log` with estimated cost.

**Public Read API (`/api/v1/*`)** is a versioned, read-only (GET) API for external consumers (e.g. a sibling podcast app pulling captions/VTT and generating tags). Every route is built from `lib/api-handler.ts#withApiKey(handler, { scope, cache })`, which runs the request through, in order: **API-key auth** (`lib/api-auth.ts` — sha256 hash lookup against `api_keys`, no Supabase JWT) → **scope gate** (`requireScope`) → **per-key rate limit** (`lib/ratelimit.ts` — atomic Redis sliding window, fails *open*) → **Redis response cache** (`lib/api-cache.ts` — versioned invalidation, fails *open*) → the handler, then sets `ETag` (with `If-None-Match` → 304), `Cache-Control: private`, `X-RateLimit-*`, and `X-Cache`. Handlers run as **service-role** (`supabaseAdmin`) with an explicit `.eq('station_id', ctx.stationId)` as the tenancy guard (the worker convention) — RLS on `api_keys` and the tenant tables is the backstop. Keys are **station-scoped** and carry **scopes**: `qir`, `episodes`, `transcripts` (captions — opt-in, *not* in the default scope set), `shows`, `usage`. The cache is invalidated on QIR finalize via `bumpCacheVersion(stationId, 'qir')` in `app/api/qir/route.ts`; volatile resources (episodes/usage) rely on short TTLs and the `?since` updated_at cursor instead. Keys are minted/revoked by station admins at `/dashboard/api-keys` (→ `app/api/keys/route.ts`); the raw secret is shown **once** at creation and only its hash is stored. **When you add a new v1 endpoint, reuse `withApiKey`; when you add a scope, add it to `ApiScope` in `lib/types.ts` and `VALID_SCOPES` in `app/api/keys/route.ts`.**

**The episode feed (`GET /api/v1/episodes`) is the published contract** — the consumer-facing doc is `docs/specs/public-episodes-api.md`. Its pure logic lives in `lib/episode-feed.ts` (unit-tested; the route is a thin Supabase query built from it). Three things are deliberate: (1) **published-only** — `PUBLISHED_STATUSES` is `summarized` + `compliance_checked`; every earlier/failed pipeline state is unreachable, and asking for one is a `400` rather than an empty page. (2) **Field allowlist** — `FEED_SELECT` names every exposed column, so adding a column to `episode_log` never silently widens the contract. (3) **Keyset pagination** on `(updated_at, id)` ascending with an opaque base64url `cursor`, `limit + 1` lookahead for `has_more`, envelope `{ data, next_cursor, has_more, count, limit }`. Offset pagination loses rows while workers are writing, which is why sync uses the cursor. There is **no offset mode**: `page`/`sort`/`order`/`since` are retired and return a `400` pointing at the cursor contract (`since` is no longer aliased to `updated_since`). An earlier revision served the old `{ episodes, total, page, limit }` shape to any request carrying them; no consumer was ever on it, so it was removed rather than kept alive. **A route whose response depends on a property of the calling KEY must declare `cache.vary` in `withApiKey`** — `/api/v1` cache entries are shared across a station's keys, so without it one key's body is served to another; `episodes/[id]` declares it because `?include=transcript` embeds captions only for a key holding the `transcripts` scope, and a shared entry would hand them to a key that lacks it. The stable public identifier is **`episode_log.public_id`** (opaque uuid, migration 043) — `resolveEpisodeRef()` accepts it *or* the legacy integer row id on `/episodes/{id}` and `/episodes/{id}/transcript` so issued links keep resolving. A publish **webhook** is the deliberate next step (latency), not a replacement for this feed (backfill + reconciliation).

**Audit logging** is hybrid and append-only (`audit_log`, migration 028; super-admin-only at `/dashboard/audit`). DB triggers (`audit_row_change()`) capture *every* mutation on tenant tables — user-attributed via `auth.uid()`, or `system` for worker/service-role writes. App-layer `lib/audit.ts#logAuditEvent` captures what triggers can't: reads/views, auth events, exports/downloads, and worker stage-completion events. Retention is **permanent** (no TTL/cron cleanup); the dashboard shows a trailing 30-day window with a "full history retained" banner. **When you add a new app-layer event type, register it in `lib/audit.ts` — `AUDIT_OPERATIONS` (must also match the DB `operation` CHECK) and `AUDIT_ACTIONS` are the single source of truth; client-postable events go in `CLIENT_AUDIT_EVENTS`. When you add a new tenant table, add it to the trigger loop in migration 028.** Heavy strings (>2000 chars) are redacted to `<redacted: N chars>` markers at capture so the permanent table stays lean.

## Multi-Station (Multi-Tenant) Model

The app is multi-tenant: **one codebase, one database, one deployment** serving multiple radio stations (KPFK + the other Pacifica stations). Isolation is **defense in depth** — Postgres RLS is the hard backstop, and app code *also* filters every query by `station_id`.

- **Tenant tables** (migrations 012–015): `stations` (slug, name, timezone, `rss_base_url`, `mp3_filename_prefix`, `station_id_patterns`), `station_users` (user↔station with role viewer/editor/admin), `super_admins`, `station_settings` (per-station overrides). Every tenant-scoped table (`episode_log`, `show_keys`, `qir_drafts`, `transcript_corrections`, `compliance_wordlist`, `usage_log`) carries `station_id`; `transcripts`/`compliance_flags` inherit scope via their `episode_id` join. `qir_settings` stays **global** (the default layer under `station_settings`).
- **RLS** (014): `user_station_ids()` returns the caller's stations (memberships, or all for super_admins); policies gate every tenant table by it. Finalized `qir_drafts` are additionally public-readable (`status='final'`). Writes additionally need **editor** (`user_has_station_role(station_id, 'editor')`, migration 054), mirroring `lib/auth.ts#requireRole`. The public **anon** key can read only `episode_log`'s published rows and only `mp3_url, headline, host, guest, summary, transcript_url` (the public site's episode player), plus `tags`/`show_tags` (053). Everything else it can't touch: `qir_settings` and `schema_migrations` are service-role/postgres only. **When the public site needs another field, grant that column to anon explicitly; never add a `USING (true)` policy.**
- **Request path**: `lib/auth.ts#getStationContext(request)` resolves the caller (Bearer token), their allowed stations, and the active station (from the `qir_station` cookie / `x-station-slug` header), returning a **request-scoped RLS client**. API routes use it + an explicit `.eq('station_id', …)`. Client pages call `lib/api-client.ts#authedFetch`. The active station is chosen client-side by the station switcher — the server never defaults one (a wrong default would leak cross-tenant).
- **Workers** run with the service-role client (RLS bypassed), so their `station_id` filter is the *only* guard. Jobs carry `stationId`; the ingest/auto-retry cron acts as a per-station **dispatcher** (fans out one job per station); transcribe/summarize/compliance filter both the candidate-select and the atomic claim guard by `station_id`.
- **Settings** resolve per station: `station_settings(station_id,key)` → global `qir_settings(key)` → hard-coded default (`lib/settings.ts`, 60s cache keyed by `(stationId,key)`). Prompts interpolate `{{STATION_NAME}}`.
- **Public reports** live at `/[station]/[year]/q[N]` (route folder `[station]/[year]/[quarter]`); legacy `/[year]/q[N]` 308-redirects to `/kpfk/...` (next.config.js) so filed FCC links keep resolving.

### Provisioning a new station (SQL/admin, no UI yet)

1. **Create the station:** `insert into stations (slug, name, timezone, rss_base_url, mp3_filename_prefix, station_id_patterns) values ('wxyz', 'WXYZ, City', 'America/New_York', 'https://archive.example.org/getrss.php?id=', 'wxyz', array['wxyz','101.5']);` — `rss_base_url` is the full prefix up to `?id=` (the show key is appended); leave it null until known (ingest skips the station, visibly, until set).
2. **Add shows:** mostly automatic. A **daily discovery sync** (`workers/discover-sync.ts`, cron 06:37 + on startup; also `POST /api/jobs {action:'discover-sync'}`) scrapes the station's archive program list and inserts any **new** `show_keys` as **`active = false`** — opt-out onboarding: every program lands for review, nothing pulls until you activate it. Existing/curated rows are never touched. Gated per station by `discovery_sync_enabled` (default true); a station with `discovery_auto_activate` = true (toggle: Settings → Shows → "Auto-activate new shows") imports new programs **active** instead (KPFK, migration 044 — it processes every show, music included, so the profanity check covers lyrics). The scraper reads only the program `<select id="sh_altid">`; it once also scraped the category filter (`id="ca_id"`, numeric keys "0".."14"), and those bogus rows are archived by 044. Then review the inactive shows and activate the ones you want (drop Music/Español/dupes). You can also add shows manually via the dashboard (Settings → Shows → "Add shows") — three import paths, all landing in the same review grid → save (`POST /api/settings`, `resource:'shows'`):
   - **"Discover from archive"** (`GET /api/shows/discover`) — one click enumerates the station's **entire** program list by scraping the `<option value="key">Name</option>` dropdown on the archive home page (`new URL(rss_base_url).origin`). Verified identical markup across KPFK/KPFA/WPFW/KPFT. Pick from a checklist; the selected keys flow through resolve (below).
   - **"Look up" by key** (`POST /api/shows/resolve`) — paste bare show keys; resolves each name + category from the live per-show feed.
   - **Paste a spreadsheet** (name, key, category, language) for fully manual entry.

   Resolve/discover are read-only previews and fail visibly if `rss_base_url` is unset. Category comes from each feed's plain `<category>` (e.g. "Español"/"Music"), which is what the ingest exclusion list matches — not the generic `<itunes:category>`. Ingest only pulls **active** `show_keys`, so a station with feed config but no shows pulls nothing.
3. **Grant access:** `insert into station_users (station_id, user_id, role) values (<station>, <auth.users.id>, 'admin');` (or add to `super_admins` for all-station access).
4. **Optional overrides:** insert `station_settings` rows (e.g. a station-specific `summarization_prompt`) — otherwise the global `qir_settings` defaults apply. (Note: `compliance_prompt`/`compliance_blocking` are **global-only** and cannot be overridden per station — see "Compliance config is centralized".)
5. Workers pick the station up automatically on the next ingest cron tick.

## Commands

```bash
npm run dev          # Next.js dev server (localhost:3000)
npm run workers      # BullMQ background workers
npm run start:all    # Production: both processes via concurrently
npm run build        # Next.js production build
```

## Current State & Known Issues

See `IMPROVEMENTS.md` for the prioritized improvement plan. Key items:

- **P0 (before going live):** Missing DB indexes, no OpenAI retry logic, no BullMQ job timeouts
- **P1 (next sprint):** Separate workers from web server, Docker resource limits, fix N+1 queries
- **Multi-station follow-ups:** the `get_episode_counts_by_show` RPC is not station-aware (can over-count episodes for show keys shared across stations) — needs a migration adding a `station_id` arg. KPFA/WPFW/KPFT have `rss_base_url`/`mp3_filename_prefix` set (migration 020); the daily discovery sync now auto-imports their `show_keys` as inactive, so onboarding is review-and-activate rather than manual entry. WBAI is deferred (its archive uses a different URL format — left NULL, skipped by both ingest and discovery).
- **No tests** — the three targeted integration tests (RLS isolation, settings fallback, worker claim scoping) require a throwaway Postgres and are still pending.

## Environment

Runs on a VPS behind Traefik reverse proxy at `qir.kpfk.org`. Supabase is hosted (not self-hosted). Redis runs in a sidecar container. The archive server at `archive.kpfk.org` provides RSS feeds and MP3 files.
