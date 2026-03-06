import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('qir_settings')
      .select('*')
      .order('key')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const settings: Record<string, unknown> = {}
    for (const row of data ?? []) {
      settings[row.key] = row.value
    }

    return NextResponse.json({ settings, rows: data })
  } catch (err) {
    console.error('GET /api/settings failed:', err)
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { key, value } = body

    if (!key) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('qir_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PUT /api/settings failed:', err)
    return NextResponse.json({ error: 'Failed to save setting' }, { status: 500 })
  }
}
