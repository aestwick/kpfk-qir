import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { splitPersonNames } from '@/lib/transcription/names'
import { validShowKey } from '@/lib/corrections-api'

export const dynamic = 'force-dynamic'

// Per-show name list ("vocabulary"): the correct spellings of each show's hosts
// and regulars. Feeds the Whisper spelling hint (talk shows, when the station
// turns it on) and the nightly suggested-corrections miner. show_key null =
// station-wide terms (call letters). Names are switched off, not deleted, when
// they came from the website, so the nightly CMS sync doesn't bring them back.

export async function GET(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const { supabase, stationId } = result.context

  const { data, error } = await supabase
    .from('transcript_vocabulary')
    .select('id, show_key, name, source, active, notes, created_at')
    .eq('station_id', stationId)
    .order('show_key', { ascending: true, nullsFirst: true })
    .order('name', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ names: data ?? [] })
}

// Body: { show_key: string | null, names: string }  — names may be a list
// ("Harvey Wasserman & Kevin Kamps, Myla Reson"); each becomes a row.
export async function POST(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const { supabase, stationId } = result.context
  const denied = requireRole(result.context, 'editor')
  if (denied) return stationErrorResponse(denied)

  const body = await request.json().catch(() => ({}))
  const show = await validShowKey(supabase, stationId, body.show_key)
  if (!show.ok) return NextResponse.json({ error: show.error }, { status: 400 })
  // Station-wide terms are often call letters ("KPFK") — keep them verbatim.
  const names = show.value
    ? splitPersonNames(String(body.names ?? ''))
    : String(body.names ?? '').split(',').map((n) => n.trim()).filter((n) => n.length >= 2)
  if (!names.length) return NextResponse.json({ error: 'No usable names' }, { status: 400 })

  const base = supabase.from('transcript_vocabulary').select('id, name, active').eq('station_id', stationId)
  const { data: existing } = await (show.value ? base.eq('show_key', show.value) : base.is('show_key', null))
  const byLower = new Map((existing ?? []).map((v) => [v.name.toLowerCase(), v]))

  let added = 0
  let reactivated = 0
  for (const name of names) {
    const prior = byLower.get(name.toLowerCase())
    if (prior) {
      if (!prior.active) {
        await supabase.from('transcript_vocabulary').update({ active: true, updated_at: new Date().toISOString() }).eq('id', prior.id).eq('station_id', stationId)
        reactivated++
      }
      continue
    }
    const { error } = await supabase
      .from('transcript_vocabulary')
      .insert({ station_id: stationId, show_key: show.value, name, source: 'manual' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    added++
  }
  return NextResponse.json({ added, reactivated }, { status: 201 })
}

// Body: { id, active?: boolean, name?: string }
export async function PATCH(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const { supabase, stationId } = result.context
  const denied = requireRole(result.context, 'editor')
  if (denied) return stationErrorResponse(denied)

  const body = await request.json().catch(() => ({}))
  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body.active === 'boolean') updates.active = body.active
  if (typeof body.name === 'string') {
    const name = body.name.replace(/\s+/g, ' ').trim()
    if (name.length < 2 || name.length > 80) return NextResponse.json({ error: 'Name must be 2–80 characters' }, { status: 400 })
    updates.name = name
  }
  const { error } = await supabase
    .from('transcript_vocabulary')
    .update(updates)
    .eq('id', body.id)
    .eq('station_id', stationId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const { supabase, stationId } = result.context
  const denied = requireRole(result.context, 'editor')
  if (denied) return stationErrorResponse(denied)

  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const { error } = await supabase
    .from('transcript_vocabulary')
    .delete()
    .eq('id', parseInt(id))
    .eq('station_id', stationId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
