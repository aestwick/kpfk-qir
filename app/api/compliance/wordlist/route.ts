import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { data, error } = await supabase
      .from('compliance_wordlist')
      .select('*')
      .eq('station_id', stationId)
      .order('word', { ascending: true })

    if (error) throw error
    return NextResponse.json({ words: data })
  } catch (err) {
    console.error('GET /api/compliance/wordlist failed:', err)
    return NextResponse.json({ error: 'Failed to fetch wordlist' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const body = await request.json()
    const { word, severity } = body

    if (!word?.trim()) return NextResponse.json({ error: 'word required' }, { status: 400 })

    const { error } = await supabase
      .from('compliance_wordlist')
      .insert({ station_id: stationId, word: word.trim().toLowerCase(), severity: severity || 'critical' })

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('POST /api/compliance/wordlist failed:', err)
    return NextResponse.json({ error: 'Failed to add word' }, { status: 500 })
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
    const { id, ...updates } = body

    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const { error } = await supabase
      .from('compliance_wordlist')
      .update(updates)
      .eq('id', id)
      .eq('station_id', stationId)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/compliance/wordlist failed:', err)
    return NextResponse.json({ error: 'Failed to update word' }, { status: 500 })
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

    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const { error } = await supabase
      .from('compliance_wordlist')
      .delete()
      .eq('id', parseInt(id))
      .eq('station_id', stationId)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/compliance/wordlist failed:', err)
    return NextResponse.json({ error: 'Failed to delete word' }, { status: 500 })
  }
}
