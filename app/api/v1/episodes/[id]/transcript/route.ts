import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'
import { resolveEpisodeRef, PUBLISHED_STATUSES } from '@/lib/episode-feed'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/v1/episodes/{id}/transcript — captions for one PUBLISHED episode.
// This is the primary endpoint for the podcast-app use case. {id} is the opaque
// public_id uuid from the feed (the legacy integer row id still resolves).
//
// Published-gated like the detail route: most transcripts in the table belong to
// episodes the feed does not list (transcribed but not yet summarized, or
// failed), and the sequential integer id made them walkable. Unpublished →
// the same 404 as no transcript at all.
//   ?format=vtt  → raw WebVTT (text/vtt), ready to drop into a <track>.
//   (default)    → JSON { transcript, vtt, language }.
//   ?lang=en     → English translation fields when available, else falls back.
// Requires the 'transcripts' scope. Long-cached: transcripts are immutable once
// produced, so the strong ETag makes repeat pulls a cheap 304.
export const GET = withApiKey(
  async (request, { ctx, params }) => {
    const ref = resolveEpisodeRef(params.id)
    if (!ref) return { json: { error: 'Invalid episode id' }, status: 400 }

    // Inner-join episode_log so the station_id filter scopes the transcript
    // (transcripts has no station_id of its own) and so a public_id reference
    // resolves in the same round trip.
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select(
        'transcript, vtt, language, english_transcript, english_vtt, episode_log!inner(id, public_id, station_id, status)',
      )
      .eq(ref.column === 'id' ? 'episode_id' : 'episode_log.public_id', ref.value)
      .eq('episode_log.station_id', ctx.stationId)
      .in('episode_log.status', [...PUBLISHED_STATUSES])
      .maybeSingle()

    if (error) return { json: { error: error.message }, status: 500 }
    if (!data) return { json: { error: 'Transcript not found' }, status: 404 }

    const episode = (data as unknown as { episode_log: { id: number; public_id: string } }).episode_log

    const sp = request.nextUrl.searchParams
    const wantEnglish = sp.get('lang') === 'en'
    const text = wantEnglish ? data.english_transcript ?? data.transcript : data.transcript
    const vtt = wantEnglish ? data.english_vtt ?? data.vtt : data.vtt

    if (sp.get('format') === 'vtt') {
      if (!vtt) return { json: { error: 'No VTT captions for this episode' }, status: 404 }
      return { body: vtt, contentType: 'text/vtt; charset=utf-8' }
    }

    return {
      json: {
        episode_public_id: episode?.public_id ?? null,
        episode_id: episode?.id ?? null,
        language: data.language,
        transcript: text,
        vtt,
      },
    }
  },
  { scope: 'transcripts', cache: { resource: 'transcripts', ttlSec: 3600 } },
)
