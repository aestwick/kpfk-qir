import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '../../../../lib/supabase'

export const dynamic = 'force-dynamic'

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ showKey: string }> }
) {
  const { showKey } = await params

  // Look up show metadata
  const { data: show, error: showErr } = await supabaseAdmin
    .from('show_keys')
    .select('key, show_name, category')
    .eq('key', showKey)
    .single()

  if (showErr || !show) {
    return NextResponse.json({ error: 'Show not found' }, { status: 404 })
  }

  // Fetch episodes for this show, newest first
  const { data: episodes, error: epErr } = await supabaseAdmin
    .from('episode_log')
    .select('title, mp3_url, date, air_date, start_time, duration, summary, headline, status')
    .eq('show_key', showKey)
    .not('mp3_url', 'is', null)
    .order('air_date', { ascending: false, nullsFirst: false })
    .limit(200)

  if (epErr) {
    return NextResponse.json({ error: 'Failed to fetch episodes' }, { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://qir.kpfk.org'
  const showName = escapeXml(show.show_name)
  const feedUrl = `${baseUrl}/api/feeds/${showKey}`

  const items = (episodes || []).map((ep) => {
    const title = escapeXml(ep.title || ep.headline || `${show.show_name} — ${ep.date || 'Unknown date'}`)
    const description = ep.summary ? escapeXml(ep.summary) : ''
    const pubDate = ep.air_date
      ? new Date(ep.air_date + 'T12:00:00-08:00').toUTCString()
      : ''
    const durationSec = ep.duration ? ep.duration * 60 : 0

    return `    <item>
      <title>${title}</title>
      <enclosure url="${escapeXml(ep.mp3_url)}" type="audio/mpeg" />
      <guid isPermaLink="false">${escapeXml(ep.mp3_url)}</guid>
      ${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}
      ${description ? `<description>${description}</description>` : ''}
      ${durationSec ? `<itunes:duration>${durationSec}</itunes:duration>` : ''}
    </item>`
  }).join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${showName} — KPFK 90.7FM</title>
    <link>https://www.kpfk.org</link>
    <description>Episodes of ${showName} on KPFK 90.7FM, Pacifica Radio Los Angeles${show.category ? `. Category: ${escapeXml(show.category)}` : ''}</description>
    <language>en-us</language>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <itunes:author>KPFK 90.7FM</itunes:author>
    <itunes:category text="News" />
${items}
  </channel>
</rss>`

  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  })
}
