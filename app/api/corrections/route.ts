import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { correctionError } from '@/lib/transcription/corrections'
import { queueCorrectionsBackfill, validShowKey } from '@/lib/corrections-api'

export const dynamic = 'force-dynamic'

// Transcript correction rules. A rule applies station-wide, to one show (every
// feed in its show group — `show_key`), or to one episode (`episode_id`). Every
// create/edit clears `backfilled_at`, which queues the rule to be re-applied to
// transcripts already stored (workers/corrections.ts) — text only, no audio.

// Fields a client may write. Anything else in the body (station_id,
// backfilled_at, id…) is ignored.
const EDITABLE = ['wrong', 'correct', 'case_sensitive', 'is_regex', 'notes', 'active', 'episode_id', 'show_key'] as const
// Changing any of these changes what the rule does to text → re-apply it.
const BEHAVIOR = new Set(['wrong', 'correct', 'case_sensitive', 'is_regex', 'episode_id', 'show_key', 'active'])

interface RuleInput {
  wrong?: string
  correct?: string
  case_sensitive?: boolean
  is_regex?: boolean
  notes?: string | null
  episode_id?: number | null
  show_key?: string | null
}

export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)
    const scope = searchParams.get('scope')
    const episodeId = searchParams.get('episode_id')

    let query = supabase
      .from('transcript_corrections')
      .select('*')
      .eq('station_id', stationId)
      .order('created_at', { ascending: false })

    // Filter by scope: 'global' for non-episode-specific, 'episode' for episode-specific
    if (scope === 'global') {
      query = query.is('episode_id', null)
    } else if (scope === 'episode' && episodeId) {
      query = query.eq('episode_id', parseInt(episodeId))
    }

    const { data, error } = await query
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ corrections: data })
  } catch (err) {
    console.error('GET /api/corrections failed:', err)
    return NextResponse.json({ error: 'Failed to fetch corrections' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const contentType = request.headers.get('content-type') ?? ''

    // Rows from CSV (wrong, correct, case_sensitive, is_regex, notes, episode_id, show_key)
    // or a JSON array/object — all validated the same way below.
    let inputs: RuleInput[]
    let single = false
    if (contentType.includes('text/csv')) {
      const csvText = await request.text()
      const lines = csvText.split('\n').filter((line) => line.trim())
      const startIndex = lines[0]?.toLowerCase().includes('wrong') ? 1 : 0
      inputs = []
      for (let i = startIndex; i < lines.length; i++) {
        const parts = lines[i].split(',').map((p) => p.trim().replace(/^"|"$/g, ''))
        if (parts.length < 2) continue
        inputs.push({
          wrong: parts[0],
          correct: parts[1],
          case_sensitive: parts[2]?.toLowerCase() === 'true',
          is_regex: parts[3]?.toLowerCase() === 'true',
          notes: parts[4] || null,
          episode_id: parts[5] ? parseInt(parts[5]) || null : null,
          show_key: parts[6] || null,
        })
      }
      if (!inputs.length) {
        return NextResponse.json({ error: 'No valid corrections found in CSV' }, { status: 400 })
      }
    } else {
      const body = await request.json()
      single = !Array.isArray(body)
      inputs = single ? [body] : body
    }

    const rows = []
    for (let i = 0; i < inputs.length; i++) {
      const item = inputs[i]
      const label = inputs.length > 1 ? `Row ${i + 1}: ` : ''
      const err = correctionError({ wrong: item.wrong ?? '', correct: item.correct ?? '', isRegex: !!item.is_regex })
      if (err) return NextResponse.json({ error: label + err }, { status: 400 })
      const show = await validShowKey(supabase, stationId, item.show_key)
      if (!show.ok) return NextResponse.json({ error: label + show.error }, { status: 400 })
      rows.push({
        station_id: stationId,
        wrong: item.wrong,
        correct: item.correct,
        case_sensitive: item.case_sensitive ?? false,
        is_regex: item.is_regex ?? false,
        active: true,
        notes: item.notes ?? null,
        episode_id: item.episode_id ?? null,
        show_key: show.value,
      })
    }

    const { data, error } = await supabase.from('transcript_corrections').insert(rows).select()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    queueCorrectionsBackfill(stationId)

    if (single) return NextResponse.json({ correction: data?.[0] }, { status: 201 })
    return NextResponse.json({ corrections: data, count: data?.length ?? 0 }, { status: 201 })
  } catch (err) {
    console.error('POST /api/corrections failed:', err)
    return NextResponse.json({ error: 'Failed to create correction' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const body = await request.json()
    const { id } = body
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const updates: Record<string, unknown> = {}
    for (const field of EDITABLE) {
      if (field in body) updates[field] = body[field]
    }
    if (!Object.keys(updates).length) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data: current, error: curErr } = await supabase
      .from('transcript_corrections')
      .select('*')
      .eq('id', id)
      .eq('station_id', stationId)
      .maybeSingle()
    if (curErr) return NextResponse.json({ error: curErr.message }, { status: 500 })
    if (!current) return NextResponse.json({ error: 'Correction not found' }, { status: 404 })

    const merged = { ...current, ...updates }
    const err = correctionError({ wrong: merged.wrong, correct: merged.correct, isRegex: !!merged.is_regex })
    if (err) return NextResponse.json({ error: err }, { status: 400 })
    if ('show_key' in updates) {
      const show = await validShowKey(supabase, stationId, updates.show_key)
      if (!show.ok) return NextResponse.json({ error: show.error }, { status: 400 })
      updates.show_key = show.value
    }

    // Behavior changed (or the rule was switched back on) → apply it to stored
    // transcripts again. Switching a rule OFF doesn't undo past fixes.
    const behaviorChanged = Object.keys(updates).some(
      (k) => BEHAVIOR.has(k) && updates[k] !== current[k] && !(k === 'active' && updates[k] === false),
    )
    if (behaviorChanged) updates.backfilled_at = null

    const { error } = await supabase
      .from('transcript_corrections')
      .update(updates)
      .eq('id', id)
      .eq('station_id', stationId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (behaviorChanged && merged.active) queueCorrectionsBackfill(stationId)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/corrections failed:', err)
    return NextResponse.json({ error: 'Failed to update correction' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const { error } = await supabase
      .from('transcript_corrections')
      .delete()
      .eq('id', parseInt(id))
      .eq('station_id', stationId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/corrections failed:', err)
    return NextResponse.json({ error: 'Failed to delete correction' }, { status: 500 })
  }
}
