import { describe, it, expect } from 'vitest'
import {
  episodeHref, withFrom, locationFrom, resolveOrigin, NAV_GROUPS, ALL_NAV_ITEMS, visibleNav,
  matchNavItem, activeNavItem, labelForPath, breadcrumbTrail, filingStatus, filingDueDate,
  reportHref, parseQuarterParam, roleAllows, stationToday, publicReportHref,
} from './nav'

describe('episodeHref', () => {
  it('returns a plain href when no origin is given', () => {
    expect(episodeHref(42)).toBe('/dashboard/episodes/42')
    expect(episodeHref(42, null)).toBe('/dashboard/episodes/42')
  })

  it('appends an encoded from hint', () => {
    expect(episodeHref(42, '/dashboard/shows/foo')).toBe(
      '/dashboard/episodes/42?from=%2Fdashboard%2Fshows%2Ffoo',
    )
  })
})

describe('withFrom', () => {
  it('uses ? when the href has no query, & when it does', () => {
    expect(withFrom('/dashboard/episodes/1', '/dashboard')).toBe(
      '/dashboard/episodes/1?from=%2Fdashboard',
    )
    expect(withFrom('/dashboard/episodes/1?seek=12.5', '/dashboard/compliance')).toBe(
      '/dashboard/episodes/1?seek=12.5&from=%2Fdashboard%2Fcompliance',
    )
  })

  it('is a no-op without a from value', () => {
    expect(withFrom('/dashboard/episodes/1?seek=1', '')).toBe('/dashboard/episodes/1?seek=1')
  })
})

describe('locationFrom', () => {
  it('joins path and query, omitting an empty query', () => {
    expect(locationFrom('/dashboard/episodes', 'status=failed&page=2')).toBe(
      '/dashboard/episodes?status=failed&page=2',
    )
    expect(locationFrom('/dashboard/episodes', '')).toBe('/dashboard/episodes')
    expect(locationFrom('/dashboard/episodes')).toBe('/dashboard/episodes')
  })
})

describe('resolveOrigin', () => {
  it('falls back to Episodes when there is no hint', () => {
    expect(resolveOrigin(null)).toEqual({ label: 'Episodes', href: '/dashboard/episodes' })
    expect(resolveOrigin(undefined)).toEqual({ label: 'Episodes', href: '/dashboard/episodes' })
  })

  it('labels a show page with the show name and keeps its href', () => {
    expect(resolveOrigin('/dashboard/shows/weekend-news', { name: 'Weekend News' })).toEqual({
      label: 'Weekend News',
      href: '/dashboard/shows/weekend-news',
    })
  })

  it('falls back to the show key, then "Show", when no name is known', () => {
    expect(resolveOrigin('/dashboard/shows/abc', { key: 'abc' }).label).toBe('abc')
    expect(resolveOrigin('/dashboard/shows/abc').label).toBe('Show')
  })

  it('does not treat the show audit page as a show page', () => {
    expect(resolveOrigin('/dashboard/shows/audit', { name: 'Ignored' })).toEqual({
      label: 'Show check-up',
      href: '/dashboard/shows/audit',
    })
  })

  it('prefers the more specific grid prefix over compliance', () => {
    expect(resolveOrigin('/dashboard/compliance/grid').label).toBe('Flags by time slot')
    expect(resolveOrigin('/dashboard/compliance?tab=open').label).toBe('Review flags')
  })

  it('preserves the query string in the returned href', () => {
    expect(resolveOrigin('/dashboard/episodes?status=failed&page=2')).toEqual({
      label: 'Episodes',
      href: '/dashboard/episodes?status=failed&page=2',
    })
  })

  it('labels the dashboard root', () => {
    expect(resolveOrigin('/dashboard')).toEqual({ label: 'Home', href: '/dashboard' })
  })

  it('ignores a from value that is not a dashboard path', () => {
    expect(resolveOrigin('https://evil.example/dashboard')).toEqual({ label: 'Episodes', href: '/dashboard/episodes' })
  })
})

describe('menu definition', () => {
  it('has unique ids and unique hrefs', () => {
    const ids = ALL_NAV_ITEMS.map((i) => i.id)
    const hrefs = ALL_NAV_ITEMS.map((i) => i.href)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('every parent points at a real item', () => {
    for (const i of ALL_NAV_ITEMS) if (i.parent) expect(ALL_NAV_ITEMS.some((o) => o.id === i.parent)).toBe(true)
  })

  it('every non-reserved item links to an existing dashboard page', async () => {
    const fs = await import('fs')
    for (const i of ALL_NAV_ITEMS.filter((x) => !x.reserved)) {
      const path = i.href.split('?')[0].replace(/^\//, '')
      expect(fs.existsSync(`app/${path}/page.tsx`), i.href).toBe(true)
    }
  })
})

describe('visibleNav', () => {
  const ids = (role: Parameters<typeof visibleNav>[0], reserved?: Set<string>) =>
    visibleNav(role, reserved).flatMap((g) => g.items.map((i) => i.id))

  it('shows viewers only the reading sections', () => {
    expect(ids('viewer')).toEqual([
      'home', 'episodes', 'shows', 'search', 'show-checkup', 'downloads', 'report', 'compliance', 'compliance-grid',
    ])
  })

  it('adds settings and processing for editors, members and keys for admins', () => {
    expect(ids('editor')).toContain('settings')
    expect(ids('editor')).toContain('jobs')
    expect(ids('editor')).not.toContain('members')
    expect(ids('admin')).toContain('members')
    expect(ids('admin')).toContain('api-keys')
    expect(ids('admin')).not.toContain('master')
  })

  it('shows super-admins everything except unconfirmed reserved slots', () => {
    const all = ids('super')
    for (const i of ALL_NAV_ITEMS) expect(all.includes(i.id)).toBe(!i.reserved)
  })

  it('shows a reserved slot once its page is confirmed', () => {
    expect(ids('viewer', new Set(['broadcast-day']))).toContain('broadcast-day')
  })

  it('treats an unknown (loading) role as viewer and drops empty groups', () => {
    expect(roleAllows(null, 'viewer')).toBe(true)
    expect(roleAllows(undefined, 'editor')).toBe(false)
    expect(visibleNav('viewer').some((g) => g.id === 'system' || g.id === 'station')).toBe(false)
    expect(NAV_GROUPS.length).toBeGreaterThan(visibleNav('viewer').length)
  })
})

describe('matchNavItem / activeNavItem', () => {
  it('matches exact pages and sub-pages, with Home only at the root', () => {
    expect(matchNavItem('/dashboard')?.id).toBe('home')
    expect(matchNavItem('/dashboard/episodes?status=failed')?.id).toBe('episodes')
    expect(matchNavItem('/dashboard/shows/risingup')?.id).toBe('shows')
    expect(matchNavItem('/dashboard/shows/audit')?.id).toBe('show-checkup')
    expect(matchNavItem('/dashboard/compliance/grid')?.id).toBe('compliance-grid')
    expect(matchNavItem('/dashboard/compliance')?.id).toBe('compliance')
    expect(matchNavItem('/dashboard/nope')).toBeNull()
  })

  it('does not confuse prefixes that merely share letters', () => {
    expect(matchNavItem('/dashboard/usagex')).toBeNull()
  })

  it('picks the Settings tab item only when the query matches', () => {
    expect(matchNavItem('/dashboard/settings?tab=members')?.id).toBe('members')
    expect(matchNavItem('/dashboard/settings?tab=shows')?.id).toBe('settings')
    expect(matchNavItem('/dashboard/settings')?.id).toBe('settings')
  })

  it('highlights the section an episode was opened from', () => {
    expect(activeNavItem('/dashboard/episodes/42', 'from=%2Fdashboard%2Fcompliance%3Fstatus%3Dsuggested')?.id).toBe('compliance')
    expect(activeNavItem('/dashboard/episodes/42', 'seek=3&from=%2Fdashboard%2Fsearch')?.id).toBe('search')
    expect(activeNavItem('/dashboard/episodes/42', 'from=%2Fdashboard')?.id).toBe('episodes')
    expect(activeNavItem('/dashboard/episodes/42')?.id).toBe('episodes')
    expect(activeNavItem('/dashboard/episodes', 'from=%2Fdashboard%2Fsearch')?.id).toBe('episodes')
  })

  it('labels paths from the same definition', () => {
    expect(labelForPath('/dashboard/generate')).toBe('Quarterly report')
    expect(labelForPath('/dashboard/audit')).toBe('Change history')
  })
})

describe('breadcrumbTrail', () => {
  it('returns Home › section for a section page', () => {
    expect(breadcrumbTrail('/dashboard/compliance')).toEqual([
      { label: 'Home', href: '/dashboard' },
      { label: 'Review flags', href: '/dashboard/compliance' },
    ])
  })

  it('inserts the parent for nested sections', () => {
    expect(breadcrumbTrail('/dashboard/compliance/grid').map((c) => c.label)).toEqual([
      'Home', 'Review flags', 'Flags by time slot',
    ])
  })

  it('appends a leaf for a show page', () => {
    expect(breadcrumbTrail('/dashboard/shows/risingup', { leafLabel: 'Rising Up' })).toEqual([
      { label: 'Home', href: '/dashboard' },
      { label: 'Shows', href: '/dashboard/shows' },
      { label: 'Rising Up', href: '/dashboard/shows/risingup' },
    ])
  })

  it('uses the origin in place of Episodes on an episode page', () => {
    const origin = { label: 'Review flags', href: '/dashboard/compliance?status=suggested' }
    expect(breadcrumbTrail('/dashboard/episodes/9', { leafLabel: 'Rising Up', origin }).map((c) => c.label)).toEqual([
      'Home', 'Review flags', 'Rising Up',
    ])
    expect(breadcrumbTrail('/dashboard/episodes/9', { leafLabel: 'X', origin: { label: 'Home', href: '/dashboard' } }).map((c) => c.label)).toEqual(['Home', 'X'])
  })
})

describe('filing deadline', () => {
  it('is the 10th of the month after the quarter', () => {
    expect(filingDueDate(2026, 3)).toEqual(new Date(2026, 9, 10))
    expect(filingDueDate(2026, 4)).toEqual(new Date(2027, 0, 10))
  })

  it('reports the just-ended quarter as due until the 10th, then overdue', () => {
    const s = filingStatus(new Date(2026, 9, 3), [])
    expect(s).toMatchObject({ year: 2026, quarter: 3, label: 'Q3 2026', state: 'due' })
    expect(filingStatus(new Date(2026, 9, 10, 23), []).state).toBe('due')
    expect(filingStatus(new Date(2026, 10, 4), []).state).toBe('overdue')
  })

  it('points ahead once the last quarter is finalized', () => {
    const s = filingStatus(new Date(2026, 10, 4), [{ year: 2026, quarter: 3 }])
    expect(s.state).toBe('finalized')
    expect(s.next).toMatchObject({ year: 2026, quarter: 4, label: 'Q4 2026' })
    expect(s.next!.due).toEqual(new Date(2027, 0, 10))
  })

  it('wraps across the year in January', () => {
    expect(filingStatus(new Date(2027, 0, 5), [])).toMatchObject({ year: 2026, quarter: 4, state: 'due' })
  })

  it('computes today in the station time zone', () => {
    // 2026-10-01 03:00 UTC is still Sept 30 in Los Angeles.
    const t = new Date(Date.UTC(2026, 9, 1, 3))
    expect(stationToday('America/Los_Angeles', t)).toEqual(new Date(2026, 8, 30))
    expect(stationToday('America/New_York', t)).toEqual(new Date(2026, 8, 30))
    expect(stationToday('Not/AZone', t)).toBeInstanceOf(Date)
  })

  it('builds the public report link with the station slug', () => {
    expect(publicReportHref('kpfa', { year: 2026, quarter: 3 })).toBe('/kpfa/2026/q3')
  })

  it('round-trips the quarter link', () => {
    expect(reportHref({ year: 2026, quarter: 3 })).toBe('/dashboard/generate?quarter=2026-Q3')
    expect(parseQuarterParam('2026-Q3')).toEqual({ year: 2026, quarter: 3 })
    expect(parseQuarterParam('2026-Q5')).toBeNull()
    expect(parseQuarterParam(null)).toBeNull()
  })
})
