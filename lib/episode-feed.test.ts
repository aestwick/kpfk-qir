import { describe, it, expect } from 'vitest'
import {
  PUBLISHED_STATUSES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  encodeCursor,
  decodeCursor,
  parseFeedRequest,
  keysetFilter,
  buildCursorEnvelope,
  projectEpisode,
  resolveEpisodeRef,
  type FeedRow,
} from './episode-feed'

const parse = (qs: string) => parseFeedRequest(new URLSearchParams(qs))

function row(id: number, updatedAt: string): FeedRow {
  return { id, public_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, updated_at: updatedAt }
}

describe('cursor codec', () => {
  it('round-trips a position', () => {
    const cursor = { updated_at: '2026-01-02T03:04:05.000Z', id: 4211 }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('produces a url-safe token', () => {
    const token = encodeCursor({ updated_at: '2026-01-02T03:04:05.000Z', id: 1 })
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('returns null for garbage rather than throwing', () => {
    for (const bad of ['', 'not-base64!!', Buffer.from('{}').toString('base64url'), Buffer.from('[1,2]').toString('base64url')]) {
      expect(decodeCursor(bad)).toBeNull()
    }
  })

  it('rejects a cursor whose timestamp is not a date', () => {
    const forged = Buffer.from(JSON.stringify(['yesterday', 5])).toString('base64url')
    expect(decodeCursor(forged)).toBeNull()
  })
})

describe('parseFeedRequest — retired offset params', () => {
  it('parses a bare request', () => {
    const { request } = parse('')
    expect(request?.limit).toBe(DEFAULT_LIMIT)
    expect(request?.cursor).toBeNull()
  })

  it('400s on every retired offset param', () => {
    for (const param of ['page', 'sort', 'order', 'since']) {
      const { request, error } = parse(`${param}=2`)
      expect(request).toBeUndefined()
      expect(error?.error).toContain(param)
      expect(error?.error).toContain('cursor')
    }
  })

  it('names every offending param at once', () => {
    const { error } = parse('page=2&order=asc')
    expect(error?.error).toContain('page')
    expect(error?.error).toContain('order')
  })

  it('points ?since at updated_since rather than aliasing it', () => {
    const { request, error } = parse('since=2026-01-01T00:00:00Z')
    expect(request).toBeUndefined()
    expect(error?.error).toContain('updated_since')
  })

  it('reports the retired param, not a downstream validation error', () => {
    // ?since is also a timestamp; the message must name the real problem.
    expect(parse('since=garbage').error?.error).toContain('Unsupported parameter')
  })
})

describe('parseFeedRequest — published contract', () => {
  it('defaults to every published status', () => {
    expect(parse('').request?.filters.statuses).toEqual([...PUBLISHED_STATUSES])
  })

  it('allows narrowing within the published set', () => {
    expect(parse('status=summarized').request?.filters.statuses).toEqual(['summarized'])
    expect(parse('status=summarized,compliance_checked').request?.filters.statuses).toEqual([
      'summarized',
      'compliance_checked',
    ])
  })

  it('rejects unpublished statuses so internal pipeline state is unreachable', () => {
    for (const status of ['pending', 'failed', 'transcribed', 'unavailable', 'dead']) {
      const { error, request } = parse(`status=${status}`)
      expect(request).toBeUndefined()
      expect(error?.error).toContain('published episodes only')
    }
  })
})

describe('parseFeedRequest — filters', () => {
  it('parses a comma-separated show_key list', () => {
    expect(parse('show_key=sojourner, uprising ,indymedia').request?.filters.showKeys).toEqual([
      'sojourner',
      'uprising',
      'indymedia',
    ])
  })

  it('accepts air date bounds', () => {
    const { request } = parse('air_date_from=2026-01-01&air_date_to=2026-03-31')
    expect(request?.filters).toMatchObject({ airDateFrom: '2026-01-01', airDateTo: '2026-03-31' })
  })

  it('rejects a malformed air date rather than ignoring it', () => {
    expect(parse('air_date_from=01/02/2026').error?.error).toContain('air_date_from')
    expect(parse('air_date_to=2026-3-1').error?.error).toContain('air_date_to')
  })

  it('rejects a malformed updated_since', () => {
    expect(parse('updated_since=last-tuesday').error?.error).toContain('updated_since')
  })

  it('rejects a cursor it did not issue', () => {
    expect(parse('cursor=zzzz').error?.error).toContain('Invalid cursor')
  })

  it('ignores unknown params — every supported filter narrows', () => {
    const { request, error } = parse('station_id=other&select=*&nonsense=1')
    expect(error).toBeUndefined()
    expect(request?.limit).toBe(DEFAULT_LIMIT)
  })
})

describe('parseFeedRequest — limit', () => {
  it('caps at MAX_LIMIT', () => {
    expect(parse(`limit=${MAX_LIMIT + 500}`).request?.limit).toBe(MAX_LIMIT)
  })

  it('floors at 1', () => {
    expect(parse('limit=0').request?.limit).toBe(1)
  })

  it('rejects a non-numeric limit', () => {
    expect(parse('limit=all').error?.error).toContain('Invalid limit')
  })
})

describe('keysetFilter', () => {
  it('expresses (updated_at, id) > cursor as a PostgREST or-filter', () => {
    expect(keysetFilter({ updated_at: '2026-05-05T12:00:00Z', id: 77 })).toBe(
      'updated_at.gt.2026-05-05T12:00:00Z,and(updated_at.eq.2026-05-05T12:00:00Z,id.gt.77)',
    )
  })
})

describe('buildCursorEnvelope', () => {
  it('drops the lookahead row and issues a cursor when there is more', () => {
    const rows = [row(1, '2026-01-01T00:00:00Z'), row(2, '2026-01-02T00:00:00Z'), row(3, '2026-01-03T00:00:00Z')]
    const env = buildCursorEnvelope(rows, 2)
    expect(env.data).toHaveLength(2)
    expect(env.count).toBe(2)
    expect(env.has_more).toBe(true)
    expect(decodeCursor(env.next_cursor!)).toEqual({ updated_at: '2026-01-02T00:00:00Z', id: 2 })
  })

  it('returns a null cursor once the consumer has caught up', () => {
    const env = buildCursorEnvelope([row(1, '2026-01-01T00:00:00Z')], 50)
    expect(env.has_more).toBe(false)
    expect(env.next_cursor).toBeNull()
  })

  it('handles an empty page', () => {
    expect(buildCursorEnvelope([], 50)).toMatchObject({ data: [], next_cursor: null, has_more: false, count: 0 })
  })

  it('walks a full set exactly once across pages', () => {
    const all = Array.from({ length: 7 }, (_, i) => row(i + 1, `2026-01-0${i + 1}T00:00:00Z`))
    const seen: number[] = []
    let cursor: string | null = null
    // Simulate the route: fetch rows strictly after the cursor, limit + 1.
    for (let guard = 0; guard < 10; guard++) {
      const pos = cursor ? decodeCursor(cursor)! : null
      const remaining = pos ? all.filter((r) => r.updated_at > pos.updated_at || (r.updated_at === pos.updated_at && r.id > pos.id)) : all
      const env = buildCursorEnvelope(remaining.slice(0, 3), 2)
      seen.push(...env.data.map((r) => (r as FeedRow).id))
      cursor = env.next_cursor
      if (!cursor) break
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('does not skip rows sharing an updated_at', () => {
    const ts = '2026-02-02T00:00:00Z'
    const batch = [row(10, ts), row(11, ts), row(12, ts)]
    const first = buildCursorEnvelope(batch, 2)
    const pos = decodeCursor(first.next_cursor!)!
    const rest = batch.filter((r) => r.updated_at > pos.updated_at || (r.updated_at === pos.updated_at && r.id > pos.id))
    expect(rest.map((r) => r.id)).toEqual([12])
  })
})

describe('resolveEpisodeRef', () => {
  it('resolves a uuid to public_id', () => {
    expect(resolveEpisodeRef('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toEqual({
      column: 'public_id',
      value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    })
  })

  it('still resolves the legacy integer id', () => {
    expect(resolveEpisodeRef('4211')).toEqual({ column: 'id', value: 4211 })
  })

  it('rejects anything else', () => {
    for (const bad of ['', 'abc', '1; drop table', '-5', '3f2504e0-4f89-41d3-9a0c']) {
      expect(resolveEpisodeRef(bad)).toBeNull()
    }
  })
})

describe('projectEpisode', () => {
  it('renames duration to duration_minutes and derives seconds', () => {
    const out = projectEpisode({ public_id: 'x', duration: 60, title: 'T' })
    expect(out.duration_minutes).toBe(60)
    expect(out.duration_seconds).toBe(3600)
    expect('duration' in out).toBe(false)
  })

  it('keeps null null — never 0, which would read as a zero-length episode', () => {
    const out = projectEpisode({ public_id: 'x', duration: null })
    expect(out.duration_minutes).toBeNull()
    expect(out.duration_seconds).toBeNull()
  })

  it('handles a row with no duration key at all', () => {
    const out = projectEpisode({ public_id: 'x' })
    expect(out.duration_minutes).toBeNull()
    expect(out.duration_seconds).toBeNull()
  })

  it('leaves every other field untouched', () => {
    const row = { public_id: 'x', id: 1, show_key: 'k', summary: 's', duration: 30 }
    const out = projectEpisode(row)
    expect(out).toMatchObject({ public_id: 'x', id: 1, show_key: 'k', summary: 's' })
  })
})
