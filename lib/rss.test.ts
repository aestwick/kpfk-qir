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

  it('prefers itunes:category text attribute', () => {
    const meta = parseChannelMeta(feed('<title>X</title><itunes:category text="News &amp; Politics"/>'))
    expect(meta.category).toBe('News & Politics')
  })

  it('takes the first when itunes:category repeats', () => {
    const meta = parseChannelMeta(
      feed('<title>X</title><itunes:category text="News &amp; Politics"/><itunes:category text="Society &amp; Culture"/>')
    )
    expect(meta.category).toBe('News & Politics')
  })

  it('falls back to a plain <category> element', () => {
    expect(parseChannelMeta(feed('<title>X</title><category>Public Affairs</category>')).category).toBe('Public Affairs')
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
})
