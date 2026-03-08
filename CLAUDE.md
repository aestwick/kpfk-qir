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
```

**Key tables:**
- `episode_log` — Core episode data + processing status + AI outputs
- `transcripts` — Full transcript text + VTT captions (1:1 with episode)
- `show_keys` — Show metadata (key, name, category, active)
- `usage_log` — Every API call logged with cost
- `qir_settings` — Key-value config (categories, models, batch sizes, prompts)
- `qir_drafts` — Versioned QIR reports (draft/final status)
- `transcript_corrections` — Find-and-replace rules applied post-transcription

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

**Auth is currently bypassed** for testing (`dashboard/layout.tsx` lines 34–38). Remove the early return to re-enable Supabase auth.

**Transcript corrections** are applied as post-processing after Groq returns text. They support plain text and regex patterns. Managed from the Settings page.

**Cost tracking** is automatic. Every Groq and OpenAI API call is logged to `usage_log` with estimated cost.

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
- **P1 (next sprint):** Separate workers from web server, Docker resource limits, enable auth, fix N+1 queries
- **Auth is bypassed** — re-enable before production use
- **No tests** — the project has no test suite yet

## Environment

Runs on a VPS behind Traefik reverse proxy at `qir.kpfk.org`. Supabase is hosted (not self-hosted). Redis runs in a sidecar container. The archive server at `archive.kpfk.org` provides RSS feeds and MP3 files.
