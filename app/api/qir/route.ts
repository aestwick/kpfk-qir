import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — list QIR drafts, optionally filtered by year/quarter
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const year = searchParams.get('year')
    const quarter = searchParams.get('quarter')

    let query = supabaseAdmin
      .from('qir_drafts')
      .select('*')
      .order('created_at', { ascending: false })

    if (year) query = query.eq('year', parseInt(year))
    if (quarter) query = query.eq('quarter', parseInt(quarter))

    const { data, error } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ drafts: data })
  } catch (err) {
    console.error('GET /api/qir failed:', err)
    return NextResponse.json({ error: 'Failed to fetch drafts' }, { status: 500 })
  }
}

// POST — generate a new QIR draft or finalize/un-finalize
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    if (body.action === 'generate') {
      const { year, quarter } = body
      if (!year || !quarter) {
        return NextResponse.json({ error: 'year and quarter required' }, { status: 400 })
      }

      // Import dynamically to avoid loading worker deps in API context
      const { processGenerateQir } = await import('@/workers/generate-qir')
      const result = await processGenerateQir({ data: { year, quarter } } as any)
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    console.error('POST /api/qir failed:', err)
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH — finalize or un-finalize a draft, or update curated entries
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, action } = body

    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 })
    }

    if (action === 'finalize') {
      // First un-finalize any existing final draft for this year/quarter
      const { data: draft } = await supabaseAdmin
        .from('qir_drafts')
        .select('year, quarter')
        .eq('id', id)
        .single()

      if (draft) {
        await supabaseAdmin
          .from('qir_drafts')
          .update({ status: 'draft' })
          .eq('year', draft.year)
          .eq('quarter', draft.quarter)
          .eq('status', 'final')
      }

      const { error } = await supabaseAdmin
        .from('qir_drafts')
        .update({ status: 'final', updated_at: new Date().toISOString() })
        .eq('id', id)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ ok: true, status: 'final' })
    }

    if (action === 'unfinalize') {
      const { error } = await supabaseAdmin
        .from('qir_drafts')
        .update({ status: 'draft', updated_at: new Date().toISOString() })
        .eq('id', id)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ ok: true, status: 'draft' })
    }

    if (action === 'update-entries') {
      const { curated_entries, curated_text } = body
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (curated_entries !== undefined) update.curated_entries = curated_entries
      if (curated_text !== undefined) update.curated_text = curated_text

      const { error } = await supabaseAdmin
        .from('qir_drafts')
        .update(update)
        .eq('id', id)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    console.error('PATCH /api/qir failed:', err)
    return NextResponse.json({ error: 'Failed to update draft' }, { status: 500 })
  }
}

// DELETE — remove a draft
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('qir_drafts')
      .delete()
      .eq('id', parseInt(id))
      .neq('status', 'final')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/qir failed:', err)
    return NextResponse.json({ error: 'Failed to delete draft' }, { status: 500 })
  }
}
