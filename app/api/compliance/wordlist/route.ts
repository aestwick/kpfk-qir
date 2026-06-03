import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Two-layer wordlist: a GLOBAL base (station_id IS NULL, super-admin managed,
// applies to every station) plus this station's own additions. GET returns both;
// writing a global-base row requires super-admin, a station row requires editor.

export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    // This station's rows + the global base (never other stations' rows, even for
    // a super-admin whose RLS scope is all stations).
    const { data, error } = await supabase
      .from('compliance_wordlist')
      .select('*')
      .or(`station_id.eq.${stationId},station_id.is.null`)
      .order('word', { ascending: true })

    if (error) throw error
    return NextResponse.json({ words: data, isSuperAdmin: result.context.isSuperAdmin })
  } catch (err) {
    console.error('GET /api/compliance/wordlist failed:', err)
    return NextResponse.json({ error: 'Failed to fetch wordlist' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId, isSuperAdmin } = result.context

    const body = await request.json()
    const { word, severity, scope } = body
    if (!word?.trim()) return NextResponse.json({ error: 'word required' }, { status: 400 })

    // Global-base term applies to every station — super-admin only. Otherwise it's
    // a per-station addition (editor+).
    const global = scope === 'global'
    if (global) {
      if (!isSuperAdmin) {
        return stationErrorResponse({ status: 403, error: 'Only a super-admin can edit the global compliance wordlist' })
      }
    } else {
      const denied = requireRole(result.context, 'editor')
      if (denied) return stationErrorResponse(denied)
    }

    const { error } = await supabase
      .from('compliance_wordlist')
      .insert({
        station_id: global ? null : stationId,
        word: word.trim().toLowerCase(),
        severity: severity || 'critical',
      })

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
    const { supabase, stationId, isSuperAdmin } = result.context

    const body = await request.json()
    const { id, ...updates } = body
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    // Super-admins may edit any row (incl. the global base); station editors only
    // their own station's rows (the station_id filter excludes global rows). RLS
    // is the backstop on both paths.
    let query = supabase.from('compliance_wordlist').update(updates).eq('id', id)
    if (!isSuperAdmin) {
      const denied = requireRole(result.context, 'editor')
      if (denied) return stationErrorResponse(denied)
      query = query.eq('station_id', stationId)
    }
    const { error } = await query

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
    const { supabase, stationId, isSuperAdmin } = result.context

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    let query = supabase.from('compliance_wordlist').delete().eq('id', parseInt(id))
    if (!isSuperAdmin) {
      const denied = requireRole(result.context, 'editor')
      if (denied) return stationErrorResponse(denied)
      query = query.eq('station_id', stationId)
    }
    const { error } = await query

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/compliance/wordlist failed:', err)
    return NextResponse.json({ error: 'Failed to delete word' }, { status: 500 })
  }
}
