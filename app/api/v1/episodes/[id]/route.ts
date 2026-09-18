import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'
import { resolveEpisodeRef, projectEpisode, PUBLISHED_STATUSES } from '@/lib/episode-feed'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SELECT =
  'public_id, id, show_key, show_name, category, issue_category, title, headline, host, guest, summary, ' +
  'air_date, air_start, air_end, date, start_time, end_time, duration, status, mp3_url, ' +
  'transcript_url, compliance_status, created_at, updated_at'

// GET /api/v1/episodes/{id} — full metadata for one PUBLISHED episode. {id} is
// the opaque public_id uuid from the feed; the legacy integer row id is still
// accepted so links already issued keep resolving.
//
// The published gate (PUBLISHED_STATUSES) is enforced here, not only on the
// feed. Without it the contract held on the list and leaked on the item: the
// integer id is sequential, so a caller could walk it and read metadata for
// every pending/failed/unavailable episode the feed deliberately hides.
// An unpublished episode returns the SAME 404 as one that does not exist —
// distinguishing them would confirm the row exists. With ?include=transcript the transcript/
// VTT is embedded too, but only if the key also holds the 'transcripts' scope
// (otherwise the include is silently omitted).
export const GET = withApiKey(
  async (request, { ctx, params }) => {
    const ref = resolveEpisodeRef(params.id)
    if (!ref) return { json: { error: 'Invalid episode id' }, status: 400 }

    const { data: episode, error } = await supabaseAdmin
      .from('episode_log')
      .select(SELECT)
      .eq(ref.column, ref.value)
      .eq('station_id', ctx.stationId)
      .in('status', [...PUBLISHED_STATUSES])
      .maybeSingle()

    if (error) return { json: { error: error.message }, status: 500 }
    if (!episode) return { json: { error: 'Episode not found' }, status: 404 }

    const payload: Record<string, unknown> = { episode: projectEpisode(episode as unknown as Record<string, unknown>) }

    const wantsTranscript = request.nextUrl.searchParams.get('include') === 'transcript'
    if (wantsTranscript && ctx.scopes.includes('transcripts')) {
      const { data: t } = await supabaseAdmin
        .from('transcripts')
        .select('transcript, vtt, language, english_transcript, english_vtt')
        .eq('episode_id', (episode as unknown as { id: number }).id)
        .maybeSingle()
      payload.transcript = t ?? null
    }

    return { json: payload }
  },
  {
    scope: 'episodes',
    // This body depends on the CALLING KEY, not just on station + params: with
    // ?include=transcript the transcript is embedded only for a key holding the
    // 'transcripts' scope. Cache entries are shared across a station's keys, so
    // without this discriminator a key holding the scope warms the entry and a
    // key without it receives the captions on a cache HIT — a scope bypass.
    cache: {
      resource: 'episodes',
      ttlSec: 300,
      vary: (ctx) => (ctx.scopes.includes('transcripts') ? 'transcripts' : ''),
    },
  },
)
