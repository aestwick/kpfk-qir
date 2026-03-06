# BUILD PLAN — qir.kpfk.org

Sequenced implementation phases. Each phase is a shippable, testable increment.

---

## Phase 0: Project Skeleton + Database Migrations

**Goal:** Bootable Next.js app with Docker, Redis, Supabase client, and new tables created via additive migrations. Nothing functional yet — just the scaffold everything else plugs into.

**Files:**
| File | Purpose |
|------|---------|
| `package.json` | Next.js 14, BullMQ, ioredis, @supabase/supabase-js, concurrently, dotenv |
| `tsconfig.json` | TypeScript config |
| `next.config.js` | Next.js config (output standalone for Docker) |
| `.env.example` | All env vars documented |
| `Dockerfile` | Node 20 + ffmpeg, builds Next.js, runs `start:all` |
| `docker-compose.yml` | `qir-app` + `qir-redis` services |
| `lib/supabase.ts` | Server-side Supabase client (service role) + browser client (anon key) |
| `lib/redis.ts` | ioredis connection singleton |
| `supabase/migrations/001_add_new_tables.sql` | CREATE `usage_log`, `qir_settings`, `qir_drafts`, `transcript_corrections`; ALTER `episode_log` add `error_message` + `retry_count`; INSERT default settings. All idempotent (`IF NOT EXISTS`). |
| `app/layout.tsx` | Root layout (minimal) |
| `app/page.tsx` | Redirect to `/dashboard` |

**Test:**
- `npm install && npm run build` succeeds
- Run migration SQL against Supabase — verify new tables exist, existing tables untouched
- `docker compose build` succeeds

---

## Phase 1: Ingest Worker

**Goal:** Fetch RSS feeds for all active non-Music shows, dedupe against `episode_log`, insert new episodes. Runnable via `npm run ingest` CLI command.

**Files:**
| File | Purpose |
|------|---------|
| `workers/queues.ts` | BullMQ queue definitions (ingest, transcribe, summarize) + Redis connection |
| `workers/ingest.ts` | Ingest processor: fetch show_keys, fetch RSS per show, parse XML, dedupe by mp3_url, insert new episodes |
| `workers/index.ts` | Worker entrypoint: registers processors, sets up hourly cron for ingest (minute :02) |
| `workers/cli.ts` | CLI runner: `npm run ingest` dispatches an ingest job and waits for completion |
| `lib/date-utils.ts` | Pacific timezone date formatting helpers |
| `package.json` | Add `scripts.ingest`, `scripts.workers` |

**Test:**
- `npm run ingest` — check Supabase `episode_log` for new rows with status `pending`
- Run again — verify no duplicates (dedupe by `mp3_url`)
- Verify dates are Pacific timezone, duration parsed correctly
- Check against live RSS: `https://archive.kpfk.org/getrss.php?id=alterradioar`

---

## Phase 2: Transcribe Worker

**Goal:** Pick pending episodes, download + chunk audio with ffmpeg, transcribe via Groq Whisper, apply transcript corrections, store transcript + VTT, log usage. Runnable via `npm run transcribe`.

**Files:**
| File | Purpose |
|------|---------|
| `workers/transcribe.ts` | Transcription processor: ffmpeg chunking, Groq API calls with backoff, VTT generation, transcript correction application, cleanup |
| `lib/corrections.ts` | Load active corrections from `transcript_corrections`, apply find-and-replace (case-insensitive / regex support) |
| `lib/usage.ts` | Insert row into `usage_log` with cost estimation |
| `lib/vtt.ts` | Build VTT string from Groq verbose_json timestamps, offset by chunk index |
| `package.json` | Add `scripts.transcribe` |

**Test:**
- `npm run transcribe` — pick one pending episode, verify:
  - `transcripts` table has new row with transcript + VTT text
  - `episode_log.status` updated to `transcribed`
  - `usage_log` has a Groq entry with duration_seconds
  - Temp audio files cleaned up from `/tmp/qir-audio`
- Test 404 MP3 — verify episode marked `unavailable`
- Test failure — verify `status = 'failed'`, `error_message` populated, `retry_count` incremented
- Add a correction to `transcript_corrections`, re-transcribe — verify correction applied

---

## Phase 3: Summarize Worker

**Goal:** Pick transcribed episodes, send transcript to GPT-4o-mini with the spec's system prompt, parse JSON response, update episode_log fields. Runnable via `npm run summarize`.

**Files:**
| File | Purpose |
|------|---------|
| `workers/summarize.ts` | Summarize processor: load transcript, call OpenAI, parse JSON, update episode_log (headline, summary, host, guest, issue_category, status), log usage |
| `package.json` | Add `scripts.summarize`, add `openai` dependency |

**Test:**
- `npm run summarize` — pick one transcribed episode, verify:
  - `episode_log` fields populated: headline, summary, host, guest, issue_category
  - `status` updated to `summarized`
  - `usage_log` has an OpenAI entry with token counts
- Verify JSON output matches expected schema
- Verify discrepancy field stored if AI flags one

---

## Phase 4: QIR Generation Worker

**Goal:** Given a year+quarter, gather all summarized episodes in that date range, group by issue_category, call GPT-4o-mini to curate top entries, store full + curated report as a draft. Runnable via `npm run generate-qir -- --quarter Q1 --year 2026`.

**Files:**
| File | Purpose |
|------|---------|
| `workers/generate-qir.ts` | QIR generator: query episodes by date range, group by category, send to OpenAI for curation, format full + curated text, store in `qir_drafts` |
| `lib/qir-format.ts` | Format QIR entries into FCC-compliant text (issue header, show name, date, time, duration, headline, guests, summary) |
| `package.json` | Add `scripts.generate-qir` |

**Test:**
- `npm run generate-qir -- --quarter Q1 --year 2026` — verify:
  - `qir_drafts` row created with `status = 'draft'`
  - `curated_entries` JSON has episode IDs
  - `full_text` and `curated_text` populated with formatted report
  - Curation respects max_entries_per_category from settings
- Verify entries span variety of shows and dates

---

## Phase 5: Full Pipeline + Cron Integration

**Goal:** Wire all 4 workers into BullMQ with proper sequencing (ingest triggers transcribe, transcribe triggers summarize), hourly cron, and `npm run start:all` for Docker.

**Files:**
| File | Purpose |
|------|---------|
| `workers/index.ts` | (update) Wire event handlers: ingest completion enqueues transcribe batch, transcribe completion enqueues summarize batch. Hourly repeatable job at :02. Current-quarter-only filter for auto-processing. |
| `package.json` | Add `scripts.start:all` using concurrently (Next.js + workers) |

**Test:**
- `npm run workers` — verify hourly cron fires (or trigger manually)
- After ingest, transcribe jobs appear automatically
- After transcribe, summarize jobs appear automatically
- Only current-quarter episodes auto-processed
- Stop and restart — verify cron resumes

---

## Phase 6: API Routes

**Goal:** REST endpoints for dashboard consumption. Auth-guarded. These can be tested with curl before any UI exists.

**Files:**
| File | Purpose |
|------|---------|
| `lib/auth.ts` | Supabase auth helper — validate session from request headers |
| `app/api/jobs/route.ts` | GET queue stats, POST trigger job (ingest/transcribe/summarize), PATCH pause/resume, PUT batch size |
| `app/api/episodes/route.ts` | GET paginated episodes (filter by status/quarter/show/category), POST bulk retry |
| `app/api/episodes/[id]/route.ts` | GET single episode + transcript, PATCH update fields, POST re-transcribe/re-summarize |
| `app/api/qir/route.ts` | GET drafts list, POST generate new draft, PATCH finalize/un-finalize |
| `app/api/qir/export/route.ts` | GET export as DOCX or CSV |
| `app/api/usage/route.ts` | GET usage stats by date range |
| `app/api/corrections/route.ts` | GET all corrections, POST create, PATCH update, DELETE |
| `app/api/downloads/route.ts` | GET batch download (zip of transcripts/VTTs for a quarter) |
| `app/api/settings/route.ts` | GET/PUT qir_settings |

**Test:**
- curl each endpoint with a valid Supabase auth token
- Verify 401 without auth
- Verify filtering, pagination, CRUD operations against live data

---

## Phase 7: Auth + Dashboard Layout

**Goal:** Login page, auth guard on `/dashboard/*`, sidebar navigation shell. No functional pages yet — just the skeleton with nav links.

**Files:**
| File | Purpose |
|------|---------|
| `app/login/page.tsx` | Email/password login form using Supabase Auth |
| `app/dashboard/layout.tsx` | Auth guard (redirect to /login if no session) + sidebar nav (Overview, Episodes, Jobs, Usage, Settings, Generate, Downloads) |
| `app/dashboard/page.tsx` | Overview placeholder |
| `lib/supabase-browser.ts` | Browser-side Supabase client for auth |
| `middleware.ts` | Next.js middleware for auth session refresh |

**Test:**
- Visit `/dashboard` — redirects to `/login`
- Log in with valid Supabase credentials — lands on dashboard
- Sidebar nav links visible

---

## Phase 8: Dashboard — Overview + Episodes

**Goal:** Functional overview page with status counts and episode table with detail view.

**Files:**
| File | Purpose |
|------|---------|
| `app/dashboard/page.tsx` | (update) Status counts, recent activity, quick action buttons |
| `app/dashboard/episodes/page.tsx` | Paginated episode table with filters (status, quarter, show, category), sortable columns, bulk retry |
| `app/dashboard/episodes/[id]/page.tsx` | Episode detail: metadata, transcript viewer, VTT audio player, editable summary, issue category dropdown, re-transcribe/re-summarize buttons, download links |
| `app/globals.css` | Tailwind + base styles |

**Test:**
- Overview shows correct counts matching Supabase data
- Episode table filters and pagination work
- Episode detail shows transcript, plays audio with VTT captions
- Inline editing saves correctly

---

## Phase 9: Dashboard — Jobs, Usage, Settings

**Goal:** Remaining dashboard pages.

**Files:**
| File | Purpose |
|------|---------|
| `app/dashboard/jobs/page.tsx` | Live queue stats, job history, pause/resume, batch size config, manual triggers |
| `app/dashboard/usage/page.tsx` | Date range picker, cost breakdown by service/operation, daily spend table |
| `app/dashboard/settings/page.tsx` | QIR settings editor (categories, models, prompts, batch sizes) + transcript corrections CRUD table with test preview |

**Test:**
- Jobs page reflects actual BullMQ state
- Trigger a job from the UI, see it appear in the queue
- Usage page shows real cost data from `usage_log`
- Settings save to `qir_settings` and `transcript_corrections`
- Correction test preview applies rules to sample text

---

## Phase 10: Dashboard — QIR Builder + Downloads

**Goal:** Generate, review, edit, and finalize QIR reports from the dashboard.

**Files:**
| File | Purpose |
|------|---------|
| `app/dashboard/generate/page.tsx` | Quarter selector, generate button, draft history, two-column full/curated view, editable curated side, re-run curation, finalize/un-finalize, export buttons |
| `app/dashboard/downloads/page.tsx` | Batch download page: transcripts zip, VTTs zip, QIR DOCX/CSV, episode data CSV |
| `lib/docx.ts` | DOCX generation using docx library |

**Test:**
- Generate a QIR draft — appears in draft list
- Edit curated entries — changes persist
- Re-run curation — new version created, old preserved
- Finalize — status changes to `final`
- Export DOCX and CSV — files download correctly
- Batch downloads produce valid zip files

---

## Phase 11: Public QIR Page

**Goal:** Public-facing QIR page at `/[year]/q[quarter]` for finalized reports.

**Files:**
| File | Purpose |
|------|---------|
| `app/[year]/q[quarter]/page.tsx` | Renders finalized QIR: grouped by issue category, FCC-compliant layout, print stylesheet |
| `app/[year]/q[quarter]/print.css` | `@media print` styles for clean PDF output |

**Test:**
- Finalize a QIR in the dashboard, visit `/2026/q1` — report renders
- Visit non-existent quarter — 404
- Cmd+P produces clean, filing-ready PDF
- Header/footer text matches FCC expectations

---

## Phase 12: Polish + Hardening

**Goal:** Error states, loading states, edge cases, mobile.

**Tasks:**
- Loading skeletons on all dashboard pages
- Error boundaries with retry
- Empty states (no episodes, no drafts, etc.)
- Mobile-responsive sidebar (collapsible)
- Rate limit indicators on job pages
- Confirm dialogs on destructive actions (finalize, bulk retry)
- Docker health check
- `README.md` with setup/deploy instructions

---

## Dependency Graph

```
Phase 0 (skeleton + migrations)
  |
  v
Phase 1 (ingest) --> Phase 2 (transcribe) --> Phase 3 (summarize) --> Phase 4 (QIR gen)
                                                                          |
                                                                          v
                                                                     Phase 5 (full pipeline)
                                                                          |
                                                                          v
                                                                     Phase 6 (API routes)
                                                                          |
                                                                          v
                                                                     Phase 7 (auth + layout)
                                                                          |
                                                                          v
                                                              Phase 8 (overview + episodes)
                                                                          |
                                                                          v
                                                              Phase 9 (jobs, usage, settings)
                                                                          |
                                                                          v
                                                              Phase 10 (QIR builder + downloads)
                                                                          |
                                                                          v
                                                              Phase 11 (public QIR page)
                                                                          |
                                                                          v
                                                              Phase 12 (polish)
```

Phases 0-5 deliver a fully working pipeline with no UI — testable entirely via CLI and direct Supabase inspection. This is the critical path that replaces the broken n8n workflows.
