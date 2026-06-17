import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SELECT =
  'id, show_key, show_name, category, issue_category, title, headline, host, guest, summary, ' +
  'air_date, air_start, air_end, date, start_time, end_time, duration, status, mp3_url, ' +
  'transcript_url, compliance_status, created_at, updated_at'

// GET /api/v1/episodes/{id} — full metadata for one episode. With
// ?include=transcript the transcript/VTT is embedded too, but only if the key
// also holds the 'transcripts' scope (otherwise the include is silently omitted).
export const GET = withApiKey(
  async (request, { ctx, params }) => {
    const id = parseInt(params.id)
    if (isNaN(id)) return { json: { error: 'Invalid episode id' }, status: 400 }

    const { data: episode, error } = await supabaseAdmin
      .from('episode_log')
      .select(SELECT)
      .eq('id', id)
      .eq('station_id', ctx.stationId)
      .maybeSingle()

    if (error) return { json: { error: error.message }, status: 500 }
    if (!episode) return { json: { error: 'Episode not found' }, status: 404 }

    const payload: Record<string, unknown> = { episode }

    const wantsTranscript = request.nextUrl.searchParams.get('include') === 'transcript'
    if (wantsTranscript && ctx.scopes.includes('transcripts')) {
      const { data: t } = await supabaseAdmin
        .from('transcripts')
        .select('transcript, vtt, language, english_transcript, english_vtt')
        .eq('episode_id', id)
        .maybeSingle()
      payload.transcript = t ?? null
    }

    return { json: payload }
  },
  { scope: 'episodes', cache: { resource: 'episodes', ttlSec: 300 } },
)
