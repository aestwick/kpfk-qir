import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { buildVariantRule, correctionError } from '@/lib/transcription/corrections'
import { queueCorrectionsBackfill } from '@/lib/corrections-api'

export const dynamic = 'force-dynamic'

// Suggested corrections from the nightly miner (workers/corrections.ts). They
// never touch a transcript on their own: Approve creates a real rule (scoped to
// the show by default, or station-wide), which is then re-applied to stored
// transcripts. Reject keeps the row so the same suggestion never returns.

export async function GET(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const { supabase, stationId } = result.context

  const status = new URL(request.url).searchParams.get('status') ?? 'suggested'
  if (!['suggested', 'approved', 'rejected'].includes(status)) {
    return NextResponse.json({ error: 'status must be suggested, approved or rejected' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('transcript_correction_suggestions')
    .select('*')
    .eq('station_id', stationId)
    .eq('status', status)
    .order('occurrences', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ suggestions: data ?? [] })
}

// Body: { id, action: 'approve' | 'reject', scope?: 'show' | 'station', correct?: string }
export async function PATCH(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const { supabase, stationId, userId } = result.context
  const denied = requireRole(result.context, 'editor')
  if (denied) return stationErrorResponse(denied)

  const body = await request.json().catch(() => ({}))
  if (!body.id || !['approve', 'reject'].includes(body.action)) {
    return NextResponse.json({ error: 'id and action (approve|reject) are required' }, { status: 400 })
  }

  const { data: s, error: sErr } = await supabase
    .from('transcript_correction_suggestions')
    .select('*')
    .eq('id', body.id)
    .eq('station_id', stationId)
    .maybeSingle()
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
  if (!s) return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 })
  if (s.status !== 'suggested') return NextResponse.json({ error: `Already ${s.status}` }, { status: 409 })

  const decided = { decided_at: new Date().toISOString(), decided_by: userId }

  if (body.action === 'reject') {
    const { error } = await supabase
      .from('transcript_correction_suggestions')
      .update({ status: 'rejected', ...decided })
      .eq('id', s.id)
      .eq('station_id', stationId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const correct = typeof body.correct === 'string' && body.correct.trim() ? body.correct.trim() : s.correct
  const rule = buildVariantRule(s.variant, correct)
  const err = correctionError(rule)
  if (err) return NextResponse.json({ error: err }, { status: 400 })

  // Claim the suggestion first (only while still 'suggested'), so a double
  // click or a unique-index clash can't leave a rule behind with the
  // suggestion still pending — the next approve would create a duplicate.
  const { data: claimed, error: claimErr } = await supabase
    .from('transcript_correction_suggestions')
    .update({ status: 'approved', correct, ...decided })
    .eq('id', s.id)
    .eq('station_id', stationId)
    .eq('status', 'suggested')
    .select('id')
  if (claimErr) return NextResponse.json({ error: claimErr.message }, { status: 409 })
  if (!claimed?.length) return NextResponse.json({ error: 'Already decided' }, { status: 409 })

  const { data: created, error: cErr } = await supabase
    .from('transcript_corrections')
    .insert({
      station_id: stationId,
      wrong: rule.wrong,
      correct: rule.correct,
      case_sensitive: rule.caseSensitive,
      is_regex: rule.isRegex,
      active: true,
      show_key: body.scope === 'station' ? null : s.show_key,
      notes: `Approved suggestion: "${s.variant}" seen ${s.occurrences}× in ${s.episodes} episode(s)`,
    })
    .select('id')
    .single()
  if (cErr) {
    await supabase
      .from('transcript_correction_suggestions')
      .update({ status: 'suggested', correct: s.correct, decided_at: null, decided_by: null })
      .eq('id', s.id)
      .eq('station_id', stationId)
    return NextResponse.json({ error: cErr.message }, { status: 500 })
  }

  await supabase
    .from('transcript_correction_suggestions')
    .update({ correction_id: created.id })
    .eq('id', s.id)
    .eq('station_id', stationId)

  queueCorrectionsBackfill(stationId)
  return NextResponse.json({ ok: true, correctionId: created.id })
}
