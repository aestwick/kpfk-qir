import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'
import { transcribeQueue } from '@/lib/queue'
import { jobPriority } from '@/lib/tier'
import { parseMp3Url, dateFieldsFromUrl } from '@/lib/parse-mp3-url'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ===========================================================================
// POST /api/v1/transcribe — on-demand transcription requested by a sibling KPFK
// app (e.g. the CMS). Keyed by mp3_url (globally unique on episode_log), so the
// caller need not know our episode id: we find-or-create the episode, enqueue a
// TARGETED transcribe job (workers/transcribe.ts#runTargetedTranscribe), and the
// existing write-path lands the transcript in the `transcripts` table — the same
// table + format the CMS already reads (cms_episode_resolved.has_captions).
//
// Async by design: returns 202 immediately. Poll GET /api/v1/transcribe?mp3_url=
// (or read transcripts/cms_episode_resolved directly) for completion.
//
// Transcription only — these requests do NOT auto-chain into summarize/compliance
// (the job omits source:'chain'), so they incur no GPT cost and don't enter QIR's
// reporting pipeline. Requires the opt-in WRITE scope `transcribe`.
// ===========================================================================

const MAX_URL_LEN = 2048

async function enqueue(stationId: string, episodeId: number): Promise<void> {
  await transcribeQueue.add(
    'cms-transcribe',
    { stationId, episodeIds: [episodeId], source: 'cms' },
    { priority: await jobPriority(stationId) },
  )
}

export const POST = withApiKey(
  async (request: NextRequest, { ctx }) => {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return { json: { error: 'JSON body required' }, status: 400 }
    }

    const mp3Url = typeof body.mp3_url === 'string' ? body.mp3_url.trim() : ''
    if (!mp3Url || !/^https?:\/\//i.test(mp3Url) || mp3Url.length > MAX_URL_LEN) {
      return { json: { error: 'mp3_url (absolute http/https URL) is required' }, status: 400 }
    }
    const force = body.force === true
    const requestedShowKey =
      typeof body.show_key === 'string' && body.show_key.trim() ? body.show_key.trim() : null

    // Find the episode by URL. mp3_url is globally unique, so a row could in
    // principle belong to another station — refuse to act across the tenant line.
    const { data: existing, error: lookupErr } = await supabaseAdmin
      .from('episode_log')
      .select('id, station_id, status')
      .eq('mp3_url', mp3Url)
      .maybeSingle()
    if (lookupErr) return { json: { error: lookupErr.message }, status: 500 }
    if (existing && existing.station_id !== ctx.stationId) {
      return { json: { error: 'mp3_url belongs to a different station' }, status: 409 }
    }

    if (existing) {
      // Already transcribed? Idempotent no-op unless force — this absorbs the race
      // where the CMS and our own hourly ingest both ask for the same episode.
      if (!force) {
        const { count } = await supabaseAdmin
          .from('transcripts')
          .select('episode_id', { count: 'exact', head: true })
          .eq('episode_id', existing.id)
        if ((count ?? 0) > 0) {
          return {
            json: { episode_id: existing.id, status: existing.status, queued: false, message: 'transcript already exists' },
          }
        }
      }
      // Reset to pending so the worker's atomic claim guard fires (covers a prior
      // failed/unavailable/transcribing row and the force re-transcribe case).
      const { error: resetErr } = await supabaseAdmin
        .from('episode_log')
        .update({ status: 'pending', error_message: null, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .eq('station_id', ctx.stationId)
      if (resetErr) return { json: { error: resetErr.message }, status: 500 }

      await enqueue(ctx.stationId, existing.id)
      return { json: { episode_id: existing.id, status: 'queued', queued: true }, status: 202 }
    }

    // No episode yet — create one as pending. show_key is NOT NULL: take the
    // caller's, else derive it (+ air date/time) from the archive filename
    // convention. If neither is available, reject rather than insert a junk key.
    const { data: station } = await supabaseAdmin
      .from('stations')
      .select('mp3_filename_prefix')
      .eq('id', ctx.stationId)
      .maybeSingle()
    const parsed = parseMp3Url(mp3Url, station?.mp3_filename_prefix ?? 'kpfk')
    const showKey = requestedShowKey ?? parsed?.showKey ?? null
    if (!showKey) {
      return {
        json: { error: 'show_key is required (could not derive it from the mp3_url filename)' },
        status: 400,
      }
    }
    const dateFields = parsed ? dateFieldsFromUrl(parsed, null) : null

    const { data: created, error: insErr } = await supabaseAdmin
      .from('episode_log')
      .insert({
        station_id: ctx.stationId,
        show_key: showKey,
        mp3_url: mp3Url,
        status: 'pending',
        ingest_source: 'cms',
        duration: null,
        ...(dateFields
          ? {
              air_date: dateFields.air_date,
              air_start: dateFields.air_start,
              air_end: dateFields.air_end,
              date: dateFields.date,
              start_time: dateFields.start_time,
              end_time: dateFields.end_time,
            }
          : {}),
      })
      .select('id')
      .single()

    // Lost a create race on the unique mp3_url — re-fetch and queue that row.
    if (insErr) {
      if (insErr.code === '23505') {
        const { data: raced } = await supabaseAdmin
          .from('episode_log')
          .select('id')
          .eq('mp3_url', mp3Url)
          .eq('station_id', ctx.stationId)
          .maybeSingle()
        if (raced) {
          await enqueue(ctx.stationId, raced.id)
          return { json: { episode_id: raced.id, status: 'queued', queued: true }, status: 202 }
        }
      }
      return { json: { error: insErr.message }, status: 500 }
    }

    await enqueue(ctx.stationId, created.id)
    return { json: { episode_id: created.id, status: 'queued', queued: true }, status: 202 }
  },
  { scope: 'transcribe' },
)

// GET /api/v1/transcribe?mp3_url= — status probe for a previously-requested URL,
// so the caller can poll over HTTP instead of querying the shared DB. Uncached
// (status is volatile). Returns the episode's pipeline status + whether a
// transcript row exists yet.
export const GET = withApiKey(
  async (request: NextRequest, { ctx }) => {
    const mp3Url = request.nextUrl.searchParams.get('mp3_url')?.trim()
    if (!mp3Url) return { json: { error: 'mp3_url query param is required' }, status: 400 }

    const { data: ep, error } = await supabaseAdmin
      .from('episode_log')
      .select('id, status')
      .eq('station_id', ctx.stationId)
      .eq('mp3_url', mp3Url)
      .maybeSingle()
    if (error) return { json: { error: error.message }, status: 500 }
    if (!ep) return { json: { found: false }, status: 404 }

    const { count } = await supabaseAdmin
      .from('transcripts')
      .select('episode_id', { count: 'exact', head: true })
      .eq('episode_id', ep.id)

    return {
      json: { found: true, episode_id: ep.id, status: ep.status, has_transcript: (count ?? 0) > 0 },
    }
  },
  { scope: 'transcribe' },
)
