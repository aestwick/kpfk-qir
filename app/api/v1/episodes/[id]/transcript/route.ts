import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/v1/episodes/{id}/transcript — captions for one episode. This is the
// primary endpoint for the podcast-app use case.
//   ?format=vtt  → raw WebVTT (text/vtt), ready to drop into a <track>.
//   (default)    → JSON { transcript, vtt, language }.
//   ?lang=en     → English translation fields when available, else falls back.
// Requires the 'transcripts' scope. Long-cached: transcripts are immutable once
// produced, so the strong ETag makes repeat pulls a cheap 304.
export const GET = withApiKey(
  async (request, { ctx, params }) => {
    const id = parseInt(params.id)
    if (isNaN(id)) return { json: { error: 'Invalid episode id' }, status: 400 }

    // Inner-join episode_log so the station_id filter scopes the transcript
    // (transcripts has no station_id of its own).
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select('transcript, vtt, language, english_transcript, english_vtt, episode_log!inner(station_id)')
      .eq('episode_id', id)
      .eq('episode_log.station_id', ctx.stationId)
      .maybeSingle()

    if (error) return { json: { error: error.message }, status: 500 }
    if (!data) return { json: { error: 'Transcript not found' }, status: 404 }

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
        episode_id: id,
        language: data.language,
        transcript: text,
        vtt,
      },
    }
  },
  { scope: 'transcripts', cache: { resource: 'transcripts', ttlSec: 3600 } },
)
