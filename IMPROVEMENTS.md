# Improvement Plan — qir.kpfk.org

Prioritized list of architectural, pipeline, UI, and performance improvements.
Reviewed and triaged by project owner on 2026-03-08.

---

## P0 — Do Before Going Live

These are quick fixes that prevent real failures during your first big batch run.

### 1. Add Missing Database Indexes

The migration only creates one index (`idx_qir_draft_active`). These columns are queried constantly and will slow to a crawl as the episode table grows past a few thousand rows:

```sql
CREATE INDEX IF NOT EXISTS idx_episode_status_airdate ON episode_log(status, air_date);
CREATE INDEX IF NOT EXISTS idx_episode_mp3url ON episode_log(mp3_url);
CREATE INDEX IF NOT EXISTS idx_transcripts_episode ON transcripts(episode_id);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
```

**Where:** New migration file `supabase/migrations/002_add_indexes.sql`
**Risk:** None — additive, no schema changes.

### 2. Add OpenAI Retry Logic with Backoff

The Groq transcription path has proper exponential backoff on 429s, but the OpenAI summarization worker (`workers/summarize.ts`) has zero retry logic. One transient API error marks the episode as `failed` permanently, requiring manual intervention.

**Fix:** Wrap the OpenAI call in a retry loop with exponential backoff (same pattern as Groq in `workers/transcribe.ts` lines 124–148). Retry up to 3 times on 429, 500, 502, 503 errors.

**Where:** `workers/summarize.ts`, around the `openai.chat.completions.create()` call.

### 3. Add BullMQ Job Timeouts

No timeout is configured on any queue. A hung ffmpeg process or a stalled API call will block the worker indefinitely — and since workers run in the same container as the web server, this can take down the dashboard too.

**Fix:** Add `timeout` and `attempts` with backoff to job options in `workers/index.ts`:

```typescript
new Worker(queueName, processor, {
  connection,
  concurrency: 1,
  limiter: { max: 1, duration: 1000 },
  defaultJobOptions: {
    timeout: 10 * 60 * 1000,  // 10 minutes for transcribe, 2 min for summarize
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
```

**Where:** `workers/index.ts` worker creation blocks.

---

## P1 — Do After Testing (Next Sprint)

Important but not urgent. You're the only user right now, the VPS isn't under load, and you need to get the pipeline running first.

### 4. Separate Workers from Web Server

Currently `npm run start:all` launches both Next.js and workers in one process via `concurrently`. If a worker OOMs on a large ffmpeg transcode, it takes down the dashboard.

**Fix:** Add a separate `qir-worker` service in `docker-compose.yml` that runs `npm run workers` independently. Share the same image, just different CMD.

**Where:** `docker-compose.yml`, `Dockerfile` (no changes needed).

### 5. Docker Resource Limits

No `mem_limit`, `cpus`, or log rotation configured. ffmpeg can eat all available memory on a long episode.

**Fix:**
```yaml
services:
  qir-app:
    mem_limit: 2g
    cpus: '1.5'
    logging:
      driver: json-file
      options: { max-size: '10m', max-file: '3' }
  qir-redis:
    mem_limit: 256m
```

### 6. Fix N+1 Query Patterns

- **Downloads API** (`app/api/downloads/route.ts`): Fetches all transcripts then maps individually. Use a single query with an `IN` clause.
- **Summarize worker** (`workers/summarize.ts`): Fetches transcript per episode in a loop. Batch-fetch all transcripts for the batch in one query.

These will matter once you're processing hundreds of episodes per quarter.

### 7. Enable Authentication

Auth is bypassed with a `TODO` comment in `app/dashboard/layout.tsx` (lines 34–38). Before anyone else uses the dashboard, remove the bypass and wire Supabase auth back in. Consider role-based access (admin vs. read-only) if more staff need access.

### 8. Auto-Retry Failed Episodes

Failed episodes currently require manual intervention (bulk retry button or per-episode retry). Add a scheduled BullMQ job that automatically retries episodes with `retry_count < 3` after a backoff period (e.g., 15 minutes after first failure, 1 hour after second).

**Where:** `workers/index.ts` — new repeating job alongside the hourly ingest cron.

### 9. Dead-Letter Queue for Persistent Failures

Episodes that fail 3+ times should stop being retried. Add a dead-letter pattern: after max retries, update status to a new `dead` status so they don't clog the pipeline. Surface these prominently in the dashboard.

---

## P2/P3 — Nice to Have (Defer)

Legitimate improvements but none are blocking you from getting the pipeline running and generating your first QIR.

### 10. SSE Instead of Polling

The dashboard and jobs page poll every 5 seconds regardless of activity. Server-Sent Events would reduce unnecessary API calls and provide instant updates. Not worth the complexity until you have multiple concurrent users.

### 11. URL-Persisted Filters

Episode filters (status, quarter, show, category, sort) reset on navigation. Store them in URL search params so users can bookmark filtered views. Nice for daily use once the system is stable.

### 12. Shared Toast/Notification System

The toast pattern is copy-pasted across pages (component-local state). Extract a shared context/provider. Low priority — it works, it's just not DRY.

### 13. Parallelize RSS Ingest

Currently fetches each show's RSS feed sequentially. Could use `Promise.allSettled()` with concurrency limit. Saves maybe 10 seconds on a job that runs hourly. Not worth the complexity right now.

### 14. Lazy-Load Dashboard Pages

All dashboard pages use `'use client'` and are bundled together. Use `next/dynamic` to lazy-load heavier pages (episode detail, QIR generator, settings). Low impact — the bundle is already small (~5KB per page).

### 15. ISR for Public QIR Page

The public report page (`/[year]/q[quarter]`) makes a fresh DB query on every request. Since finalized reports never change, use Next.js ISR with `revalidate`. Low traffic, so this barely matters.

### 16. Keyboard Shortcuts

Power users (station staff checking daily) would benefit from `J/K` to navigate episodes, `R` to retry, `/` to search. Pure convenience feature.

### 17. Timeline/Activity Log View

A historical timeline of all pipeline events. The 24h feed on the new dashboard covers the immediate need. A full history view can wait.

---

## Skip Entirely (For Now)

### Streaming Transcripts to Summarizer

The concern about sending full transcripts to GPT-4o-mini is valid in theory, but GPT-4o-mini's context window is 128k tokens. A 3-hour show produces roughly 30–40k tokens of transcript. You're well within limits for every show KPFK airs. Revisit only if you start processing unusually long content (multi-hour specials, fundraiser marathons).

### Waveform Audio Visualization

Cool but purely cosmetic. The existing audio player with VTT captions works. Not a priority for an internal tool.

### Diff View for Summary Edits

Showing original vs. edited summary in the episode detail page. Nice for auditing but the current inline edit is fine for 2–3 staff users.
