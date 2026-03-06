# QIR.KPFK.ORG — Project Specification

## What This Is

A Next.js application that replaces 4 fragile n8n workflows at KPFK 90.7FM (Pacifica Radio, Los Angeles). It automates the production of the station's **FCC Quarterly Issues Report (QIR)** — a mandatory filing that documents how the station's programming serves the public interest.

The system ingests episodes from the archive, transcribes them, summarizes them with AI, and generates a formatted QIR document ready for FCC filing.

---

## Context

**KPFK** is a noncommercial community radio station. The FCC requires every station to file a Quarterly Issues Report listing its most significant public affairs programming, grouped by community issue. Each entry needs: issue category, show name, description, air date, time, duration, and notable guests.

Currently this is done with 4 separate n8n workflows that keep breaking due to node reference errors, Google Drive auth issues, race conditions, and credential problems. The station has ~1,400 episodes in its database already.

**The person building this** is the assistant GM (GM in training). They are technical but want Claude Code to do the actual implementation. They will review and deploy.

---

## Architecture

### Stack
- **Next.js 14** (App Router) — dashboard + public QIR pages + API routes
- **Supabase** (Postgres + Auth) — existing project `czjhwhfqohpmwprhasve`
- **BullMQ + Redis** — job queue for background processing
- **ffmpeg** — audio chunking (installed in Docker container)
- **Groq API** (whisper-large-v3) — audio transcription
- **OpenAI API** (gpt-4o-mini) — summarization + curation
- **Docker Compose** — runs alongside existing n8n container on VPS

### Deployment
- Docker Compose on existing VPS
- Two containers: `qir-app` (Next.js + workers) and `qir-redis`
- App on port 3100, reverse proxied to qir.kpfk.org
- 2-3 staff users authenticated via Supabase Auth (email/password)

---

## Existing Database Schema

Supabase project: `czjhwhfqohpmwprhasve`

These tables already exist with data:

### episode_log (1,423 rows)
```sql
create table public.episode_log (
  id serial primary key,
  show_key text not null,
  show_name text null,
  category text null,              -- from show_keys, e.g. "Public Affairs - Local"
  date text null,                  -- "Thursday, December 25, 2025"
  start_time text null,            -- "8:00 AM"
  end_time text null,              -- "9:00 AM"
  duration integer null,           -- minutes
  mp3_url text not null unique,
  status text default 'pending',   -- pending | transcribed | summarized | failed | unavailable
  headline text null,
  host text null,
  guest text null,
  summary text null,
  transcript_url text null,        -- legacy Google Drive URL, being phased out
  compliance_status text null,
  compliance_report text null,
  air_date date null,
  air_start time null,
  air_end time null,
  issue_category text null,        -- FCC category assigned by AI
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
-- Indexes on: status, mp3_url, show_key
```

### show_keys
```sql
create table public.show_keys (
  id serial primary key,
  key text not null unique,        -- e.g. "alterradioar"
  show_name text not null,         -- e.g. "Alternative Radio"
  category text null,              -- e.g. "Public Affairs - Local"
  active boolean default true,
  email text null,
  created_at timestamptz default now(),
  updated_at timestamptz null
);
```

### transcripts (empty — was using Google Drive, now storing here)
```sql
create table public.transcripts (
  id serial primary key,
  episode_id integer not null unique references episode_log(id) on delete cascade,
  transcript text null,
  vtt text null,
  created_at timestamptz default now()
);
```

### Other existing tables (for context, don't modify)
- `contacts` — unused
- `show_contacts` — unused
- `show_page_generations` — show page content
- `show_pages_current` — current show pages
- `show_tags` — show-tag associations
- `tags` — tag definitions with slugs and categories

---

## New Tables to Create

### usage_log
Track API costs for the dashboard billing view.
```sql
create table public.usage_log (
  id serial primary key,
  episode_id integer references episode_log(id) on delete set null,
  service text not null,          -- 'groq' | 'openai'
  model text not null,            -- 'whisper-large-v3' | 'gpt-4o-mini'
  operation text not null,        -- 'transcribe' | 'summarize' | 'curate'
  input_tokens integer default 0,
  output_tokens integer default 0,
  duration_seconds numeric,       -- for audio transcription
  estimated_cost numeric(10, 6),
  metadata jsonb default '{}',
  created_at timestamptz default now()
);
```

### qir_settings
Key-value config for report generation.
```sql
create table public.qir_settings (
  id serial primary key,
  key text unique not null,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- Default values:
-- station_id: "KPFK, Los Angeles"
-- max_entries_per_category: 12
-- issue_categories: ["Civil Rights / Social Justice", "Immigration", "Economy / Labor", "Environment / Climate", "Government / Politics", "Health", "International Affairs / War & Peace", "Arts & Culture"]
-- excluded_categories: ["Music", "Español"]
-- summarization_model: "gpt-4o-mini"
-- transcription_model: "whisper-large-v3"
```

### Alter episode_log
```sql
alter table public.episode_log
  add column if not exists error_message text,
  add column if not exists retry_count integer default 0;
```

### qir_drafts
Stores generated QIR drafts with edit history.
```sql
create table public.qir_drafts (
  id serial primary key,
  year integer not null,
  quarter integer not null,           -- 1-4
  status text default 'draft',        -- draft | final
  curated_entries jsonb not null,      -- array of episode IDs + any manual edits
  settings_snapshot jsonb,             -- settings used for this generation
  full_text text,                      -- rendered full report text
  curated_text text,                   -- rendered curated report text
  version integer default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index idx_qir_draft_active on public.qir_drafts(year, quarter) where status = 'final';
```

### transcript_corrections
Custom dictionary for fixing recurring transcription errors. Applied as a post-processing pass after every Groq transcription. Manageable entirely from the dashboard settings page — no code changes needed.
```sql
create table public.transcript_corrections (
  id serial primary key,
  wrong text not null,                -- what Whisper outputs, e.g. "Suzy Weissman", "Kay PFK"
  correct text not null,              -- what it should be, e.g. "Suzi Weissman", "KPFK"
  case_sensitive boolean default false,
  is_regex boolean default false,     -- for advanced patterns
  active boolean default true,
  notes text,                         -- optional context, e.g. "host of Beneath The Surface"
  created_at timestamptz default now()
);
```

**How it works:**
- After Groq returns a transcript, before storing it, run all active corrections as find-and-replace
- Case-insensitive by default (catches "kpfk", "Kpfk", "KPFK" variants)
- Optional regex mode for advanced patterns (e.g. catching multiple misspellings)
- Same corrections applied to VTT caption text
- Dashboard shows a table where staff can add/edit/remove/toggle entries
- Common entries to seed: show names, host names, KPFK, Pacifica, Los Angeles neighborhood names, frequent guest names, Spanish words that appear in bilingual programming

---

## Episode Lifecycle

```
pending → transcribed → summarized → (selected for QIR)
              ↘ failed (retryable)
              ↘ unavailable (404 MP3, skip permanently)
```

---

## The Four Pipeline Steps

### 1. Ingest (replaces n8n "Show Schedule Scraper" flow)

**Trigger:** Hourly cron (minute :02) + manual button in dashboard.

**Logic:**
1. Fetch all active shows from `show_keys` where `category != 'Music'`
2. For each show, fetch RSS from `https://archive.kpfk.org/getrss.php?id={key}`
3. Parse `<item>` elements: extract title, enclosure URL (mp3_url), pubDate, itunes:duration
4. Dedupe against existing `episode_log.mp3_url`
5. Insert new episodes with status `pending`
6. All dates/times formatted in Pacific timezone

**RSS format notes:**
- Title is in CDATA: `<title><![CDATA[ Show Title ]]></title>`
- MP3 URL in enclosure: `<enclosure url="https://..." />`
- Duration in seconds: `<itunes:duration>3420</itunes:duration>`
- Date: `<pubDate>Thu, 25 Dec 2025 16:00:00 +0000</pubDate>` (UTC, convert to Pacific)

### 2. Transcribe (replaces n8n "KPFK Transcription Bot" flow)

**Trigger:** Runs after ingest finds new episodes, or manual trigger from dashboard.

**Logic:**
1. Get episodes where `status = 'pending'` (excluding Music, Español), limit configurable (default 5)
2. For each episode:
   a. Run ffmpeg to chunk the MP3 into 15-minute M4A segments:
      `ffmpeg -i {mp3_url} -f segment -segment_time 900 -reset_timestamps 1 -vn -ac 1 -ar 16000 -c:a aac -b:a 64k chunk_%03d.m4a`
      **Groq file size limit: 25MB per upload.** At these ffmpeg settings (mono, 16kHz, 64k AAC), 15-minute chunks are typically ~8MB — well under the limit. But after chunking, verify each file is under 25MB. If any chunk exceeds 25MB (e.g. unusually long segment or high-bitrate source), re-chunk that file with a shorter segment time.
   b. If ffmpeg gets a 404 or "Server returned" error → mark `unavailable`, skip
   c. For each chunk, call Groq Whisper API:
      - Endpoint: `POST https://api.groq.com/openai/v1/audio/transcriptions`
      - Auth: `Authorization: Bearer {GROQ_API_KEY}`
      - Body: multipart form with `file`, `model=whisper-large-v3`, `response_format=verbose_json`
   d. Stitch all chunk texts into one transcript
   e. **Apply transcript corrections:** load all active rows from `transcript_corrections` table, run find-and-replace on the stitched transcript (case-insensitive unless flagged otherwise, regex if flagged)
   f. Build VTT captions from segment timestamps (offset each chunk by `chunk_index * 900` seconds), applying the same corrections to caption text
   g. Store corrected transcript + VTT in `transcripts` table
   h. Update `episode_log.status = 'transcribed'`
   i. Log usage (duration in seconds) to `usage_log`
   j. Clean up temp audio files

**Error handling:** On failure, set `status = 'failed'`, store error_message, increment retry_count. Retryable from dashboard.

### 3. Summarize (replaces n8n "Summary Generator" flow)

**Trigger:** Runs after transcription batch, or manual trigger.

**Logic:**
1. Get episodes where `status = 'transcribed'` (excluding Music, Español), limit configurable (default 10)
2. For each episode:
   a. Load transcript from `transcripts` table
   b. Send to OpenAI gpt-4o-mini with the system prompt below
   c. Parse JSON response
   d. Update `episode_log` with: headline, summary, host, guest, issue_category, `status = 'summarized'`
   e. Log token usage to `usage_log`

**System prompt (use this exactly):**

```
You are an expert public radio producer for KPFK.
Your task is to produce an internal archival log of a radio broadcast based on a transcript, and to flag any clear conflicts with provided metadata.
This is NOT a program description or promotional summary.
INPUTS:
- Episode metadata (may include show title, air date/time, listed host(s), listed guest(s))
- A transcript of the broadcast
GENERAL RULES:
- Be concise, neutral, and factual.
- Do NOT add opinions, analysis, praise, criticism, political framing, or moral judgment.
- Do NOT explain why topics matter.
- Do NOT describe significance, impact, importance, implications, or future outcomes.
- Do NOT narrate structure, flow, or progression.
- Never invent names, roles, relationships, motivations, or conclusions.
- If something is unclear or not explicitly stated, leave it blank.
LANGUAGE RULES:
- Do NOT use: "In this episode", "This episode", "The show", "The program", "This broadcast".
- Do NOT describe beginnings, endings, transitions, or conclusions.
- Do NOT use verbs such as: "highlights", "emphasizes", "underscores", "examines", "explores", "addresses", "reflects", "focuses on", "concludes", "reviews".
- Use only neutral, descriptive verbs such as: "discusses", "describes", "outlines", "explains", "states", "argues".
- Prefer speaker-led or topic-led sentences.
- When a claim or opinion appears, attribute it to the speaker.
DISCREPANCY RULE:
- Compare metadata with what is explicitly stated in the transcript.
- If there is a clear conflict, write a short factual note in "discrepancy".
- Do NOT guess, infer, resolve, or explain conflicts.
- If there is no clear conflict, leave "discrepancy" blank.
CONTENT REQUIREMENTS:
HEADLINE: One short declarative sentence listing main subjects. No dates, adjectives, or conclusions.
SUMMARY: 4-8 sentences. Each states a topic or speaker statement. No structure descriptions. Under 900 characters.
HOST: Name(s) only if explicitly stated in transcript. Comma-separated if multiple. Blank if unclear.
GUEST: Name(s) only if explicitly introduced. Comma-separated if multiple. Blank if none/unclear.
ISSUE_CATEGORY: One of: Civil Rights / Social Justice, Immigration, Economy / Labor, Environment / Climate, Government / Politics, Health, International Affairs / War & Peace, Arts & Culture.
OUTPUT: Return ONLY valid JSON. No markdown, no extra text.
{"headline":"string","summary":"string","host":"string","guest":"string","discrepancy":"string","issue_category":"string"}
```

**User message format:**
```
Show: {show_name}
Host(s): {host or ""}
Guest(s): {guest or ""}
Transcript:
{transcript text}
```

### 4. Generate QIR (replaces n8n "QIR Builder" flow)

**Trigger:** Manual from dashboard — "Generate Q{n} {year} Report" button.

**Logic:**
1. Get all `summarized` episodes within the quarter date range
2. Group by `issue_category`
3. Format each category with all entries for review (the "full" report)
4. Send grouped entries to GPT-4o-mini for curation — pick up to N (configurable, default 12) per category that best demonstrate community service. Prompt should prioritize:
   - Variety of shows (don't pick 12 from the same show)
   - Substantive content (clear topics, identified guests)
   - Range of dates across the quarter
   - EXCLUDE: pledge drives, promotions, entertainment without community issue connection
5. Format the curated report with FCC-required elements:
   - Issue category header
   - Show name + host
   - Air date, time, duration
   - Headline
   - Guest(s)
   - Summary/description
6. Output both full and curated versions

**Draft/Finalize Workflow:**
- QIR generation creates a **draft** (stored in a `qir_drafts` table with status `draft`)
- User reviews the curated report in the dashboard — can remove entries, edit summaries, change categories, reorder
- User can **re-run curation** with different settings (e.g. change max per category, tweak the curation prompt) without losing manual edits — re-run creates a new draft version
- "Finalize" button locks the draft → status `final`, makes it visible on the public page
- A finalized QIR can be un-finalized and re-edited if needed
- Final output available as: printable web page (Cmd+P → PDF), and DOCX export

---

## Application Pages

### Dashboard (protected, requires auth)

**`/dashboard`** — Overview
- Status counts: pending / transcribed / summarized / failed / unavailable
- Recent activity (last 10 processed episodes)
- Quick action buttons: Run Ingest, Run Transcribe Batch, Run Summarize Batch
- Current quarter progress bar

**`/dashboard/episodes`** — Episode Queue
- Paginated table of all episodes
- Filter by: status, quarter, show, category
- Sortable columns
- Bulk actions: retry all failed, export filtered results to CSV
- Click episode → detail view with:
  - All metadata
  - Transcript viewer (full text, scrollable, searchable)
  - VTT player (play MP3 audio with synced captions from VTT data)
  - Summary (editable inline)
  - Issue category (reassignable via dropdown)
  - Discrepancy notes (if the AI flagged any metadata conflicts, show them prominently)
  - Status (retryable if failed)
  - "Re-transcribe" and "Re-summarize" buttons
  - Download buttons: transcript (.txt), VTT (.vtt), MP3 (link to archive)

**`/dashboard/jobs`** — Job Queue Management
- Live view of all three queues: ingest, transcribe, summarize
- Per queue: active / waiting / completed / failed counts
- Recent job history with timestamps, duration, and results
- Cron schedule status: running/paused, next scheduled run time
- Pause/resume cron button
- Configurable batch sizes: how many episodes to transcribe or summarize per run (stored in `qir_settings`)
- Manual trigger buttons per queue with batch size override
- Failed job details with error messages, retry individual or retry all

**`/dashboard/usage`** — API Usage & Costs
- Date range picker (default: current month)
- Total cost, broken down by service (Groq / OpenAI)
- Cost per operation (transcribe / summarize / curate)
- Episode count processed
- Simple bar chart or table showing daily/weekly spend

**`/dashboard/settings`** — Configuration
- **QIR Settings** (from `qir_settings` table):
  - Station identification text
  - Max entries per category
  - Issue category list (add/remove/rename)
  - Excluded show categories
  - AI model selection
  - Curation prompt (editable textarea)
  - Summarization prompt (editable textarea)
  - Default batch sizes for transcription and summarization
- **Transcript Corrections** (from `transcript_corrections` table):
  - Searchable table of all correction rules
  - Add new: wrong text, correct text, case-sensitive toggle, regex toggle, notes
  - Edit/delete existing entries
  - Toggle active/inactive without deleting
  - Bulk import from CSV (for seeding a big list)
  - "Test" button: paste sample text, see corrections applied in preview
  - Seed suggestions: prompt user to add show names, host names, station identifiers, neighborhood names

**`/dashboard/generate`** — QIR Builder
- Quarter selector (dropdown: Q1 2025, Q2 2025, etc.)
- "Generate" button → shows progress
- Draft history: list of previous drafts/versions for this quarter
- Two-column view: full report on left, curated report on right
- Editable curated side: remove entries, edit summaries, change categories, reorder
- "Re-run Curation" button: re-runs the AI selection with current settings, creates a new draft version (does NOT destroy manual edits on previous version)
- Settings override panel: temporarily adjust max per category, curation prompt for this run
- "Finalize" button → locks the curated version, publishes to public page
- "Un-finalize" button → unlocks for further editing
- Export options:
  - Print / Download PDF (via browser print with clean print CSS)
  - Export to DOCX
  - Export to CSV (spreadsheet-friendly format)

**`/dashboard/downloads`** — Batch Downloads
- Download all transcripts for a quarter (zip of .txt files)
- Download all VTTs for a quarter (zip of .vtt files)
- Download curated or full QIR as DOCX
- Export episode data for a quarter as CSV/spreadsheet

### Public QIR Pages (no auth)

**`/[year]/q[quarter]`** — e.g. `/2025/q2`
- Renders the finalized curated QIR (from `qir_drafts` where status = 'final')
- Clean, professional layout matching FCC expectations
- Grouped by issue category
- Each entry shows: show name, date, time, duration, headline, guests, description
- Print stylesheet for clean PDF output (Cmd+P → filing-ready PDF)
- Header: "KPFK, Los Angeles - Quarterly Issues Report / April 1, 2025 thru June 30, 2025"
- Footer: "Note: This list is by no means exhaustive."
- Returns 404 if no finalized QIR exists for that quarter

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=https://czjhwhfqohpmwprhasve.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
GROQ_API_KEY=
OPENAI_API_KEY=
REDIS_URL=redis://qir-redis:6379
NEXT_PUBLIC_APP_URL=https://qir.kpfk.org
```

---

## Docker Setup

```yaml
# docker-compose.yml
version: "3.8"
services:
  qir-app:
    build: .
    container_name: qir-app
    restart: unless-stopped
    ports:
      - "3100:3000"
    env_file: .env
    depends_on:
      - qir-redis
    volumes:
      - qir-tmp:/tmp/qir-audio

  qir-redis:
    image: redis:7-alpine
    container_name: qir-redis
    restart: unless-stopped
    volumes:
      - redis-data:/data

volumes:
  qir-tmp:
  redis-data:
```

```dockerfile
# Dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "start:all"]
# start:all runs Next.js server + background workers concurrently
```

---

## Important Operational Notes

### Backlog Handling
There are ~1,400 existing episodes in `episode_log`, most with status `pending`. The pipeline should **only auto-process episodes from the current quarter** by default. The automatic transcription and summarization jobs should filter by `air_date` within the current quarter bounds. Older episodes can still be manually triggered from the dashboard (single episode or filtered batch), but the cron-driven pipeline ignores them.

### Authentication
Supabase Auth with email/password. No signup page — accounts are created manually by the admin in the Supabase dashboard. The app only needs a login page and an auth guard on `/dashboard/*`. Public QIR pages (`/[year]/q[quarter]`) require no auth.

### Groq Rate Limits
Groq is on a paid plan, but the transcription worker should still implement exponential backoff on 429 responses. Between chunk transcriptions, add a small delay (1-2 seconds) to stay well within rate limits. Log rate limit hits to `usage_log` metadata so they're visible in the dashboard.

### Legacy Google Drive References
Some existing episodes have `transcript_url` pointing to Google Drive. The new pipeline ignores this column — all new transcripts go into the `transcripts` table. Don't delete or migrate the old URLs; they can stay for historical reference. The dashboard episode detail page should show the Drive link if it exists, alongside the new transcript viewer.

---

## Key Design Decisions

1. **Transcripts in Supabase, not Google Drive** — eliminates OAuth headaches. A transcript is ~30-50KB text; even 500 episodes is trivial.

2. **BullMQ for job scheduling** — gives retry logic, concurrency control, and job visibility. The hourly ingest cron runs inside the app via BullMQ's repeating jobs (minute :02 of every hour). No external cron needed — if the container is running, the schedule is running. Transcription runs 1 at a time (ffmpeg is heavy). Summarization can run with higher concurrency.

3. **Workers run in the same container** — simpler than a separate worker container. `concurrently` runs Next.js + worker process side by side.

4. **Print-to-PDF for the public QIR page** — CSS `@media print` gives a clean filing-ready PDF via Cmd+P. DOCX export uses a library (docx-js or similar) for when staff need an editable Word document.

5. **Curation is AI-assisted but human-finalized** — GPT picks the best entries, but the dashboard lets staff edit, re-run with different settings, and finalize only when satisfied. Draft versioning means you never lose work.

6. **Usage tracking from day one** — every API call logs cost. No surprises when the Groq or OpenAI bill arrives.

7. **Discrepancy surfacing** — when the AI summarizer detects conflicts between metadata and transcript content (e.g. listed host doesn't match who's actually speaking), those notes are stored and displayed prominently on the episode detail page. This helps catch data quality issues early.

8. **Bulk operations** — failed episodes can be retried in bulk. Transcripts, VTTs, and QIR documents can be batch-downloaded as zips per quarter. Episode data is exportable to CSV for spreadsheet workflows.

---

## FCC QIR Requirements Reference

Per Garvey Schubert Barer (communications law firm) guidance and FCC rules:

- Each quarterly list must be placed in the local public file by the 10th of the month following quarter end (April 10, July 10, October 10, January 10)
- Should cover 5-10 community issues minimum
- Each entry must contain: issue addressed, program title, brief narrative description, air date(s), air time(s), duration
- Should include names/titles of notable guests
- "Local" programming counts heavily
- Programs should not be scheduled exclusively at low-audience times
- Define issues broadly (e.g. "education" not "third grade reading levels")
- The list should document the "best" or "most significant" programming

---

## File Structure

```
qir-kpfk/
├── app/
│   ├── layout.tsx
│   ├── globals.css
│   ├── page.tsx                      # Redirect to /dashboard
│   ├── dashboard/
│   │   ├── layout.tsx                # Auth guard + sidebar nav
│   │   ├── page.tsx                  # Overview
│   │   ├── episodes/
│   │   │   ├── page.tsx              # Episode table
│   │   │   └── [id]/page.tsx         # Episode detail (transcript viewer, VTT player, edit)
│   │   ├── jobs/page.tsx             # Job queue management (BullMQ dashboard)
│   │   ├── usage/page.tsx
│   │   ├── settings/page.tsx         # QIR config + transcript corrections dictionary
│   │   ├── downloads/page.tsx        # Batch downloads (transcripts, VTTs, QIR exports)
│   │   └── generate/page.tsx         # QIR builder (draft/finalize workflow)
│   ├── [year]/
│   │   └── q[quarter]/page.tsx       # Public QIR page
│   └── api/
│       ├── jobs/route.ts             # Trigger, status, pause/resume, batch size config
│       ├── episodes/route.ts         # CRUD + bulk retry
│       ├── episodes/[id]/route.ts    # Single episode operations
│       ├── qir/route.ts              # Generate + finalize
│       ├── qir/export/route.ts       # DOCX + CSV export
│       ├── usage/route.ts            # Stats
│       ├── corrections/route.ts      # CRUD for transcript_corrections
│       └── downloads/route.ts        # Batch download (zip) generation
├── workers/
│   ├── index.ts                      # BullMQ setup + cron (hourly ingest at :02)
│   ├── ingest.ts
│   ├── transcribe.ts
│   ├── summarize.ts
│   └── generate-qir.ts
├── lib/
│   ├── supabase.ts                   # Client + types
│   └── usage.ts                      # Cost tracking
├── supabase/
│   └── migrations/
│       └── 001_usage_settings_drafts.sql
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Implementation Priority

1. **Workers first** — get ingest/transcribe/summarize running. This replaces the broken n8n flows immediately.
2. **API routes** — endpoints the dashboard will consume
3. **Dashboard UI** — episode queue, job triggers, usage tracking
4. **QIR generator + public page** — the final output
5. **Settings page** — config management
6. **Polish** — error states, loading states, mobile responsiveness

---

## Testing Strategy

- Test ingest against live RSS: `https://archive.kpfk.org/getrss.php?id=alterradioar`
- Test transcription with a known short episode first
- Test summarization by feeding a known transcript and verifying JSON output
- Test QIR generation against the existing Q2 2025 QIR (provided as reference in project files)
- The existing 1,423 episodes in the database serve as real test data
