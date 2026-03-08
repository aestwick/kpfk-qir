# Improvement Plan — qir.kpfk.org

Prioritized list of architectural, pipeline, UI, and performance improvements.
Reviewed and triaged by project owner on 2026-03-08.

---

## P0 — Do Before Going Live ✅ COMPLETE

### 1. Add Missing Database Indexes ✅

Added migration `supabase/migrations/002_add_indexes.sql` with indexes on:
- `episode_log(status, air_date)` — pipeline queries
- `episode_log(mp3_url)` — deduplication
- `transcripts(episode_id)` — joins
- `usage_log(created_at)` — cost analytics

### 2. Add OpenAI Retry Logic with Backoff ✅

Added exponential backoff in `workers/summarize.ts` — retries up to 3 times on 429, 500, 502, 503 errors with 2s/4s/8s delays before marking as failed.

### 3. Add BullMQ Job Timeouts ✅

All workers in `workers/index.ts` now have timeouts, attempts, and exponential backoff:
- Ingest: 5 min timeout, 2 attempts
- Transcribe: 10 min timeout, 2 attempts
- Summarize: 2 min timeout, 2 attempts
- Generate QIR: 5 min timeout, 2 attempts

---

## P1 — Next Sprint ✅ COMPLETE

### 4. Separate Workers from Web Server ✅

`docker-compose.yml` now has separate `qir-app` (web only, `npm run start`) and `qir-worker` (workers only, `npm run workers`) services using the same image.

### 5. Docker Resource Limits ✅

- `qir-app`: 1g memory, 1.0 CPU
- `qir-worker`: 2g memory, 1.5 CPU (headroom for ffmpeg)
- `qir-redis`: 256m memory
- All services: JSON log driver with 10m max-size, 3 file rotation

### 6. Fix N+1 Query Patterns ✅

- **Downloads API** was already using batch `.in()` query + Map — no change needed.
- **Summarize worker** now batch-fetches all transcripts upfront with `.in('episode_id', epIds)` and a Map lookup instead of one query per episode.

### 7. Enable Authentication ✅

Removed auth bypass in `app/dashboard/layout.tsx`. Supabase session checks and `onAuthStateChange` listener are now active. Unauthenticated users are redirected to `/login`.

### 8. Auto-Retry Failed Episodes ✅

New `workers/auto-retry.ts` runs every 4 hours via cron (minute :17). Resets failed episodes with `retry_count < 3` back to `pending` for automatic re-processing. Triggers the transcription pipeline when episodes are reset.

### 9. Dead-Letter Status for Persistent Failures ✅

Episodes that fail 3+ times are promoted to `dead` status by the auto-retry worker, stopping further retries. Migration `003_dead_status_index.sql` adds a partial index for efficient querying.

---

## Infrastructure — CI/CD ✅ COMPLETE

### 10. GitHub Actions CI/CD Pipeline ✅

- `.github/workflows/build.yml`: Builds Docker image on push to `main`, pushes to `ghcr.io/aestwick/kpfk-qir` tagged with `latest` + git SHA
- `docker-compose.yml` pulls pre-built image from ghcr.io (Dockerfile kept for local dev)
- `deploy-qir.sh`: One-command VPS deploy — git pull, docker compose pull, up -d, prune

---

## P2/P3 — Nice to Have

### 11. SSE Instead of Polling ✅

Added `/api/events` SSE endpoint that streams queue status every 5 seconds over a persistent connection. Jobs page uses `useQueueSSE()` hook for live updates without polling. Dashboard uses SSE for pipeline visualization (live queue data) and reduced polling interval (30s instead of 5s) for the full dashboard data.

### 12. URL-Persisted Filters ✅

Episode filters (status, quarter, show, category, sort, page) are now stored in URL search params via `useSearchParams`. Users can bookmark filtered views and share links. Filters survive navigation.

### 13. Shared Toast/Notification System ✅

Extracted `app/components/toast.tsx` with `ToastProvider` and `useToast()` hook. Toasts auto-dismiss after 5 seconds with manual dismiss option. Replaced per-page state in dashboard overview, jobs, and settings pages.

### 14. Parallelize RSS Ingest ✅

RSS feeds are now fetched in parallel batches of 5 using `Promise.allSettled()`. Per-show logic extracted into `processShow()` helper.

### 15. Lazy-Load Dashboard Pages ✅

Next.js App Router already code-splits each route segment into its own chunk. No additional `next/dynamic` needed — build output confirms each page is 1–5KB independently loaded.

### 16. ISR for Public QIR Page ✅

Public QIR page (`/[year]/q[quarter]`) now uses `revalidate = 86400` (24 hours). Finalized reports are cached and served statically.

### 17. Keyboard Shortcuts ✅

Episodes page now supports: `j`/`k` to navigate rows, `Enter` to open selected episode, `/` to focus the show filter, `r` to retry all failed. Selected row is highlighted with a blue ring. Shortcut hints shown below the table.

### 18. Timeline/Activity Log View ✅

New `/dashboard/activity` page shows a full historical timeline of pipeline events grouped by day. Supports 24h, 3-day, 7-day, and 30-day ranges. Each entry links to the episode detail page. Added to sidebar navigation.

---

## Known Issues — Fixed ✅

All known issues documented during development have been resolved.

### Dashboard `workersRunning` check is always true ✅

Fixed `>= 0` to `> 0` in `app/dashboard/page.tsx`. Badge now correctly shows "idle" (red) when no workers are active.

### SSE `: connected` comment is misleading ✅

Changed from SSE comment (`: connected`) to a proper named event (`event: connected\ndata: {}\n\n`) in `app/api/events/route.ts`.

### Invalid regex in transcript corrections can crash transcription worker ✅

Added try/catch around `new RegExp()` in `workers/transcribe.ts`. Invalid patterns are now logged and skipped instead of crashing the worker.

### No schema validation on OpenAI JSON responses ✅

Added validation in `workers/summarize.ts` (requires headline + summary) and `workers/generate-qir.ts` (requires non-empty object). Jobs now fail with descriptive errors instead of storing empty data.

### N+1 query in settings API ✅

Replaced full-table scan with `get_episode_counts_by_show()` RPC function (migration `007_episode_counts_rpc.sql`) that uses `GROUP BY` at the database level.

### No upper bound on episodes pagination limit ✅

Added `Math.min(..., 500)` cap on the `limit` query param in `app/api/episodes/route.ts`.

### Hardcoded FCC issue categories in multiple files ✅

Dashboard API (`app/api/dashboard/route.ts`) now uses `getIssueCategories()` from `lib/settings.ts`. Generate page (`app/dashboard/generate/page.tsx`) fetches categories from settings API. `workers/generate-qir.ts` already used `getSetting('issue_categories')`.

---

## Skip Entirely (For Now)

### Streaming Transcripts to Summarizer

The concern about sending full transcripts to GPT-4o-mini is valid in theory, but GPT-4o-mini's context window is 128k tokens. A 3-hour show produces roughly 30–40k tokens of transcript. You're well within limits for every show KPFK airs. Revisit only if you start processing unusually long content (multi-hour specials, fundraiser marathons).

### Waveform Audio Visualization

Cool but purely cosmetic. The existing audio player with VTT captions works. Not a priority for an internal tool.

### Diff View for Summary Edits

Showing original vs. edited summary in the episode detail page. Nice for auditing but the current inline edit is fine for 2–3 staff users.
