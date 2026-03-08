# QIR.KPFK.ORG — Architecture & Feature Overview

*A walkthrough for the team before diving into code.*

---

## 1. What This App Does

KPFK 90.7FM (Pacifica Radio, Los Angeles) must file a **Quarterly Issues Report (QIR)** with the FCC proving it serves its community — documenting which shows covered which issues (education, health, immigration, etc.) with dates, times, durations, and guests.

This app **automates the entire process**: it listens to archived shows via transcription, understands what was discussed via AI summarization, categorizes the content by FCC issue area, and generates the formatted report ready for filing.

It replaced 4 fragile n8n workflows. It costs a few dollars per quarter in AI processing and runs autonomously via cron.

---

## 2. System Architecture

### High-Level Data Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  RSS Ingest  │────▶│ Audio Chunk  │────▶│ Transcribe   │────▶│ Summarize    │────▶│ Compliance   │
│  (hourly)    │     │ (ffmpeg)     │     │ (Groq)       │     │ (OpenAI)     │     │ Check        │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
       │                                                                                    │
       ▼                                                                                    ▼
  archive.kpfk.org                                                                  ┌──────────────┐
  (RSS + MP3s)                                                                      │ QIR Builder  │
                                                                                    │ (manual)     │
                                                                                    └──────────────┘
```

### Episode Status Machine

Every episode has a `status` field that drives the pipeline:

```
pending ──▶ transcribed ──▶ summarized ──▶ compliance_checked
                                                    │
                                              (curated into QIR draft → finalized)

Any stage can fail:
  failed ◀── (retryable, auto-retry every 4h)
  unavailable ◀── (MP3 returned 404, not retryable)
```

### Worker Chaining (Automatic)

Each stage completion triggers the next:
1. **Ingest completes** → queues transcription batch
2. **Transcription completes** → queues summarization batch
3. **Summarization completes** → queues compliance check
4. **QIR generation** → manual only (from dashboard)

### Cron Schedule

| Job | Schedule | Purpose |
|-----|----------|---------|
| Ingest | Every hour at :02 | Fetch new episodes from RSS |
| Auto-retry | Every 4 hours at :17 | Retry failed episodes (≤3 retries) |

### Pipeline Modes

Configurable from the Settings page (polled every 30s by workers):

| Mode | Transcribe concurrency | Summarize concurrency |
|------|----------------------|----------------------|
| **Steady** (default) | 1 | 5 |
| **Catch-up** | 3 | 10 |

---

## 3. Tech Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Frontend** | Next.js 14 (App Router) | Dashboard UI + API routes + public QIR pages |
| **Database** | Supabase (hosted PostgreSQL) | All persistent state, auth |
| **Job Queue** | BullMQ + Redis | Background processing, cron scheduling |
| **Transcription** | Groq API (whisper-large-v3) | Speech-to-text |
| **Summarization** | OpenAI API (gpt-4o-mini) | AI summarization, categorization, curation |
| **Audio Processing** | ffmpeg | Chunk into 15-min M4A segments (mono, 16kHz, 64k AAC) |
| **Styling** | Tailwind CSS | Utility-first, no component library |
| **Deployment** | Docker Compose on VPS | Behind Traefik reverse proxy at qir.kpfk.org |

### Key Dependencies (from package.json)

- `next@14.2.15` — App Router, server components, API routes
- `@supabase/supabase-js` — Database + auth client
- `bullmq` — Redis-backed job queues
- `openai` — OpenAI SDK for summarization
- `fast-xml-parser` — RSS feed parsing
- `concurrently` — Run web + workers in one process
- `tsx` — TypeScript execution for workers

---

## 4. Deployment Architecture

```
┌─────────────────────────────────────────────────┐
│                    VPS                           │
│                                                  │
│  ┌─────────┐    ┌──────────────┐   ┌─────────┐ │
│  │ Traefik │───▶│ qir-app      │   │ qir-    │ │
│  │ (proxy) │    │ :3100→:3000  │   │ worker  │ │
│  │         │    │ Next.js only │   │ BullMQ  │ │
│  │ TLS     │    │ 1 CPU / 1GB  │   │ 1.5CPU  │ │
│  └─────────┘    └──────┬───────┘   │ 2GB     │ │
│                        │           └────┬────┘  │
│                        │                │       │
│                   ┌────▼────────────────▼────┐  │
│                   │  qir-redis (Alpine)      │  │
│                   │  256MB / persistent vol   │  │
│                   └──────────────────────────┘  │
│                                                  │
└──────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   Supabase (hosted)           archive.kpfk.org
   PostgreSQL + Auth           RSS feeds + MP3s
```

- **Web and workers run in separate containers** (same Docker image, different CMD)
- Worker container has a tmpfs volume (`/tmp/qir-audio`) for audio processing
- Redis persists queue state to a Docker volume
- Health check: `GET /api/health` every 30s

---

## 5. Database Schema (Key Tables)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `episode_log` | Core episode tracking | `status`, `show_key`, `air_date`, `headline`, `summary`, `issue_category`, `error_message`, `retry_count` |
| `transcripts` | Full text + captions (1:1 with episode) | `transcript`, `vtt` |
| `show_keys` | Show metadata | `key`, `name`, `category`, `active` |
| `usage_log` | Every API call with cost | `provider`, `model`, `tokens`, `cost`, `episode_id` |
| `qir_settings` | Key-value config | Categories, models, batch sizes, prompts |
| `qir_drafts` | Versioned reports | `status` (draft/final), `curated_entries` (JSON), `version` |
| `transcript_corrections` | Post-transcription find/replace | `pattern`, `replacement`, `is_regex` |
| `compliance_flags` | FCC compliance issues | `flag_type`, `severity`, `excerpt`, `resolved` |

---

## 6. Feature Inventory

### Dashboard (Overview Page)

- **"On Air" status strip** — pulsing red indicator when processing, shows active job stages, manual trigger buttons for each pipeline stage (ingest, transcribe, summarize, compliance)
- **Quarter scoreboard** — 6-cell grid showing episode counts by status, clickable to filter episodes list, progress bar showing pipeline completion percentage
- **QIR readiness card** — color-coded (green/amber/red) showing how many of the 8 FCC categories are covered vs. missing
- **Time estimates** — projected time to clear the pipeline based on historical averages
- **Broadcast log** — chronological 24-hour activity feed, each row links to episode detail
- **Attention needed** — failed episodes requiring intervention
- **Compliance summary** — unresolved compliance flags grouped by type (profanity, missing station ID, payola/plugola, etc.)
- **Coverage gaps** — active shows with no summarized episodes this quarter
- **Monthly cost strip** — current month spend (Groq + OpenAI), per-episode average
- **Issue categories chart** — horizontal bar chart of FCC categories with episode counts
- **Recent episodes** — latest episodes with status badges
- **System health footer** — worker status, staleness indicators for last ingest/transcribe/summarize

### Episodes List Page

- **Filterable data table** — status, quarter, show name (text search), category
- **Sortable columns** — show name, air date, status (with sort direction indicators)
- **Pagination** — 50 per page, previous/next controls
- **Bulk actions** — "Retry Failed" button, "Export CSV" button
- **Keyboard shortcuts** — `j`/`k` row navigation, `Enter` to open, `/` to focus search, `r` for bulk retry
- **URL-driven state** — filters/sort/page persisted in URL params (shareable, bookmarkable)

### Episode Detail Page

- **Breadcrumb navigation** — back link + episode title + status badge
- **Error display** — red banner when episode has failed, shows error message and retry count
- **Compliance report** — amber banner for discrepancy notes
- **Metadata grid** — 8-cell grid (air date, time, duration, show key, category, host, guest, created)
- **Action buttons** — Retry, Re-Transcribe, Re-Summarize, Download MP3/Transcript/VTT
- **Confirmation dialogs** — destructive actions (re-transcribe, re-summarize) require confirmation before execution
- **Summary & category editor** — inline textarea for summary, dropdown for FCC issue category, save button
- **Compliance flags section** — per-flag cards with severity badges, resolve/unresolve workflow with notes field, toggle to show/hide resolved flags
- **Audio player with captions** — lazy-loaded, synced with VTT captions
- **Transcript viewer** — lazy-loaded, full transcript display

### QIR Builder (Generate Page)

- **Quarter selector** — dropdown for target quarter
- **Generate button** — triggers AI curation of summarized episodes into QIR entries
- **Pre-finalization validation checklist** — 6 automated checks:
  - Entry count (20+ recommended)
  - Category coverage (all 8 FCC categories)
  - Show variety (8+ shows)
  - Date distribution (spans full quarter)
  - Complete entries (all have summary, host, headline)
  - Compliance flags (no unresolved critical flags)
- **Pass/warn/fail indicators** — color-coded with icons
- **Draft management** — view by version, switch between curated and full report views
- **Inline entry editing** — edit individual entry summaries within the draft
- **Remove entries** — delete entries from the curated list
- **Finalize/unfinalize** — lock a draft as the official QIR (with confirmation dialog)
- **Export** — CSV and plain text export of the finalized report

### Jobs Page

- Queue status monitoring for all pipeline stages

### Activity Page

- Full activity log across all episodes

### Usage Page

- Cost tracking with date range filtering
- Breakdown by provider (Groq vs OpenAI)

### Downloads Page

- Batch export hub: transcripts, VTTs, episode CSV

### Settings Page

- **App configuration** — all settings stored in database, editable without redeploy
- **Transcript corrections CRUD** — manage find/replace rules (plain text and regex) applied after Groq returns transcriptions
- **Pipeline mode** — switch between steady and catch-up modes

### Public QIR Pages

- **`/[year]/q[quarter]/`** — Server-rendered, print-friendly finalized QIR
- **`/login`** — Supabase email/password auth

---

## 7. UI/UX Design System

### Layout

- **Fixed sidebar** on desktop (256px / `w-56`), dark (`bg-gray-900`) with light text
- **Mobile-responsive**: sidebar slides in from left with hamburger toggle + backdrop overlay
- Sidebar auto-closes on route change
- **Main content** area scrolls independently, padded `p-6`, max width `1400px` on dashboard

### Brand Colors (Tailwind Custom)

| Token | Hex | Usage |
|-------|-----|-------|
| `kpfk-red` | `#C41E3A` | Primary accent, progress bars, links, "On Air" indicator |
| `kpfk-black` | `#1a1a1a` | Headings, primary text |
| `kpfk-gold` | `#D4A843` | Processing state borders |
| `kpfk-cream` | `#FAF8F5` | Processing state backgrounds, row hover states |

### Color Palette (Status System)

| Status | Badge Color | Semantic |
|--------|------------|----------|
| Pending | `amber-100/800` | Awaiting processing |
| Transcribed | `blue-100/800` | Audio converted to text |
| Summarized | `emerald-100/800` | AI summary complete |
| Compliance Checked | `emerald-100/800` | FCC compliance verified |
| Failed | `red-100/800` | Error, needs attention |
| Unavailable | `gray-100/600` | MP3 not found (404) |

### Component Patterns

- **Cards** — `bg-white rounded-xl shadow-sm border` (dashboard widgets)
- **Badges/pills** — `text-xs px-2 py-0.5 rounded-full` with semantic colors
- **Buttons (primary)** — `bg-kpfk-black text-white hover:bg-gray-700` or `bg-gray-900`
- **Buttons (destructive)** — `bg-red-600 text-white hover:bg-red-700`
- **Buttons (secondary)** — `bg-gray-200 text-gray-700 hover:bg-gray-300`
- **Tables** — `bg-white rounded-lg shadow overflow-x-auto`, gray header row, divide-y rows
- **Inputs/selects** — `border rounded px-2 py-1.5 text-sm`
- **Section headings** — `text-xs font-semibold text-gray-400 uppercase tracking-wide` (all caps, small, muted)

### Shared Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `Skeleton` variants | `components/skeleton.tsx` | Cards, table rows, blocks — animate-pulse loading placeholders |
| `ErrorBoundary` | `components/error-boundary.tsx` | React error boundary with retry button, wraps all dashboard content |
| `EmptyState` | `components/empty-state.tsx` | Centered empty state with optional CTA button |
| `ToastProvider` | `components/toast.tsx` | Context-based toast notifications (success/error), 5-second auto-dismiss, stacked bottom-right |
| `ConfirmDialog` | `components/confirm-dialog.tsx` | Modal confirmation for destructive actions |
| `Breadcrumbs` | `components/breadcrumbs.tsx` | Navigation breadcrumbs for detail pages |
| `FullReportView` / `CuratedEntriesView` | `components/qir-report-view.tsx` | Lazy-loaded report renderers |
| `AudioPlayerWithCaptions` / `TranscriptViewer` | `components/episode-media.tsx` | Lazy-loaded media components |

---

## 8. Interaction Design

### Navigation

- Sidebar navigation with 8 items: Overview, Episodes, Jobs, Activity, Usage, Generate QIR, Downloads, Settings
- Active route highlighted (`bg-gray-700 text-white font-medium`)
- Hover state on inactive items (`hover:bg-gray-800 hover:text-white`)
- Mobile: hamburger menu toggles sidebar slide-in; backdrop click or route change closes it

### Data Loading

- **Skeleton states** throughout: pulsing placeholder cards, table rows, and blocks while data loads
- **Auto-refresh**: dashboard polls every 15 seconds for live updates
- **Lazy loading**: heavy components (audio player, transcript viewer, report views) loaded via `next/dynamic` with skeleton fallbacks

### Feedback & Notifications

- **Toast system**: success (green) and error (red) toasts slide in at bottom-right, auto-dismiss after 5 seconds, manually dismissible
- **Inline loading states**: buttons show spinners and disable during async actions (e.g., "Retrying...", "Generating...", "Saving...")
- **Action loading gates**: while one action is in progress, all other action buttons are disabled to prevent conflicts

### Destructive Action Protection

- **Confirmation dialogs** for: re-transcribe (overwrites transcript), re-summarize (overwrites summary), finalize QIR (locks the report), bulk retry
- **Browser confirm** for: bulk retry all failed episodes

### Keyboard-Driven Workflows (Episodes Page)

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate rows up/down (selected row highlighted with blue ring) |
| `Enter` | Open selected episode detail |
| `/` | Focus the show name search input |
| `r` | Trigger bulk retry of failed episodes |

### URL State Management

- Episodes page persists all filter/sort/pagination state in URL query params
- Changing any filter resets to page 1
- URLs are shareable and bookmarkable (e.g., `/dashboard/episodes?status=failed&quarter=2026-Q1`)

### Inline Editing

- Episode detail: summary text is an always-visible textarea, category is a dropdown — edit and save in place
- QIR builder: individual entry summaries are editable inline within the draft
- Compliance flags: resolve/unresolve with notes field that expands per-flag

### Visual Status Communication

- **"On Air" strip**: pulsing red dot animation when workers are actively processing, green dot when idle
- **Staleness indicators**: system health footer color-codes last activity times — green (<2h), amber (2-8h), red (>8h)
- **QIR readiness**: entire card changes color based on category coverage — green (5+), amber (3-4), red (<3)
- **Validation checklist**: pass (green check), warn (amber exclamation), fail (red X) with detail text

### Dashboard Clickthrough

- Status count cells link to pre-filtered episodes list (e.g., clicking "5 Failed" opens `/dashboard/episodes?status=failed&quarter=...`)
- Compliance flag pills link to compliance-filtered episode list
- Activity feed rows link to episode detail
- Recent episodes rows link to episode detail
- "View all" and "Details" links for cross-page navigation

### Export & Download

- CSV export from episodes table (respects current filters)
- Transcript/VTT download from episode detail (client-side blob download)
- QIR export as CSV or plain text
- Batch downloads page for bulk export

---

## 9. API Design

All API routes live under `/app/api/`. Patterns:

- **RESTful**: GET for reads, POST for creates/actions, PATCH for updates, DELETE for removes
- **Consistent response shape**: `{ episodes: [...], total: N }`, `{ episode: {...}, transcript: {...} }`, `{ drafts: [...] }`
- **Single dashboard endpoint**: `GET /api/dashboard` aggregates all overview data in one call (avoids waterfall)
- **Pagination**: `?page=N&limit=N` on list endpoints
- **Filtering**: query params (`?status=failed&quarter=2026-Q1&show=...`)
- **CSV export**: `?format=csv` returns CSV instead of JSON
- **Manual job triggers**: `POST /api/jobs` with `{ action: "ingest" | "transcribe" | "summarize" | "compliance" }`
- **Health check**: `GET /api/health` — used by Docker healthcheck

---

## 10. Cost Model

- Every Groq and OpenAI API call is logged to `usage_log` with estimated cost
- Groq: billed per audio-second
- OpenAI: billed per token (input + output)
- Dashboard shows: monthly total, per-provider breakdown, per-episode average
- Usage page offers date-range filtering and detailed breakdown

---

## 11. Auth

- Supabase email/password authentication
- Session checked on dashboard layout mount; redirects to `/login` if unauthenticated
- Auth state listener handles sign-out across tabs
- Login page is a standalone form at `/login`
- User email displayed in sidebar footer with sign-out button

---

## 12. Known Limitations & Future Work

See `IMPROVEMENTS.md` for the full prioritized list. Key items:

- **No test suite** — the project has zero tests
- **Missing DB indexes** — query performance not optimized
- **No OpenAI retry logic** — API failures aren't retried at the application level
- **No BullMQ job timeouts** — hung jobs can block the pipeline
- **N+1 queries** in some dashboard aggregations
- Docker resource limits are set but not load-tested
