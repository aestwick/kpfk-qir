import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { transcribeQueue, summarizeQueue } from '@/lib/queue'

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { data: episode, error } = await supabaseAdmin
      .from('episode_log')
      .select('*')
      .eq('id', parseInt(params.id))
      .single()

    if (error || !episode) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Also fetch transcript if it exists
    const { data: transcript } = await supabaseAdmin
      .from('transcripts')
      .select('*')
      .eq('episode_id', episode.id)
      .single()

    return NextResponse.json({ episode, transcript })
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

    // Generic update (edit summary, issue_category, etc.)
    const { error } = await supabaseAdmin
      .from('episode_log')
      .update(updates)
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
