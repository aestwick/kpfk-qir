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

---

## Phase 13: Infrastructure Hardening

**Goal:** Fix P0 reliability issues before processing more episodes. No UI changes.

**Tasks:**

1. **Add missing database indexes** (new migration `002_add_indexes.sql`):
   ```sql
   CREATE INDEX IF NOT EXISTS idx_episode_status_date ON episode_log(status, air_date);
   CREATE INDEX IF NOT EXISTS idx_episode_air_date ON episode_log(air_date);
   ```

2. **Add retry/backoff to OpenAI calls** in `workers/summarize.ts` — exponential backoff on 429 and 5xx, 3 attempts max. Same pattern as Groq transcription worker.

3. **Add BullMQ job timeouts and attempts** in `workers/index.ts`:
   - Ingest: 5 min timeout, 2 attempts
   - Transcribe: 20 min timeout, 3 attempts with exponential backoff
   - Summarize: 5 min timeout, 3 attempts with exponential backoff

4. **Add `dead` status** — episodes that exhaust all retry attempts get `status = 'dead'` instead of staying `failed` forever. Dashboard shows these separately in the attention section with a "force retry" option.

5. **Docker hardening** in `docker-compose.yml`:
   - Add `mem_limit: 2g` and `cpus: '1.5'` to qir-app
   - Add `mem_limit: 256m` to qir-redis
   - Remove `version: "3.8"` (deprecated)
   - Remove `ports: 3100:3000` (should only be reachable through Traefik)

6. **Periodic temp cleanup** — add a BullMQ repeatable job that removes `/tmp/qir-audio` files older than 24 hours. Also wrap all cleanup in `finally` blocks.

**Test:**
- Run a summarize batch — verify retries on simulated failure
- Check `docker compose ps` shows resource limits
- Verify app is NOT accessible on port 3100 directly after port removal
- Create a failed episode, wait for it to hit retry limit → verify `dead` status

---

## Phase 14: Code Quality

**Goal:** Performance and UX fixes. Each item is independently testable.

**Tasks:**

1. **Cache transcript corrections** in memory with 60s TTL (same pattern as settings in `lib/settings.ts`) instead of querying DB on every transcription.

2. **Fix N+1 queries**:
   - Downloads API: batch-fetch transcripts with `IN` clause instead of individual queries
   - Summarize worker: batch-fetch all transcripts for the batch in one query

3. **Parallelize RSS ingest** — replace sequential feed fetching with `Promise.allSettled()` and concurrency limit of 5.

4. **Auto-retry job** — add a BullMQ repeatable that retries `failed` episodes with `retry_count < 3` every 6 hours.

5. **Shared toast/notification provider** — extract from copy-pasted pattern across pages into a React context provider.

6. **Persist filter state in URL params** — episode filters (status, quarter, show, category, sort) stored in URL search params so they survive navigation and are bookmarkable.

**Test:**
- Ingest runs noticeably faster with parallel fetches
- Downloads page loads faster for large quarters
- Change episode filters, navigate away and back — filters persist
- Failed episode auto-retries after 6 hours

---

## Phase 15: Dashboard Redesign

**Goal:** Redesign the `/dashboard` overview page to be a radio station ops board — warm, functional, informative at a glance.

**Visual direction:**
- White/cream background, clean but not sterile
- KPFK branding colors as accents — black, red, warm amber/gold
- Editorial typography — like a broadcast log or newspaper layout
- No gratuitous animations — purposeful motion only (gentle pulse when processing, number ticking up on new episodes)
- Should feel like a tool built BY a radio station FOR a radio station

**Layout:**

1. **"On Air" status strip** across the top — what's currently processing? "Transcribing: Beneath The Surface - Mar 5" with subtle progress indicator. Or "All caught up" when idle. Like the ON AIR light in a studio.

2. **Quarter at a glance** — big readable numbers, not charts for chart's sake. "Q1 2026: 342 episodes / 280 transcribed / 195 summarized / QIR: Draft in progress". Simple progress bar for overall pipeline completion.

3. **Time estimates for remaining work** — calculated from historical averages in `usage_log`:
   - Per stage: "~45 min to finish transcription (15 episodes × 3 min avg)"
   - Per stage: "~2 min to finish summarization (8 episodes × 15s avg)"
   - Overall: "Pipeline clear in ~47 min at current pace"
   - If nothing pending: "All caught up"
   - SQL for averages: `SELECT AVG(duration_seconds) FROM usage_log WHERE operation = 'transcribe' AND created_at > now() - interval '7 days'`

4. **Recent activity as a broadcast log** — formatted like a radio station program log. Timestamps left column, show names, what happened. Scrollable. Auto-refreshes every 10-15 seconds.

5. **Attention needed** — failed/dead episodes formatted like a producer's pull sheet. Not red alarm bells, just clear notes: "Background Briefing Mar 3 — MP3 not found" / "Democracy Now Mar 5 — transcription failed (retry)". Count badge if items exist.

6. **Cost this month** — understated, at the bottom. Single line: "March spend: $4.82 (Groq $2.10 / OpenAI $2.72) — avg $0.03/episode". Optional sparkline for daily spend over last 30 days.

7. **System health footer** — thin strip: "Workers: running · Last ingest: 12 min ago · Last transcription: 34 min ago". Green when healthy, amber when stale (>2 hours), red when broken.

**Technical:**
- Poll `/api/dashboard`, `/api/usage`, `/api/jobs` every 10-15 seconds
- Calculate time estimates from `usage_log` averages
- Use recharts only for the cost sparkline if needed
- Page should tell everything at a glance without clicking into subpages

**Test:**
- Dashboard loads with real data
- Time estimates update as episodes process
- Activity feed shows live updates
- Health indicators reflect actual worker state

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
