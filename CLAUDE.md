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
  ingest.ts         — RSS fetch → parse → dedupe → insert episodes
  transcribe.ts     — ffmpeg chunk → Groq Whisper → corrections → store transcript + VTT
  summarize.ts      — Load transcript → OpenAI → parse JSON → update episode metadata
  generate-qir.ts   — Group episodes → OpenAI curation → build draft
```

### Library / Shared

```
lib/
  supabase.ts       — Supabase clients (admin for server, browser for client)
  queue.ts          — BullMQ queue instances (ingest, transcribe, summarize, generate-qir)
  settings.ts       — Settings cache (60s TTL) reading from qir_settings table
  usage.ts          — Cost logging helpers (Groq per-second, OpenAI per-token)
  types.ts          — TypeScript interfaces for all database tables
  qir-format.ts     — Report formatting and date range helpers
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
```

### Dashboard Pages (all `'use client'`)

```
app/dashboard/
  layout.tsx                — Sidebar nav, auth wrapper, error boundary
  page.tsx                  — Overview: pipeline viz, stats, cost analytics, activity feed
  episodes/page.tsx         — Episode table with filters, sort, bulk actions, CSV export
  episodes/[id]/page.tsx    — Episode detail: audio player, transcript, edit summary
  jobs/page.tsx             — Queue status monitoring
  generate/page.tsx         — QIR draft builder: generate, curate, edit entries, finalize
  usage/page.tsx            — Cost tracking with date range
  settings/page.tsx         — App config + transcript corrections CRUD
  downloads/page.tsx        — Batch export hub
```

### Public Pages

```
app/
  page.tsx                  — Redirects to /dashboard
  login/page.tsx            — Supabase email/password auth
  [year]/q[quarter]/page.tsx — Public finalized QIR (server-rendered, print-friendly)
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

**Settings are in the database**, not env vars. Categories, batch sizes, models, prompts — all editable from the dashboard without redeploying.

**Auth is active** — `dashboard/layout.tsx` requires a Supabase session and redirects to `/login` otherwise. (An older note about an "auth bypass" is obsolete.)

**Transcript corrections** are applied as post-processing after Groq returns text. They support plain text and regex patterns. Managed from the Settings page.

**Cost tracking** is automatic. Every Groq and OpenAI API call is logged to `usage_log` with estimated cost.

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
2. **Add shows:** insert `show_keys` rows with that `station_id`, **or** use the dashboard (Settings → Shows → "Add shows"). Three import paths, all landing in the same review grid → save (`POST /api/settings`, `resource:'shows'`):
   - **"Discover from archive"** (`GET /api/shows/discover`) — one click enumerates the station's **entire** program list by scraping the `<option value="key">Name</option>` dropdown on the archive home page (`new URL(rss_base_url).origin`). Verified identical markup across KPFK/KPFA/WPFW/KPFT. Pick from a checklist; the selected keys flow through resolve (below).
   - **"Look up" by key** (`POST /api/shows/resolve`) — paste bare show keys; resolves each name + category from the live per-show feed.
   - **Paste a spreadsheet** (name, key, category, language) for fully manual entry.

   Resolve/discover are read-only previews and fail visibly if `rss_base_url` is unset. Category comes from each feed's plain `<category>` (e.g. "Español"/"Music"), which is what the ingest exclusion list matches — not the generic `<itunes:category>`. Ingest only pulls **active** `show_keys`, so a station with feed config but no shows pulls nothing.
3. **Grant access:** `insert into station_users (station_id, user_id, role) values (<station>, <auth.users.id>, 'admin');` (or add to `super_admins` for all-station access).
4. **Optional overrides:** insert `station_settings` rows (e.g. a station-specific `summarization_prompt`/`compliance_prompt`) — otherwise the global `qir_settings` defaults apply.
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
- **Multi-station follow-ups:** the `get_episode_counts_by_show` RPC is not station-aware (can over-count episodes for show keys shared across stations) — needs a migration adding a `station_id` arg. KPFA/WPFW/KPFT have `rss_base_url`/`mp3_filename_prefix` set (migration 020) but still need `show_keys` rows before ingest pulls anything; WBAI is deferred (its archive uses a different URL format — left NULL, skipped by ingest).
- **No tests** — the three targeted integration tests (RLS isolation, settings fallback, worker claim scoping) require a throwaway Postgres and are still pending.

## Environment

Runs on a VPS behind Traefik reverse proxy at `qir.kpfk.org`. Supabase is hosted (not self-hosted). Redis runs in a sidecar container. The archive server at `archive.kpfk.org` provides RSS feeds and MP3 files.
