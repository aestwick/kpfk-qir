# Spec: Concurrent Multi-Station Pipeline + Master Control

**Status:** Draft / proposed
**Branch:** `claude/vibrant-faraday-AZNcG`
**Scope:** Enable all stations to flow through the processing pipeline concurrently (hands-off), and add a super-admin Master Control view that monitors and controls every station's pipeline from one screen.

---

## 1. Background

The app is multi-tenant (one codebase / DB / deployment serving KPFK + the other Pacifica stations). Today:

- **One shared set of BullMQ queues** (`ingest`, `transcribe`, `summarize`, `compliance`, `generate-qir`, `auto-retry`) serves all stations. Isolation is by a `stationId` carried on each job plus a `station_id` filter on every query — not by separate queues.
- The cron tick **fans out per station** (one job per station per stage) for ingest and auto-retry (`workers/ingest.ts:219`, `workers/auto-retry.ts:20`).
- Each station's pipeline is a **single-job-at-a-time chain**: the `*-continue` handlers re-queue exactly one follow-up job per completion, carrying `stationId` (`workers/index.ts:103`, `:131`).
- **Transcribe concurrency is 1** in steady mode (`workers/index.ts:13-16`), so all stations serialize through one worker slot.
- **Ingest does NOT auto-trigger transcribe** — despite CLAUDE.md saying it does, the code comment disabled it (`workers/index.ts:81`); transcription is triggered manually per active station from the dashboard (`app/api/jobs/route.ts:72-111`).
- The dashboard always acts on **one active station** (`getStationContext` requires an active-station slug and returns 400 without one, `lib/auth.ts:108-111`). There is no cross-station view.

### Capacity findings (VPS: `srv916163.hstgr.cloud`, Hostinger KVM)

Observed from Server Usage graphs while one station processed at concurrency 1:

| Metric | Idle baseline | Peak during a run |
|---|---|---|
| CPU | ~2% | **~26%** (host) |
| RAM | ~2.8 GB | ~4 GB (axis tops 6 GB → host ~8 GB) |
| Disk | ~36 GB flat | ~40 GB (temp chunks, fully cleaned up) |
| Incoming | ~0 | **~2.8 GB** (MP3 downloads from archive.kpfk.org) |
| Outgoing | ~0 | ~1.2 GB |

Container limits today (`docker-compose.yml`): `qir-worker` `cpus: 1.5` / `mem_limit: 2g`; `qir-app` `cpus: 1.0` / `mem_limit: 1g`; `qir-redis` `mem_limit: 512m`.

**Conclusion:** the pipeline is I/O-bound (waiting on Groq + archive downloads), not CPU-bound. The host idles ~75% of the time even at peak and has ample headroom for 4 concurrent pipelines. The real ceilings are **external/shared**: the Groq Whisper rate tier, the OpenAI org rate + spend limit, and archive.kpfk.org bandwidth — none of which more local concurrency can raise.

---

## 2. Goals / Non-goals

### Goals
- All stations process **concurrently and hands-off** through `ingest → transcribe → summarize → compliance`, driven by the hourly cron.
- Use the proven host headroom (raise transcribe concurrency + worker container limits) without exceeding it.
- A **super-admin-only Master Control** page that monitors all stations' pipelines at once and exposes global + per-station controls.

### Non-goals
- QIR draft generation stays **manual** (unchanged).
- No per-station queue infrastructure (the shared-queue + `stationId` model is retained).
- No move off the single VPS / single Redis / single Supabase deployment.
- No change to the auth/RLS isolation model.

---

## 3. Decisions (locked)

| Decision | Choice |
|---|---|
| How stations get triggered | **Hands-off auto-dispatch** (cron chains ingest→transcribe→summarize→compliance per station) |
| Concurrency / resource aggressiveness | **Moderate** (steady transcribe=2 / catch-up=4; worker `cpus 1.5→3.0`, `mem 2g→3g`) |
| Master Control scope | Super-admin only; **monitor + control** (global pause/mode + per-station advance) |

---

## 4. Design

### Phase 1 — Capacity (config only, low risk)

**`workers/index.ts` — `PIPELINE_MODES` (`:13-16`)**
```
steady:    { transcribe: 1 → 2,  summarize: 5 }   // unchanged: summarize
catch-up:  { transcribe: 3 → 4,  summarize: 10 }
```
Summarize stays 5/10 (already ample). Compliance stays at concurrency 1 (fast text-only call) — flagged as a watch-point, not changed.

**`docker-compose.yml` — `qir-worker` (`:41-42`)**
```
cpus:      '1.5' → '3.0'
mem_limit: 2g    → 3g
```
Within proven headroom (idle ~2.8 GB RAM, 26% peak CPU from one station). `qir-app` and `qir-redis` unchanged.

### Phase 2 — Hands-off auto-dispatch

No new scheduler is required, because each station's chain is already single-job-at-a-time, so a station can hold **at most one** transcribe slot at any instant. With concurrency ≥ number of active stations, BullMQ's FIFO naturally round-robins the slots across stations — fairness is automatic. The atomic `status='pending'` claim guard (`workers/transcribe.ts:204-209`) already prevents double-processing.

Two surgical edits:

1. **`workers/index.ts` ingest `completed` handler (`:78-82`):** for **per-station** ingest jobs only (`job.data.stationId` set — not the stationless dispatcher tick, which would throw in `processTranscribe`), enqueue:
   ```
   transcribeQueue.add('cron-transcribe', { stationId, source: 'cron', chain: true })
   ```
   This restores the ingest→transcribe kick per station each hour and also drains any backlog that auto-retry reset to `pending`. The transcribe worker no-ops cheaply when nothing is pending.

2. **Broaden the existing chain conditions** from `source === 'audit' && chain` to **`chain === true`** (covers both `audit` and `cron`):
   - transcribe → summarize (`workers/index.ts:107`)
   - summarize → compliance (`workers/index.ts:135`)

   The `chain: true` flag already propagates through the `*-continue` re-queues (`:103`, `:131`), so the whole `ingest → transcribe → summarize → compliance` chain flows automatically. Existing `audit` callers (which pass `chain: true`) are unaffected. Compliance is terminal (no further auto-chain); QIR generation remains manual.

**Behavioral notes**
- `isPipelinePaused()` is checked at the top of every processor — pause still halts the chain globally.
- Stations with no `rss_base_url` are skipped visibly at ingest (`workers/ingest.ts:233-236`), so auto-dispatch is a no-op for them until configured.

### Phase 3 — Doc fixes

- Update CLAUDE.md's stale "Ingest completion auto-triggers transcription" note to describe the new cron-driven chain accurately (and that it is gated by `pipeline_paused`).

### Phase 4 — Master Control (super-admin only)

A cross-station monitor + control surface. Has no single active station, so it does **not** use `getStationContext`.

**4a. Auth helper — `lib/auth.ts`**
Add `requireSuperAdmin(request)`:
- Resolves bearer token → user → `super_admins` (reusing the existing logic at `lib/auth.ts:69-77`).
- Returns the request-scoped **RLS** client plus the full station list (`id, slug, name`). Super-admin RLS (`user_station_ids()`) already returns all stations, so reads stay defense-in-depth.
- Non-super-admins → `403`. Does **not** require an active-station slug.

**4b. API — `app/api/control/route.ts`**
- **`GET`** → one aggregated payload:
  - `stations[]`: for each station — current-quarter backlog by stage (`pending`, `transcribed`, `summarized`, `compliance_checked`, plus `failed`, `dead`), in-flight jobs per stage (read from the global queues, grouped by `job.data.stationId`), and last-activity timestamp.
  - `pipeline_paused`, `pipeline_mode` (global).
  - Implementation: per-station counts via `Promise.all` (4 stations × stages is fine). _Optimization (later):_ a `get_pipeline_status_by_station` RPC — pairs with the known non-station-aware `get_episode_counts_by_show` RPC noted in CLAUDE.md.
- **`POST`** → super-admin global + per-station controls:
  - `pause` / `resume` (global `pipeline_paused`)
  - `set_mode` (`steady` | `catch-up`)
  - `advance` `{ stationId }` — kick a specific station's pipeline (mirrors `advance-pipeline` in `app/api/jobs/route.ts`, but for any station, not just the active one).
  - All gated by `requireSuperAdmin`. (If a **monitor-only** version is preferred, omit the `POST` route.)

**4c. UI — `app/dashboard/control/page.tsx`** (`'use client'`)
- Nav link in `app/dashboard/layout.tsx`, rendered **only for super-admins** via the client-side `super_admins` check (same pattern as `app/components/station-switcher.tsx:41-46`).
- Layout: a live grid — one card per station showing its mini-pipeline (stage counts), in-flight badges, failed/dead counts, last activity, and a per-station **Advance** button. Global **Pause/Resume** + **steady/catch-up** toggle at the top.
- **Polls `GET /api/control` every ~10s** (matching existing dashboard polling) so all pipelines are monitored concurrently.
- Non-super-admins who reach the route get a clean "Super admin only" state, backed by the API `403`.

---

## 5. Validation

- After deploy, watch the next run on the same **Server Usage** graph: peak CPU should stay **< ~80%**, RAM under the 3 GB worker cap, disk churn transient.
- **Watch the Groq 429 rate** in worker logs (`workers/transcribe.ts:143-150`) — the true external ceiling. If 429 backoffs spike, drop steady transcribe back to 1.
- Confirm Master Control shows all stations updating live, and that non-super-admins cannot reach it (403 + hidden nav link).
- Confirm `pipeline_paused` from Master Control halts every station's chain.

## 6. Rollback

All changes are config + small, isolated edits:
- Revert `PIPELINE_MODES` and the `docker-compose.yml` worker limits.
- Revert the ingest `completed` kick and the two `chain === true` conditions.
- Master Control is additive (new route/page/helper) — remove the route + nav link to disable.

## 7. Risks & prerequisites

- **Groq tier is the real limiter** and is not documented in the repo — confirm the RPM / audio-minutes allowance. Moderate settings are conservative enough to start.
- **archive.kpfk.org bandwidth:** 4 concurrent stations ≈ ~11 GB incoming per catch-up run, pulled from one origin. VPS monthly transfer quota is fine; the origin's capacity is the shared limit.
- **OpenAI org spend limit** is shared across all stations; a billing block halts everyone (spend-limit errors already avoid burning retries — `lib/retry-policy.ts`).
- The 3 non-KPFK stations still need `rss_base_url` / `mp3_filename_prefix` set before they ingest; auto-dispatch skips them visibly until then.

## 8. Files touched

| File | Change |
|---|---|
| `workers/index.ts` | concurrency presets; ingest→transcribe kick; broaden 2 chain conditions |
| `docker-compose.yml` | `qir-worker` cpus/mem |
| `lib/auth.ts` | `requireSuperAdmin()` helper |
| `app/api/control/route.ts` | **new** — aggregated GET + control POST |
| `app/dashboard/control/page.tsx` | **new** — Master Control UI |
| `app/dashboard/layout.tsx` | super-admin-gated nav link |
| `CLAUDE.md` | correct stale auto-trigger note |

## 9. Open questions

- Master Control: **monitor + control** (assumed) or **monitor-only**?
- Commit strategy: one commit, or split per phase?
- Add the `get_pipeline_status_by_station` RPC now, or ship per-station `Promise.all` first and optimize later?
