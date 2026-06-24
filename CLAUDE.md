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

- **Next.js 14** (App Router) — dashboard UI + API routes + public QIR pages
- **Supabase** (PostgreSQL + Auth) — all persistent state
- **BullMQ + Redis** — background job queues with hourly cron
- **Groq API** (whisper-large-v3) — audio transcription
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
  summarize.ts      — Load transcript → OpenAI → parse JSON → update episode metadata.
                      Records AI copy + resolves human/AI winner per field
                      (lib/field-sources.ts)
  generate-qir.ts   — Group episodes → OpenAI curation → build draft
  discover-sync.ts  — Daily: scrape each station's archive program list →
                      insert NEW show_keys as inactive (opt-out onboarding)
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
  redis.ts          — Shared lazy ioredis client (used by locks, ratelimit, api-cache)
  api-auth.ts       — API-key auth for the public read API (hash lookup + scopes)
  ratelimit.ts      — Redis sliding-window rate limiter (per key)
  api-cache.ts      — Redis response cache with versioned invalidation
  api-handler.ts    — withApiKey() wrapper: auth → scope → rate-limit → cache → ETag
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
  corrections/route.ts      — CRUD for transcript corrections
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
    qir/[year]/q[quarter]/route.ts — one finalized report + curated entries
    episodes/route.ts             — paginated episodes (?since cursor for sync)
    episodes/[id]/route.ts        — episode detail (?include=transcript)
    episodes/[id]/transcript/route.ts — captions: VTT (?format=vtt) or JSON
    shows/route.ts                — program list
    usage/route.ts                — AI cost/usage summary
```

### Dashboard Pages (all `'use client'`)

```
app/dashboard/
  layout.tsx                — Sidebar nav, auth wrapper, error boundary
  page.tsx                  — Overview: pipeline viz, stats, cost analytics, activity feed
  episodes/page.tsx         — Episode table with filters, sort, bulk actions, CSV export
  episodes/[id]/page.tsx    — Episode detail: audio player, transcript, edit summary
  jobs/page.tsx             — Queue status monitoring (active station)
  master/page.tsx           — Master Control (super-admin only): all-station pipeline
                              activity + per-station pause/resume, run-now, retry/clear
  generate/page.tsx         — QIR draft builder: generate, curate, edit entries, finalize
  usage/page.tsx            — Cost tracking with date range
  audit/page.tsx            — Audit log viewer (super-admin only; trailing window, diff view)
  settings/page.tsx         — App config + transcript corrections CRUD
  downloads/page.tsx        — Batch export hub
```

### Public Pages

```
app/
  page.tsx                  — Redirects to /dashboard
  login/page.tsx            — Supabase email/password auth
  [station]/[year]/q[quarter]/page.tsx — Public finalized QIR (per-station, print-friendly; dynamic so each view, incl. anonymous, is audited)
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
```

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

**Steady-state is current-quarter-scoped; backfills opt out via a window.** The transcribe + summarize candidate queries are pinned to the **current calendar quarter** (`getCurrentQuarterBounds()`) — that's the live FCC cadence and what the dashboard backlog reflects. A historical one-off (e.g. retro-generating WPFW's Q4 2020 QIR from an archive backup) gets past that gate by passing an explicit `{ window: { start, end } }` in the transcribe/summarize job data; `resolveWindow(job)` uses it instead of the current quarter, and the continue/backoff/chain re-enqueues (`workers/index.ts`) thread the same window through the whole drain. QIR *generation* was never quarter-locked (`generate-qir.ts` is parameterized by `year`/`quarter`). A windowed backfill also **bypasses the per-station pause** (the transcribe/summarize processors + the transcribe→summarize chain treat a `window`-bearing job as an explicit operator action) so a *parked* station can still drain a one-off backfill — the **global** kill switch still stops it, and the summarize→compliance chain stays park-gated so a backfill ends at `summarized` (which the QIR draft accepts). Driver: **`scripts/backfill-quarter.ts`** (`npm run backfill-quarter -- --station <slug> --year <Y> --quarter <Q> --urls <file>`) inserts a flat list of archive MP3 URLs as `pending` episodes (dates/show keys parsed from the filename, show names + categories resolved from each show's live feed, duration filled from the audio at transcription), kicks the windowed chain, and — with `--generate` — enqueues the draft once they've summarized. The Generate page's quarter picker reaches back 6 years so a backfilled quarter is reviewable/finalizable in the UI.

**Transcription is provider-pluggable with fallback** (`lib/transcription/`). The worker resolves a per-station, ordered provider plan from the `transcription_providers` setting (array order = priority; each entry has an `enabled` toggle), keeping only providers whose API key is present in the env, then tries each in turn until one succeeds (`runTranscription`). **Groq** (whisper-large-v3) keeps the ffmpeg-chunk path; **Deepgram** (nova-2) and **AssemblyAI** (universal) take the `mp3_url` directly (no ffmpeg) and **diarize** (speaker labels), gated by `diarization_enabled`. A genuine 404 (`AudioUnavailableError`) is terminal → episode marked `unavailable` (no fallthrough — no provider can fetch a missing file); other provider errors fall through to the next, and only an all-providers failure marks the episode `failed`. Each transcript records the `provider`/`model` that produced it; usage cost is logged at the actual provider's rate (`lib/usage.ts`). Speaker labels are emitted into the VTT as WebVTT `<v Speaker N>` voice spans — `lib/vtt.ts#parseVtt` strips those tags so transcript-search cues stay clean, and the plain `transcript` column stays speaker-free so summarization is undisturbed. Order/toggles + the diarization switch are edited at **Settings → Pipeline → Transcription Providers** (per-station override); the dashboard badges each provider configured/missing from `providerConfigStatus()` (key **presence** only, never the value). Defaults keep Groq primary (lowest cost, prior behaviour) with Deepgram then AssemblyAI as fallbacks — reorder to put a diarizing provider first for speaker captions on every episode.

**Episode source is per-station (Confessor primary, RSS fallback).** `stations.ingest_primary` (`'rss'` default | `'confessor'`) + `stations.confessor_base_url` pick where `workers/ingest.ts` pulls episodes. When Confessor is the primary AND a host is configured, ingest calls the archive's Confessor API (`?req=fil&id=<show key>` via `lib/confessor.ts`) — which, unlike RSS, returns the **human-entered `pubfile`** (host, guest name/topic, FCC `issue1..3`, free-text notes/rundown). If Confessor fails for a show, that show falls back to its RSS feed; everything else (dedupe by `mp3_url`, `pending` insert, the transcribe→summarize chain) is identical regardless of source. **Human metadata is preserved losslessly**: the full pubfile array is stored verbatim in `episode_log.confessor_meta` (jsonb), projected onto `host`/`guest`/`issue_category`, and any narrative kept in `human_summary`. Only KPFK is Confessor-primary (the only verified host, migration 035); other stations stay RSS until their host is confirmed.

**Per-field source provenance (human vs AI, both kept).** For the four dual-authored fields (`host`, `guest`, `issue_category`, `summary`), the app keeps **both** the human (Confessor) and AI copies plus a per-field `active` selector in `episode_log.field_sources` (jsonb) — the flat columns hold the *resolved* active value so every downstream reader (QIR, exports, public API, episode table) is unchanged. Logic lives in `lib/field-sources.ts` (pure, shared by workers + UI): ingest seeds the human copy (`buildHumanFieldSources`); summarize records the AI copy and resolves the winner (`applyAi`) — **human wins by default, but `issue_category` defaults to AI** (the model catches issues humans under-tag); a hand edit or the per-field toggle (`setFieldChoice`, `PATCH …{action:'set-field-source'}`) **pins** the field so a later re-summarize won't override the choice. Nothing is destroyed on conflict — both copies persist and the UI (`FieldSourcesCard` on the episode detail page) shows a `human ≠ AI` badge and a "repeated on N episodes — likely generic" warning when a human summary is byte-identical across a show (boilerplate guard, surfaced via `humanSummaryRepeats` from the episode GET).

**Pipeline pause is layered** (`lib/settings.ts#isPipelinePaused(stationId?)`). A **global** master flag (`qir_settings.pipeline_paused`) pauses everything — it's the only signal that can BullMQ-`pause()` the *shared* worker pool wholesale (`workers/index.ts#syncPipelineMode`). Each station may *additionally* be paused on its own via `station_settings(station_id,'pipeline_paused')`; since the shared pool can't be paused per station, per-station pause is enforced one level up — the ingest dispatcher skips paused stations on fan-out, the auto-chain hooks skip them, and each stage processor (`transcribe`/`summarize`/`compliance`) early-skips a job whose station is paused. Effective state = `global OR station`. The Jobs page (active station) drives the global flag; the super-admin **Master Control** (`/dashboard/master` ↔ `api/admin/overview`) drives per-station pause/resume, run-now, and failed-job retry/clear across all stations. `isStationPaused(stationId)` reads a station's own flag in isolation (for the master view). Both pause reads are uncached (control signal).

**Settings are in the database**, not env vars. Categories, batch sizes, models, prompts — all editable from the dashboard without redeploying.

**Compliance config is centralized (master-level)** because FCC rules are federal/uniform. The `compliance_prompt` and the `compliance_blocking` gate are **global-only** (`lib/settings.ts` reads them with no `stationId`; edited only via `PUT /api/settings {scope:'global'}`, super-admin-gated). `compliance_checks_enabled` is **central default + local override** (super-admin sets the global default with `scope:'global'`; a station admin may still override for their station). The `compliance_wordlist` is **two-layer**: rows with `station_id IS NULL` are the global base (super-admin managed, apply to every station); per-station rows are local additions. The compliance worker flags on the **union** (`station_id = me OR station_id IS NULL`); RLS lets members read the base + their own rows but only super-admins write base rows (migration 030). Only station-ID detection stays per-station (`stations.station_id_patterns`). **Blocking** (`isComplianceBlocking()`, consumed in `generate-qir.ts`): when on, an episode with an unresolved **critical** flag (review_status ≠ `dismissed`) is held out of the QIR draft; warnings never block.

**Auth is active** — `dashboard/layout.tsx` requires a Supabase session and redirects to `/login` otherwise. (An older note about an "auth bypass" is obsolete.)

**Transcript corrections** are applied as post-processing after Groq returns text. They support plain text and regex patterns. Managed from the Settings page.

**Cost tracking** is automatic. Every Groq and OpenAI API call is logged to `usage_log` with estimated cost.

**Public Read API (`/api/v1/*`)** is a versioned, read-only (GET) API for external consumers (e.g. a sibling podcast app pulling captions/VTT and generating tags). Every route is built from `lib/api-handler.ts#withApiKey(handler, { scope, cache })`, which runs the request through, in order: **API-key auth** (`lib/api-auth.ts` — sha256 hash lookup against `api_keys`, no Supabase JWT) → **scope gate** (`requireScope`) → **per-key rate limit** (`lib/ratelimit.ts` — atomic Redis sliding window, fails *open*) → **Redis response cache** (`lib/api-cache.ts` — versioned invalidation, fails *open*) → the handler, then sets `ETag` (with `If-None-Match` → 304), `Cache-Control: private`, `X-RateLimit-*`, and `X-Cache`. Handlers run as **service-role** (`supabaseAdmin`) with an explicit `.eq('station_id', ctx.stationId)` as the tenancy guard (the worker convention) — RLS on `api_keys` and the tenant tables is the backstop. Keys are **station-scoped** and carry **scopes**: `qir`, `episodes`, `transcripts` (captions — opt-in, *not* in the default scope set), `shows`, `usage`. The cache is invalidated on QIR finalize via `bumpCacheVersion(stationId, 'qir')` in `app/api/qir/route.ts`; volatile resources (episodes/usage) rely on short TTLs and the `?since` updated_at cursor instead. Keys are minted/revoked by station admins at `/dashboard/api-keys` (→ `app/api/keys/route.ts`); the raw secret is shown **once** at creation and only its hash is stored. **When you add a new v1 endpoint, reuse `withApiKey`; when you add a scope, add it to `ApiScope` in `lib/types.ts` and `VALID_SCOPES` in `app/api/keys/route.ts`.**

**Audit logging** is hybrid and append-only (`audit_log`, migration 028; super-admin-only at `/dashboard/audit`). DB triggers (`audit_row_change()`) capture *every* mutation on tenant tables — user-attributed via `auth.uid()`, or `system` for worker/service-role writes. App-layer `lib/audit.ts#logAuditEvent` captures what triggers can't: reads/views, auth events, exports/downloads, and worker stage-completion events. Retention is **permanent** (no TTL/cron cleanup); the dashboard shows a trailing 30-day window with a "full history retained" banner. **When you add a new app-layer event type, register it in `lib/audit.ts` — `AUDIT_OPERATIONS` (must also match the DB `operation` CHECK) and `AUDIT_ACTIONS` are the single source of truth; client-postable events go in `CLIENT_AUDIT_EVENTS`. When you add a new tenant table, add it to the trigger loop in migration 028.** Heavy strings (>2000 chars) are redacted to `<redacted: N chars>` markers at capture so the permanent table stays lean.

## Multi-Station (Multi-Tenant) Model

The app is multi-tenant: **one codebase, one database, one deployment** serving multiple radio stations (KPFK + the other Pacifica stations). Isolation is **defense in depth** — Postgres RLS is the hard backstop, and app code *also* filters every query by `station_id`.

- **Tenant tables** (migrations 012–015): `stations` (slug, name, timezone, `rss_base_url`, `mp3_filename_prefix`, `station_id_patterns`), `station_users` (user↔station with role viewer/editor/admin), `super_admins`, `station_settings` (per-station overrides). Every tenant-scoped table (`episode_log`, `show_keys`, `qir_drafts`, `transcript_corrections`, `compliance_wordlist`, `usage_log`) carries `station_id`; `transcripts`/`compliance_flags` inherit scope via their `episode_id` join. `qir_settings` stays **global** (the default layer under `station_settings`).
- **RLS** (014): `user_station_ids()` returns the caller's stations (memberships, or all for super_admins); policies gate every tenant table by it. Finalized `qir_drafts` are additionally public-readable (`status='final'`).
- **Request path**: `lib/auth.ts#getStationContext(request)` resolves the caller (Bearer token), their allowed stations, and the active station (from the `qir_station` cookie / `x-station-slug` header), returning a **request-scoped RLS client**. API routes use it + an explicit `.eq('station_id', …)`. Client pages call `lib/api-client.ts#authedFetch`. The active station is chosen client-side by the station switcher — the server never defaults one (a wrong default would leak cross-tenant).
- **Workers** run with the service-role client (RLS bypassed), so their `station_id` filter is the *only* guard. Jobs carry `stationId`; the ingest/auto-retry cron acts as a per-station **dispatcher** (fans out one job per station); transcribe/summarize/compliance filter both the candidate-select and the atomic claim guard by `station_id`.
- **Settings** resolve per station: `station_settings(station_id,key)` → global `qir_settings(key)` → hard-coded default (`lib/settings.ts`, 60s cache keyed by `(stationId,key)`). Prompts interpolate `{{STATION_NAME}}`.
- **Public reports** live at `/[station]/[year]/q[quarter]`; legacy `/[year]/q[quarter]` 308-redirects to `/kpfk/...` (next.config.js) so filed FCC links keep resolving.

### Provisioning a new station (SQL/admin, no UI yet)

1. **Create the station:** `insert into stations (slug, name, timezone, rss_base_url, mp3_filename_prefix, station_id_patterns) values ('wxyz', 'WXYZ, City', 'America/New_York', 'https://archive.example.org/getrss.php?id=', 'wxyz', array['wxyz','101.5']);` — `rss_base_url` is the full prefix up to `?id=` (the show key is appended); leave it null until known (ingest skips the station, visibly, until set).
2. **Add shows:** mostly automatic. A **daily discovery sync** (`workers/discover-sync.ts`, cron 06:37 + on startup; also `POST /api/jobs {action:'discover-sync'}`) scrapes the station's archive program list and inserts any **new** `show_keys` as **`active = false`** — opt-out onboarding: every program lands for review, nothing pulls until you activate it. Existing/curated rows are never touched. Gated per station by `discovery_sync_enabled` (default true). Then review the inactive shows and activate the ones you want (drop Music/Español/dupes). You can also add shows manually via the dashboard (Settings → Shows → "Add shows") — three import paths, all landing in the same review grid → save (`POST /api/settings`, `resource:'shows'`):
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
