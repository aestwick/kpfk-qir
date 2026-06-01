# Spec: Source-File Bundle Downloads (transcripts + MP3s)

**Status:** Proposed
**Area:** downloads API, background workers, Supabase Storage, dashboard, notifications
**Migrations:** `0NN_download_jobs.sql` (+ Storage bucket `bundles`)
**Related:** `app/api/downloads/route.ts`, `app/dashboard/downloads/page.tsx`,
`lib/queue.ts`, `workers/index.ts`, `episode_log.mp3_url`, `transcripts`

---

## 1. Problem

There is no way to pull the **source files** — transcripts, VTTs, and especially
the original **MP3 audio** — for an arbitrary set of episodes or for a single
show. The only batch export is `GET /api/downloads?year=&quarter=&type=`, which:

- is **scoped to a whole quarter only** — no per-show, per-episode, or
  date-range selection;
- concatenates transcripts/VTTs into **one `.txt`** (the code notes "zip would
  require a library") — not per-file, not the real `.vtt`;
- **never touches the audio.** The `episodes` CSV includes the `mp3_url` column,
  but nothing fetches the bytes. Source MP3s live on `archive.kpfk.org`,
  referenced by `episode_log.mp3_url`.

Staff who want "everything for *Uprising* last quarter" or "the audio + transcript
for these 12 flagged episodes" have to click through and save files one at a time.

## 2. Goals

- Let a user select episodes by **explicit IDs, show, quarter, or date range**
  and receive a single **ZIP** containing transcripts (`.txt`), captions
  (`.vtt`), the original **MP3s**, and a `manifest.csv`.
- Handle **multi-GB** bundles (a quarter of a daily show ≈ dozens of 50–100 MB
  files) without holding an HTTP request open or buffering in memory.
- Deliver **asynchronously**: build the ZIP in a background worker, store it,
  and **notify the requester two ways** — an in-app dashboard ping and an
  **email with a download link**.
- Preserve **multi-tenant isolation** — every selection, the stored artifact,
  and the signed link are scoped to one `station_id`.
- Degrade gracefully on missing audio (404 / `unavailable` episodes): record it
  in the manifest, don't fail the whole bundle.

## 3. Non-goals

- Streaming/synchronous ZIP delivery (rejected — can't survive multi-GB / proxy
  timeouts).
- Re-hosting or transcoding audio. We pass the original MP3 through verbatim.
- A general-purpose notifications center. We add the **minimum** notification
  plumbing this feature needs (see §8), not a framework.

## 4. Selection model

A bundle is defined by a **selection** that resolves server-side to a concrete
set of episode IDs, always `.eq('station_id', stationId)` (+ RLS). One unified
shape, any combination:

```ts
type BundleSelection = {
  episodeIds?: number[]         // explicit multi-select from the episode table
  showGroup?: string            // a logical show: coalesce(show_group, key)
  quarter?: { year: number; quarter: number }
  dateRange?: { start: string; end: string }   // air_date inclusive
  include: ('transcripts' | 'vtts' | 'mp3s')[] // at least one
}
```

Resolution rules:

- **Show selection uses `show_group`, never the name** — a logical show spans
  multiple feeds/keys (6am + 9am airings), so we group by
  `coalesce(show_group, key)` exactly as `lib/shows.ts` / the `show_keys` model
  prescribe. Selecting a show pulls every episode across its feeds.
- Transcripts/VTTs only exist for episodes in status `transcribed` or
  `summarized`; MP3s exist whenever `mp3_url` is set. The resolver records, per
  episode, which requested artifacts are actually present so the manifest and
  progress counts are honest.
- A guard rail caps a bundle (e.g. **max 200 episodes / max ~10 GB est.**,
  configurable via `qir_settings`); over the cap the API rejects with a hint to
  narrow the selection.

## 5. Storage & data model

**New table `download_jobs`** (tenant-scoped, RLS like the other tenant tables):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | also the storage object name |
| `station_id` | bigint fk | RLS guard |
| `requested_by` | uuid | `auth.users.id`; for the email + "your bundles" list |
| `selection` | jsonb | the `BundleSelection` above |
| `status` | text | `pending` → `processing` → `ready` / `failed` / `expired` |
| `progress` | int | 0–100, updated as files are appended |
| `file_count` | int | files actually included |
| `total_bytes` | bigint | final ZIP size |
| `storage_path` | text | `bundles/<station_slug>/<id>.zip` |
| `error` | text | populated on `failed` |
| `manifest` | jsonb | per-episode included/skipped + reason |
| `expires_at` | timestamptz | TTL (default 7 days) |
| `created_at` | timestamptz | default now() |

RLS: members of the station can `select` their own station's rows; insert via the
request-scoped client; workers use the service-role client (RLS bypassed) so the
**explicit `station_id` filter is the only guard** — same contract as every other
worker.

**Supabase Storage**: a **private** bucket `bundles`. Objects are never public;
downloads go through a **signed URL** (short TTL, e.g. 1 h) minted on demand. A
cleanup cron deletes objects past `expires_at` and marks the row `expired`.

## 6. API surface

```
POST   /api/downloads/bundles            # create job from a BundleSelection → { id }
GET    /api/downloads/bundles            # list this station's recent jobs (status/progress)
GET    /api/downloads/bundles/[id]       # poll one job
GET    /api/downloads/bundles/[id]/link  # 302 → freshly-signed Storage URL (only when ready)
DELETE /api/downloads/bundles/[id]       # cancel queued / delete artifact + row
```

- All routes go through `getStationContext(request)` and filter by `stationId`,
  consistent with the existing downloads route.
- `POST` validates the selection, enforces the cap, inserts a `pending` row,
  enqueues a `bundle` job carrying `{ jobId, stationId }`, and returns `202` with
  the id. (Jobs carry `stationId` like every other queue job.)
- Authorization: requesting a bundle requires an **editor/admin** membership
  (viewers can browse but not spawn GB-scale archive pulls). Finalized-QIR-style
  public access does **not** apply here.

## 7. Worker: `workers/bundle.ts`

New BullMQ queue `bundle` in `lib/queue.ts` (lazy-init, same pattern), registered
in `workers/index.ts`. Job options: `attempts: 1` (don't silently re-pull GBs on
retry) and an explicit **per-job timeout** (BullMQ) so a stuck archive fetch
can't wedge a worker — this also closes one of the P0 "no job timeouts" gaps.

Flow:

1. Load the job row; mark `processing`. Resolve the selection → episode list
   (service-role client, `.eq('station_id', stationId)`).
2. Open a **streaming ZIP** (`archiver`) piped **directly into a Supabase
   Storage upload stream** — never buffer the whole archive in memory or on a
   full temp disk. (If the Storage SDK needs a known length, stream to a temp
   file on a sized volume, then upload; decide at build time.)
3. For each episode, append the requested artifacts under a tidy path, e.g.
   `<showGroup>/<air_date>_<id>/`:
   - `transcript.txt`, `captions.vtt` — read from `transcripts` (scoped via the
     `episode_log!inner(station_id)` join, exactly as the current route does).
   - `audio.mp3` — `fetch(mp3_url)` with **timeout + retry/backoff**; stream the
     body straight into the archive. On 404 / non-200, **skip and record** in the
     manifest (don't fail the bundle); a 404 mirrors the episode `unavailable`
     state.
   - Update `progress` / `file_count` periodically.
4. Append `manifest.csv` (episode id, show, air_date, which files included,
   skip reasons) and finalize.
5. Set `total_bytes`, `storage_path`, `status = ready`, `expires_at`.
6. **Fan out notifications** (§8). On any fatal error, set `status = failed` +
   `error`, and notify failure.

Operational notes to flag in review:

- This pulls potentially **many GB from `archive.kpfk.org` through the VPS** per
  bundle — bandwidth/egress cost is real; the cap (§4) and a per-station
  **one-active-heavy-job** concurrency limit keep it bounded.
- Optional dedup: if an identical `selection` produced a still-`ready`,
  non-expired bundle, return that id instead of rebuilding.

## 8. Notifications (dashboard ping + email)

Neither exists today — both are **net-new**, kept minimal:

**Dashboard ping.** Reuse `download_jobs` as the source of truth; no separate
notifications table needed for v1. The dashboard polls
`GET /api/downloads/bundles` (or the existing dashboard stats endpoint gains a
"my recent bundles" slice). When a job flips to `ready`, the Bundles panel shows
a **Download** button and a small unread badge; `failed` shows the error. This is
poll-based and station-scoped — no websockets required.

**Email.** Introduce a thin `lib/email.ts` with a single `sendEmail()` helper
behind a provider chosen at build time (Resend/SES/SMTP — **decision needed**,
see §11). The worker, on `ready`, emails `requested_by` (resolved via
`auth.users`) with the station name, what was included, the file count/size, the
**expiry**, and a link to `…/bundles/[id]/link` (the app mints a fresh signed URL
on click — the email never embeds a long-lived signed URL, which would be a
leak vector). Provider creds live in env (workers already run server-side);
sender identity/branding interpolates `{{STATION_NAME}}` like the prompt
settings do. Email failure is **non-fatal** — the bundle is still `ready` and the
dashboard ping still fires; log and move on.

## 9. Dashboard UX

On `app/dashboard/downloads/page.tsx`, add a **"Custom bundle"** builder beside
the existing quarter exports:

- **Scope** picker: This quarter · Date range · Show (dropdown of `show_group`s)
  · Selected episodes.
- **Include** checkboxes: Transcripts · VTT captions · MP3 audio.
- Submit → a row appears in a **Bundles** list with a live progress bar; on
  `ready` it becomes a Download button showing size + "expires in N days".

On `app/dashboard/episodes/page.tsx`, the existing bulk-action bar gains
**"Bundle selected (audio + transcript)"**, which POSTs the checked ids as
`{ episodeIds }`.

## 10. Migration & rollout

1. `0NN_download_jobs.sql`: create table, indexes (`station_id`,
   `requested_by`, `status`, `expires_at`), RLS policies via `user_station_ids()`.
2. Create the private `bundles` Storage bucket (Supabase) + lifecycle/cleanup
   cron (reuse the auto-retry cron cadence or a dedicated daily tick).
3. Add `archiver` (and the email provider SDK) to `package.json`.
4. Wire `bundleQueue` + worker registration; add the email helper.
5. Ship API routes + UI behind the existing auth.

## 11. Open decisions

- **Email provider**: Resend (simplest), AWS SES (cheap at volume), or plain
  SMTP via nodemailer (no new vendor). Affects creds/env + `lib/email.ts`.
- **Streaming target**: archive straight to the Storage upload stream vs. temp
  file then upload — depends on whether the Supabase upload needs a known
  content length and the VPS disk budget.
- **Caps**: exact max episode count / byte ceiling and the per-station active-job
  concurrency limit (proposed 200 / ~10 GB / 1 active).
- **Expiry window**: 7 days proposed for both the artifact and the signed-link
  reminder in email.
```
