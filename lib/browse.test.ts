import { describe, it, expect } from 'vitest'
import {
  isIsoDate,
  shiftDate,
  stationToday,
  formatAirDate,
  formatAirTime,
  formatOffset,
  formatMinutes,
  formatMomentClock,
  episodeMomentHref,
  broadcastDayHref,
  monthRange,
} from './broadcast-format'
import { buildShowCatalog, groupKeysFor } from './show-catalog'
import { buildBroadcastDay, blockAt, isSecondaryFeed, type DayEpisodeRow } from './broadcast-day'
import { splitPeople, foldName, nameSimilarity, samePerson, mergePeople, rankForQuery, type PersonRow } from './people'
import { buildShowReport, splitIssues, type ReportEpisodeRow } from './show-report'

describe('broadcast-format', () => {
  it('validates and shifts dates', () => {
    expect(isIsoDate('2026-10-09')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('Oct 9')).toBe(false)
    expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('computes the station-local date, not UTC', () => {
    // 2026-11-05 05:30 UTC is still Nov 4 in Los Angeles.
    expect(stationToday('America/Los_Angeles', new Date('2026-11-05T05:30:00Z'))).toBe('2026-11-04')
  })
  it('formats dates, times, offsets, durations', () => {
    expect(formatAirDate('2026-10-09')).toBe('Fri, Oct 9, 2026')
    expect(formatAirDate('2026-10-09', { weekday: false, year: false })).toBe('Oct 9')
    expect(formatAirTime('07:00:00')).toBe('7:00 AM')
    expect(formatAirTime('00:30:00')).toBe('12:30 AM')
    expect(formatAirTime('12:00:00')).toBe('12:00 PM')
    expect(formatAirTime('21:05')).toBe('9:05 PM')
    expect(formatOffset(651395)).toBe('10:51')
    expect(formatOffset(3725000)).toBe('1:02:05')
    expect(formatMinutes(120)).toBe('2h')
    expect(formatMinutes(59)).toBe('59m')
    expect(formatMinutes(90)).toBe('1h 30m')
    expect(formatMinutes(null)).toBe('—')
  })
  it('gives the wall-clock time of a moment', () => {
    expect(formatMomentClock('09:00:00', 651395)).toBe('9:10 AM')
    expect(formatMomentClock(null, 1000)).toBeNull()
  })
  it('builds links', () => {
    expect(episodeMomentHref(9682, 651395)).toBe('/dashboard/episodes/9682?seek=651.4')
    expect(episodeMomentHref(9682, null, '/dashboard/day?date=2026-10-09')).toBe(
      '/dashboard/episodes/9682?from=%2Fdashboard%2Fday%3Fdate%3D2026-10-09'
    )
    expect(broadcastDayHref('2026-10-09', 7)).toBe('/dashboard/day?date=2026-10-09&at=07:00')
    expect(monthRange('2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
})

const catalog = buildShowCatalog([
  { key: 'infopac', show_name: 'Informativo Pacifica', show_group: null, category: 'Español' },
  { key: 'informap', show_name: 'Informativo Pacifica Online', show_group: null, category: 'Español' },
  { key: 'hartmann', show_name: 'Thom Hartmann Program', show_group: 'Thom Hartmann', category: null },
  { key: 'hartmann2', show_name: 'Hartmann hour 2', show_group: 'thom hartmann', category: null },
])

const ep = (o: Partial<DayEpisodeRow> & { id: number; show_key: string }): DayEpisodeRow => ({
  show_name: null,
  air_date: '2026-10-13',
  air_start: null,
  air_end: null,
  duration: null,
  host: null,
  guest: null,
  headline: null,
  title: null,
  issue_category: null,
  category: null,
  status: 'compliance_checked',
  mp3_url: null,
  ...o,
})

describe('show catalog', () => {
  it('groups feeds by show_group case-insensitively', () => {
    expect(groupKeysFor(catalog, 'hartmann').sort()).toEqual(['hartmann', 'hartmann2'])
    expect(catalog.byKey.get('hartmann2')?.name).toBe('Thom Hartmann')
    expect(groupKeysFor(catalog, 'unknown')).toEqual(['unknown'])
  })
})

describe('buildBroadcastDay', () => {
  const rows = [
    ep({ id: 9772, show_key: 'informap', air_start: '20:01:00', duration: 28, mp3_url: 'https://archive.kpfk.org/mp3/2kpfk_261013_200100informap.mp3' }),
    ep({ id: 9813, show_key: 'infopac', air_start: '20:00:00', duration: 30, mp3_url: 'https://archive.kpfk.org/mp3/kpfk_261013_200000infopac.mp3' }),
    ep({ id: 1, show_key: 'hartmann', air_start: '09:00:00', air_end: '11:00:00' }),
    ep({ id: 2, show_key: 'hartmann2', air_start: '09:02:00', duration: 58 }),
    ep({ id: 3, show_key: 'late', air_start: '23:00:00', air_end: '00:00:00' }),
    ep({ id: 4, show_key: 'nostart' }),
  ]
  const day = buildBroadcastDay(rows, catalog)
  it('orders by air time, unknown times last', () => {
    expect(day.map((b) => b.episodeId)).toEqual([1, 9813, 9772, 3, 4])
  })
  it('folds same-show feeds starting together into one airing', () => {
    expect(day[0].alsoAired).toEqual([2])
    expect(day[0].showName).toBe('Thom Hartmann')
    expect(day[0].endMin).toBe(11 * 60)
  })
  it('keeps the online copy but flags it, and wraps a midnight end', () => {
    expect(day[2].secondaryFeed).toBe(true)
    expect(day[1].secondaryFeed).toBe(false)
    expect(day[3].endMin).toBe(24 * 60)
  })
  it('finds the block on air at a time', () => {
    expect(day[blockAt(day, 9 * 60 + 30)].episodeId).toBe(1)
    expect(day[blockAt(day, 20 * 60 + 10)].episodeId).toBe(9813)
    expect(day[blockAt(day, 15 * 60)].episodeId).toBe(9813) // next to start
  })
  it('recognises secondary-feed MP3 names', () => {
    expect(isSecondaryFeed('https://x/mp3/2kpfk_261013_200100informap.mp3')).toBe(true)
    expect(isSecondaryFeed('https://x/mp3/kpfk_261013_200000infopac.mp3')).toBe(false)
  })
})

describe('people', () => {
  it('splits guest fields into names, dropping honorifics and affiliations', () => {
    expect(splitPeople('Dr. Gerald Horne, historian; Ana López & Mark Pocan')).toEqual(['Gerald Horne', 'Ana López', 'Mark Pocan'])
    expect(splitPeople('Austin Sarat, Jurisprudence and Political Science, Amherst College')).toEqual(['Austin Sarat'])
    expect(splitPeople('')).toEqual([])
  })
  it('folds accents and compares spellings', () => {
    expect(foldName('  Juan  González ')).toBe('juan gonzalez')
    expect(nameSimilarity('Gerald Horn', 'Gerald Horne')).toBeGreaterThan(0.7)
    expect(samePerson('Gerald Horn', 'Gerald Horne')).toBe(true)
    expect(samePerson('Sonali Kohatkar', 'Sonali Kolhatkar')).toBe(true)
    expect(samePerson('Greg Palast', 'Greg Grandin')).toBe(false)
    expect(samePerson('Juan Gonzalez', 'Juan González')).toBe(true)
    expect(samePerson('Thom Hartmann', 'Tom Hartman')).toBe(true)
    expect(samePerson('David Corn', 'David Korn')).toBe(true)
    expect(samePerson('Mark Pokan', 'Mark Pocan')).toBe(true)
    expect(samePerson('Greg Palast', 'Greg Palace')).toBe(false)
    expect(samePerson('Gerald Horne', 'Gary Horne')).toBe(false)
  })
  it('merges spelling rows into one person', () => {
    const r = (name: string, n: number, score = 0.8): PersonRow => ({
      folded: foldName(name),
      name,
      appearances: n,
      as_host: 0,
      as_guest: n,
      first_date: '2026-01-01',
      last_date: `2026-0${n}-01`,
      shows: ['Democracy Now'],
      score,
    })
    const merged = mergePeople([r('Gerald Horne', 8), r('Gerald Horn', 5, 0.95), r('Greg Grandin', 2, 0.45)])
    expect(merged[0]).toMatchObject({ name: 'Gerald Horne', variants: ['Gerald Horn'], appearances: 13, score: 0.95 })
    expect(merged[0].spellings).toEqual(['gerald horne', 'gerald horn'])
    expect(merged[1].name).toBe('Greg Grandin')
  })
  it('breaks ties by where the name sits in the query', () => {
    const r = (name: string): PersonRow => ({ folded: foldName(name), name, appearances: 2, as_host: 0, as_guest: 2, first_date: null, last_date: null, shows: [], score: 1 })
    expect(rankForQuery(mergePeople([r('Mother Jones'), r('David Corn')]), 'David Corn Mother Jones')[0].name).toBe('David Corn')
  })
})

describe('show report', () => {
  const row = (id: number, o: Partial<ReportEpisodeRow>): ReportEpisodeRow => ({
    id,
    show_key: 'hartmann',
    air_date: '2026-10-01',
    air_start: '09:00:00',
    duration: 60,
    headline: null,
    title: null,
    summary: null,
    host: 'Tom Hartman',
    guest: null,
    issue_category: null,
    status: 'compliance_checked',
    ...o,
  })
  it('tallies issues, guests and hosts per episode', () => {
    const r = buildShowReport([
      row(1, { issue_category: 'Government/Politics', guest: 'Greg Palast' }),
      row(2, { issue_category: 'Government/Politics, Health', guest: 'Greg Palast, Mark Pocan' }),
      row(3, { issue_category: 'SKIP', status: 'transcribed', duration: 120 }),
    ])
    expect(r.episodeCount).toBe(3)
    expect(r.totalMinutes).toBe(240)
    expect(r.pendingCount).toBe(1)
    expect(r.issues).toEqual([
      { name: 'Government/Politics', count: 2, episodeIds: [1, 2] },
      { name: 'Health', count: 1, episodeIds: [2] },
    ])
    expect(r.guests[0]).toEqual({ name: 'Greg Palast', count: 2, episodeIds: [1, 2] })
    expect(r.hosts).toEqual([{ name: 'Tom Hartman', count: 3, episodeIds: [1, 2, 3] }])
  })
  it('drops non-issue tags', () => {
    expect(splitIssues('SKIP; Education | none')).toEqual(['Education'])
  })
})
