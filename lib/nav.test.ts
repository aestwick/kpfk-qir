import { describe, it, expect } from 'vitest'
import { episodeHref, withFrom, locationFrom, resolveOrigin } from './nav'

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
      label: 'Show Audit',
      href: '/dashboard/shows/audit',
    })
  })

  it('prefers the more specific grid prefix over compliance', () => {
    expect(resolveOrigin('/dashboard/compliance/grid').label).toBe('Grid Report')
    expect(resolveOrigin('/dashboard/compliance?tab=open').label).toBe('Compliance')
  })

  it('preserves the query string in the returned href', () => {
    expect(resolveOrigin('/dashboard/episodes?status=failed&page=2')).toEqual({
      label: 'Episodes',
      href: '/dashboard/episodes?status=failed&page=2',
    })
  })

  it('labels the dashboard root', () => {
    expect(resolveOrigin('/dashboard')).toEqual({ label: 'Dashboard', href: '/dashboard' })
  })
})
