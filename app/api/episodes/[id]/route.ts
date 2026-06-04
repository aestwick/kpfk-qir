import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'
import { transcribeQueue, summarizeQueue } from '@/lib/queue'
import { parseMp3Url, dateFieldsFromUrl } from '@/lib/parse-mp3-url'
import { logAuditEvent, requestMeta, AUDIT_ACTIONS } from '@/lib/audit'

export const GET = withStationAuth(async (ctx, request, { params }: { params: { id: string } }) => {
  try {
    const { supabase, stationId } = ctx

    const episodeId = parseInt(params.id)

    // Fetch episode, transcript, and compliance flags in parallel.
    // transcripts/compliance_flags have no station_id, so scope them via the
    // episode_log!inner join filtered by station.
    const [episodeResult, transcriptResult, flagsResult] = await Promise.all([
      supabase
        .from('episode_log')
        .select('*')
        .eq('id', episodeId)
        .eq('station_id', stationId)
        .single(),
      supabase
        .from('transcripts')
        .select('*, episode_log!inner(station_id)')
        .eq('episode_id', episodeId)
        .eq('episode_log.station_id', stationId)
        .single(),
      supabase
        .from('compliance_flags')
        .select('*, episode_log!inner(station_id)')
        .eq('episode_id', episodeId)
        .eq('episode_log.station_id', stationId)
        .order('created_at', { ascending: false }),
    ])

    if (episodeResult.error || !episodeResult.data) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Selective read auditing (spec §6.1): log the episode-detail view, and a
    // transcript.read when this view actually surfaced the transcript text.
    const meta = requestMeta(request)
    void logAuditEvent({
      action: AUDIT_ACTIONS.EPISODE_READ,
      operation: 'read',
      actorId: ctx.userId,
      stationId,
      resourceType: 'episode',
      resourceId: episodeId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    if (transcriptResult.data) {
      void logAuditEvent({
        action: AUDIT_ACTIONS.TRANSCRIPT_READ,
        operation: 'read',
        actorId: ctx.userId,
        stationId,
        resourceType: 'transcript',
        resourceId: episodeId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
    }

    return NextResponse.json({
      episode: episodeResult.data,
      transcript: transcriptResult.data ?? null,
      complianceFlags: flagsResult.data ?? [],
    })
  } catch (err) {
    console.error('GET /api/episodes/[id] failed:', err)
    return NextResponse.json({ error: 'Failed to fetch episode' }, { status: 500 })
  }
})

export const PATCH = withStationAuth(async (ctx, request, { params }: { params: { id: string } }) => {
  try {
    const { supabase, stationId } = ctx

    const body = await request.json()
    const { action, ...updates } = body
    const episodeId = parseInt(params.id)

    // Confirm the episode belongs to the active station before any mutation or
    // job enqueue, so one station can't act on another's episode.
    const { data: owned, error: ownedError } = await supabase
      .from('episode_log')
      .select('id')
      .eq('id', episodeId)
      .eq('station_id', stationId)
      .maybeSingle()
    if (ownedError) {
      return NextResponse.json({ error: ownedError.message }, { status: 500 })
    }
    if (!owned) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (action === 're-transcribe') {
      await supabase
        .from('episode_log')
        .update({ status: 'pending', error_message: null, updated_at: new Date().toISOString() })
        .eq('id', episodeId)
        .eq('station_id', stationId)
      await transcribeQueue.add('re-transcribe', { episodeId, stationId })
      return NextResponse.json({ ok: true, message: 'Re-transcription queued' })
    }

    if (action === 're-summarize') {
      await supabase
        .from('episode_log')
        .update({ status: 'transcribed', error_message: null, updated_at: new Date().toISOString() })
        .eq('id', episodeId)
        .eq('station_id', stationId)
      await summarizeQueue.add('re-summarize', { episodeId, stationId })
      return NextResponse.json({ ok: true, message: 'Re-summarization queued' })
    }

    if (action === 'fix-dates') {
      const { data: ep } = await supabase
        .from('episode_log')
        .select('mp3_url, duration')
        .eq('id', episodeId)
        .eq('station_id', stationId)
        .single()
      if (!ep) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      // MP3 filename prefix is station-specific; default to 'kpfk' if unset.
      const { data: station } = await supabase
        .from('stations')
        .select('mp3_filename_prefix')
        .eq('id', stationId)
        .maybeSingle()
      const parsed = parseMp3Url(ep.mp3_url, station?.mp3_filename_prefix ?? 'kpfk')
      if (!parsed) return NextResponse.json({ error: 'Could not parse date from URL' }, { status: 400 })
      const fields = dateFieldsFromUrl(parsed, ep.duration)
      await supabase
        .from('episode_log')
        .update(fields)
        .eq('id', episodeId)
        .eq('station_id', stationId)
      return NextResponse.json({ ok: true, message: 'Dates updated from URL', ...fields })
    }

    if (action === 'retry') {
      await supabase
        .from('episode_log')
        .update({ status: 'pending', error_message: null, updated_at: new Date().toISOString() })
        .eq('id', episodeId)
        .eq('station_id', stationId)
      return NextResponse.json({ ok: true, message: 'Episode reset to pending' })
    }

    // Generic update (edit summary, issue_category, host, guest, etc.)
    const allowedFields = ['summary', 'issue_category', 'headline', 'host', 'guest', 'status', 'error_message', 'air_date', 'compliance_report']
    const safeUpdates: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        safeUpdates[key] = value
      }
    }

    if (Object.keys(safeUpdates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const { error } = await supabase
      .from('episode_log')
      .update(safeUpdates)
      .eq('id', episodeId)
      .eq('station_id', stationId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/episodes/[id] failed:', err)
    return NextResponse.json({ error: 'Failed to update episode' }, { status: 500 })
  }
}, { role: 'editor' })
