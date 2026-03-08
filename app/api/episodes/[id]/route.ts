import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { transcribeQueue, summarizeQueue } from '@/lib/queue'

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const episodeId = parseInt(params.id)

    // Fetch episode, transcript, and compliance flags in parallel
    const [episodeResult, transcriptResult, flagsResult] = await Promise.all([
      supabaseAdmin
        .from('episode_log')
        .select('*')
        .eq('id', episodeId)
        .single(),
      supabaseAdmin
        .from('transcripts')
        .select('*')
        .eq('episode_id', episodeId)
        .single(),
      supabaseAdmin
        .from('compliance_flags')
        .select('*')
        .eq('episode_id', episodeId)
        .order('created_at', { ascending: false }),
    ])

    if (episodeResult.error || !episodeResult.data) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
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
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json()
    const { action, ...updates } = body
    const episodeId = parseInt(params.id)

    if (action === 're-transcribe') {
      await supabaseAdmin
        .from('episode_log')
        .update({ status: 'pending', error_message: null })
        .eq('id', episodeId)
      await transcribeQueue.add('re-transcribe', { episodeId })
      return NextResponse.json({ ok: true, message: 'Re-transcription queued' })
    }

    if (action === 're-summarize') {
      await supabaseAdmin
        .from('episode_log')
        .update({ status: 'transcribed', error_message: null })
        .eq('id', episodeId)
      await summarizeQueue.add('re-summarize', { episodeId })
      return NextResponse.json({ ok: true, message: 'Re-summarization queued' })
    }

    if (action === 'retry') {
      await supabaseAdmin
        .from('episode_log')
        .update({ status: 'pending', error_message: null })
        .eq('id', episodeId)
      return NextResponse.json({ ok: true, message: 'Episode reset to pending' })
    }

    // Generic update (edit summary, issue_category, host, guest, etc.)
    const allowedFields = ['summary', 'issue_category', 'headline', 'host', 'guest', 'status', 'error_message']
    const safeUpdates: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        safeUpdates[key] = value
      }
    }

    if (Object.keys(safeUpdates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('episode_log')
      .update(safeUpdates)
      .eq('id', episodeId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/episodes/[id] failed:', err)
    return NextResponse.json({ error: 'Failed to update episode' }, { status: 500 })
  }
}
