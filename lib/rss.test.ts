import { describe, it, expect } from 'vitest'
import { rssText, parseChannelMeta } from './rss'

describe('rssText', () => {
  it('trims a plain string node', () => {
    expect(rssText('  Democracy Now!  ')).toBe('Democracy Now!')
  })

  it('unwraps a CDATA-wrapped node', () => {
    expect(rssText({ __cdata: '  Uprising  ' })).toBe('Uprising')
  })

  it('returns null for null/blank/empty values', () => {
    expect(rssText(null)).toBeNull()
    expect(rssText(undefined)).toBeNull()
    expect(rssText('   ')).toBeNull()
    expect(rssText({ __cdata: '   ' })).toBeNull()
    expect(rssText({})).toBeNull() // object without __cdata (e.g. attrs only)
  })
})

const feed = (channelInner: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${channelInner}</channel></rss>`

describe('parseChannelMeta', () => {
  it('reads a plain title and counts items', () => {
    const meta = parseChannelMeta(feed('<title>Uprising</title><item></item><item></item>'))
    expect(meta.title).toBe('Uprising')
    expect(meta.itemCount).toBe(2)
  })

  it('unwraps a CDATA title', () => {
    expect(parseChannelMeta(feed('<title><![CDATA[Democracy Now!]]></title>')).title).toBe('Democracy Now!')
  })

  it('prefers the plain <category> over itunes:category', () => {
    // The real archive feed carries both; the plain one ("Español") is the
    // station-meaningful value the ingest exclusion list matches, so it must win
    // over the generic itunes taxonomy ("News & Politics").
    const meta = parseChannelMeta(
      feed('<title>X</title><category>Español</category><itunes:category text="News &amp; Politics"/>')
    )
    expect(meta.category).toBe('Español')
  })

  it('falls back to itunes:category when there is no plain <category>', () => {
    const meta = parseChannelMeta(feed('<title>X</title><itunes:category text="News &amp; Politics"/>'))
    expect(meta.category).toBe('News & Politics')
  })

  it('takes the first when the plain <category> repeats', () => {
    const meta = parseChannelMeta(feed('<title>X</title><category>Español</category><category>Music</category>'))
    expect(meta.category).toBe('Español')
  })

  it('reports a single item as count 1', () => {
    expect(parseChannelMeta(feed('<title>X</title><item></item>')).itemCount).toBe(1)
  })

  it('returns blanks for a document that is not a feed', () => {
    expect(parseChannelMeta('<html><body>nope</body></html>')).toEqual({
      title: null,
      category: null,
      itemCount: 0,
    })
  })

  it('handles an empty feed (title, no items, no category)', () => {
    expect(parseChannelMeta(feed('<title>Empty Show</title>'))).toEqual({
      title: 'Empty Show',
      category: null,
      itemCount: 0,
    })
  })

  // Trimmed from a real archive.kpfk.org getrss.php?id=informap response, so the
  // parser stays pinned to the actual feed shape (CDATA title with a station
  // prefix, both category signals, itunes:duration in seconds — see ingest).
  it('parses a real KPFK archive feed', () => {
    const xml = `<?xml version="1.0"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0"><channel>
  <title><![CDATA[ KPFK - Informativo Pacifica Online ]]></title>
  <language>en-us</language>
  <generator>Pacifica Archive archiver_9.0.1</generator>
  <category>Español</category>
  <itunes:category text="News &amp; Politics"/>
  <item>
    <title><![CDATA[ Informativo Pacifica Online - Tuesday, June 2, 2026 ]]></title>
    <itunes:duration>1697</itunes:duration>
    <category>Español</category>
    <enclosure url="https://archive.kpfk.org/mp3/2kpfk_260602_200100informap.mp3" length="27163047" type="audio/mpeg"/>
  </item>
  <item>
    <title><![CDATA[ Informativo Pacifica Online - Monday, June 1, 2026 ]]></title>
    <enclosure url="https://archive.kpfk.org/mp3/2kpfk_260601_200100informap.mp3" length="27309871" type="audio/mpeg"/>
  </item>
</channel></rss>`
    expect(parseChannelMeta(xml)).toEqual({
      // Title keeps the "KPFK -" prefix; cleanFeedName strips it at display time
      // using the station's configured strip prefixes — parsing stays verbatim.
      title: 'KPFK - Informativo Pacifica Online',
      category: 'Español',
      itemCount: 2,
    })
  })
})
