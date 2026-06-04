import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export const GET = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

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
})

export const POST = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

    const contentType = request.headers.get('content-type') ?? ''

    // Bulk CSV import
    if (contentType.includes('text/csv')) {
      const csvText = await request.text()
      const lines = csvText.split('\n').filter((line) => line.trim())

      // Skip header if present
      const startIndex = lines[0]?.toLowerCase().includes('wrong') ? 1 : 0
      const corrections = []

      for (let i = startIndex; i < lines.length; i++) {
        const parts = lines[i].split(',').map((p) => p.trim().replace(/^"|"$/g, ''))
        if (parts.length >= 2) {
          corrections.push({
            station_id: stationId,
            wrong: parts[0],
            correct: parts[1],
            case_sensitive: parts[2]?.toLowerCase() === 'true',
            is_regex: parts[3]?.toLowerCase() === 'true',
            active: true,
            notes: parts[4] || null,
            episode_id: parts[5] ? parseInt(parts[5]) || null : null,
          })
        }
      }

      if (corrections.length === 0) {
        return NextResponse.json({ error: 'No valid corrections found in CSV' }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('transcript_corrections')
        .insert(corrections)
        .select()

      if (error) throw error
      return NextResponse.json({ corrections: data, count: data?.length ?? 0 }, { status: 201 })
    }

    // Single correction creation (JSON)
    const body = await request.json()

    // Bulk JSON import
    if (Array.isArray(body)) {
      const corrections = body.map((item) => ({
        station_id: stationId,
        wrong: item.wrong,
        correct: item.correct,
        case_sensitive: item.case_sensitive ?? false,
        is_regex: item.is_regex ?? false,
        active: true,
        notes: item.notes ?? null,
        episode_id: item.episode_id ?? null,
      }))

      const { data, error } = await supabase
        .from('transcript_corrections')
        .insert(corrections)
        .select()

      if (error) throw error
      return NextResponse.json({ corrections: data, count: data?.length ?? 0 }, { status: 201 })
    }

    const { wrong, correct, case_sensitive, is_regex, notes, episode_id } = body

    if (!wrong || !correct) {
      return NextResponse.json(
        { error: 'wrong and correct are required' },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('transcript_corrections')
      .insert({
        station_id: stationId,
        wrong,
        correct,
        case_sensitive: case_sensitive ?? false,
        is_regex: is_regex ?? false,
        active: true,
        notes: notes ?? null,
        episode_id: episode_id ?? null,
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ correction: data }, { status: 201 })
  } catch (err) {
    console.error('POST /api/corrections failed:', err)
    return NextResponse.json({ error: 'Failed to create correction' }, { status: 500 })
  }
}, { role: 'editor' })

export const PATCH = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

    const body = await request.json()
    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const { error } = await supabase
      .from('transcript_corrections')
      .update(updates)
      .eq('id', id)
      .eq('station_id', stationId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/corrections failed:', err)
    return NextResponse.json({ error: 'Failed to update correction' }, { status: 500 })
  }
}, { role: 'editor' })

export const DELETE = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

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
}, { role: 'editor' })
