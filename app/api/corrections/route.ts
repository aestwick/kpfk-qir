import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('transcript_corrections')
      .select('*')
      .order('created_at', { ascending: false })

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
    const body = await request.json()
    const { wrong, correct, case_sensitive, is_regex, notes } = body

    if (!wrong || !correct) {
      return NextResponse.json(
        { error: 'wrong and correct are required' },
        { status: 400 }
      )
    }

    const { data, error } = await supabaseAdmin
      .from('transcript_corrections')
      .insert({
        wrong,
        correct,
        case_sensitive: case_sensitive ?? false,
        is_regex: is_regex ?? false,
        active: true,
        notes: notes ?? null,
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
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('transcript_corrections')
      .update(updates)
      .eq('id', id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/corrections failed:', err)
    return NextResponse.json({ error: 'Failed to update correction' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('transcript_corrections')
      .delete()
      .eq('id', parseInt(id))

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/corrections failed:', err)
    return NextResponse.json({ error: 'Failed to delete correction' }, { status: 500 })
  }
}
