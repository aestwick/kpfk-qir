# QIR.KPFK.ORG

Automated FCC Quarterly Issues Report generator for KPFK 90.7FM (Pacifica Radio, Los Angeles).

Ingests episodes from the KPFK archive, transcribes audio with Groq Whisper, summarizes with GPT-4o-mini, and generates formatted QIR documents ready for FCC filing.

## Stack

- **Next.js 14** (App Router) — dashboard + public QIR pages + API
- **Supabase** (Postgres + Auth) — database and authentication
- **BullMQ + Redis** — background job queue
- **Groq API** (whisper-large-v3) — audio transcription
- **OpenAI API** (gpt-4o-mini) — AI summarization and curation
- **Docker Compose** — production deployment

## Quick Start

### Prerequisites

- Node.js 20+
- Redis (or Docker)
- ffmpeg
- Supabase project with tables created (see `supabase/migrations/`)

### Setup

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Fill in your Supabase, Groq, and OpenAI keys

# Run database migration against your Supabase project
# Execute supabase/migrations/001_usage_settings_drafts.sql in the Supabase SQL editor

# Start development
npm run dev          # Next.js dev server
npm run workers      # Background workers (separate terminal)
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `GROQ_API_KEY` | Groq API key for Whisper transcription |
| `OPENAI_API_KEY` | OpenAI API key for GPT-4o-mini |
| `REDIS_URL` | Redis connection URL (default: `redis://qir-redis:6379`) |
| `NEXT_PUBLIC_APP_URL` | Public URL of the application |

## Docker Deployment

```bash
# Build and start
docker compose up -d --build

# View logs
docker compose logs -f qir-app

# Stop
docker compose down
```

The app runs on port **3100** (mapped from container port 3000). Set up a reverse proxy (nginx/Caddy) to serve `qir.kpfk.org` from `localhost:3100`.

## Architecture

### Pipeline

```
Ingest (RSS) → Transcribe (Groq) → Summarize (OpenAI) → Generate QIR
```

- **Ingest**: Hourly cron (minute :02) fetches RSS feeds, dedupes episodes
- **Transcribe**: Chunks audio with ffmpeg, transcribes via Groq Whisper, applies corrections
- **Summarize**: Sends transcripts to GPT-4o-mini, parses structured JSON output
- **Generate QIR**: Groups by issue category, AI-curates top entries per category

### Pages

- `/dashboard` — Protected dashboard (auth required)
  - Overview, Episodes, Jobs, Usage, Generate QIR, Downloads, Settings
- `/login` — Supabase email/password login
- `/[year]/q[quarter]` — Public finalized QIR (e.g., `/2026/q1`)
- `/api/health` — Health check endpoint

### Workers

Background workers run alongside Next.js via `concurrently`. The hourly ingest cron triggers downstream transcription and summarization automatically. Only current-quarter episodes are auto-processed; older episodes can be triggered manually from the dashboard.

## Authentication

Uses Supabase Auth with email/password. User accounts are created manually in the Supabase dashboard — there is no signup page. Only 2-3 staff users need access.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Next.js development server |
| `npm run build` | Production build |
| `npm run start` | Start Next.js production server |
| `npm run workers` | Start background workers |
| `npm run start:all` | Start both Next.js and workers (production) |
