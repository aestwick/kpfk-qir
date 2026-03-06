import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const show = searchParams.get('show')
  const category = searchParams.get('category')
  const quarter = searchParams.get('quarter') // e.g. "2025-Q1"
  const sort = searchParams.get('sort') ?? 'created_at'
  const order = searchParams.get('order') ?? 'desc'
  const page = parseInt(searchParams.get('page') ?? '1')
  const limit = parseInt(searchParams.get('limit') ?? '50')
  const offset = (page - 1) * limit
  const format = searchParams.get('format')

  let query = supabaseAdmin
    .from('episode_log')
    .select('*', { count: 'exact' })
    .order(sort, { ascending: order === 'asc' })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)
  if (show) query = query.ilike('show_name', `%${show}%`)
  if (category) query = query.ilike('category', `%${category}%`)

  if (quarter) {
    const [year, q] = quarter.split('-Q')
    const qNum = parseInt(q)
    const startMonth = (qNum - 1) * 3
    const start = new Date(parseInt(year), startMonth, 1).toISOString().slice(0, 10)
    const end = new Date(parseInt(year), startMonth + 3, 0).toISOString().slice(0, 10)
    query = query.gte('air_date', start).lte('air_date', end)
  }

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (format === 'csv') {
    const rows = data ?? []
    const headers = ['id', 'show_name', 'category', 'status', 'air_date', 'start_time', 'duration', 'headline', 'host', 'guest', 'issue_category', 'summary']
    const csvLines = [
      headers.join(','),
      ...rows.map((r: Record<string, unknown>) =>
        headers.map((h) => {
          const val = String(r[h] ?? '')
          return val.includes(',') || val.includes('"') || val.includes('\n')
            ? `"${val.replace(/"/g, '""')}"`
            : val
        }).join(',')
      ),
    ]
    return new Response(csvLines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="episodes.csv"',
      },
    })
  }

  return NextResponse.json({ episodes: data, total: count, page, limit })
}

export async function POST(request: NextRequest) {
  const body = await request.json()

  if (body.action === 'bulk-retry') {
    const { error } = await supabaseAdmin
      .from('episode_log')
      .update({ status: 'pending', error_message: null })
      .eq('status', 'failed')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, message: 'All failed episodes reset to pending' })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
