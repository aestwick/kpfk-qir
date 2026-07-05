import { describe, it, expect } from 'vitest'
import {
  normalizeName,
  timeToMin,
  minToTime,
  weekdayOf,
  expandBlocks,
  enrichBlocks,
  airingInterval,
  reconcileDay,
  datesInWindow,
  type ScheduleSlot,
  type CmsShow,
  type Airing,
  type QirShowKeyInfo,
} from './verify-week'

function slot(overrides: Partial<ScheduleSlot>): ScheduleSlot {
  return {
    dayOfWeek: 4, // Thursday
    startTime: '07:00:00',
    endTime: '08:00:00',
    showId: null,
    label: null,
    effectiveDate: null,
    expiresDate: null,
    ...overrides,
  }
}

function airing(overrides: Partial<Airing>): Airing {
  return {
    episodeId: 1,
    showKey: 'dn',
    showName: 'Democracy Now!',
    airDate: '2026-07-02', // a Thursday
    airStart: '07:00:00',
    airEnd: '08:00:00',
    durationMin: 60,
    status: 'compliance_checked',
    hasTranscript: true,
    ...overrides,
  }
}

const shows = new Map<string, CmsShow>([
  ['show-dn', { id: 'show-dn', title: 'Democracy Now!', programSlug: 'dn' }],
  ['show-sh', { id: 'show-sh', title: "Something's Happening", programSlug: 'somethingshappening' }],
])
const keys = new Map<string, string[]>([['show-dn', ['dn', 'democragoodman']]])

describe('normalizeName', () => {
  it('unifies ampersand and punctuation so feed-name variants compare equal', () => {
    expect(normalizeName('Law & Disorder')).toBe(normalizeName('Law and Disorder'))
    expect(normalizeName('  Democracy Now!  ')).toBe('democracy now')
  })
  it('returns null for empty input', () => {
    expect(normalizeName(null)).toBeNull()
    expect(normalizeName('!!!')).toBeNull()
  })
})

describe('time helpers', () => {
  it('round-trips times', () => {
    expect(timeToMin('07:30:00')).toBe(450)
    expect(minToTime(450)).toBe('07:30')
    expect(minToTime(1440)).toBe('00:00') // wrapped midnight
  })
  it('computes weekday without timezone drift', () => {
    expect(weekdayOf('2026-07-02')).toBe(4) // Thursday
    expect(weekdayOf('2026-06-28')).toBe(0) // Sunday
  })
})

describe('expandBlocks', () => {
  it('merges consecutive same-show hourly slots into one block', () => {
    const slots = [0, 1, 2].map((h) =>
      slot({
        showId: 'show-sh',
        startTime: `0${h}:00:00`,
        endTime: `0${h + 1}:00:00`,
      })
    )
    const blocks = expandBlocks(slots, shows, keys, '2026-07-02')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].startMin).toBe(0)
    expect(blocks[0].endMin).toBe(180)
  })

  it('does not merge different shows and keeps slot order', () => {
    const blocks = expandBlocks(
      [
        slot({ showId: 'show-dn', startTime: '07:00:00', endTime: '08:00:00' }),
        slot({ label: 'Law and Disorder', startTime: '08:00:00', endTime: '09:00:00' }),
      ],
      shows,
      keys,
      '2026-07-02'
    )
    expect(blocks.map((b) => b.showTitle)).toEqual(['Democracy Now!', 'Law and Disorder'])
  })

  it('collects accepted keys from the mapping table plus program_slug', () => {
    const [block] = expandBlocks([slot({ showId: 'show-dn' })], shows, keys, '2026-07-02')
    expect(block.acceptedKeys.sort()).toEqual(['democragoodman', 'dn'])
  })

  it('wraps an end-of-day slot past midnight', () => {
    const [block] = expandBlocks(
      [slot({ label: 'Overnight', startTime: '23:00:00', endTime: '00:00:00' })],
      shows,
      keys,
      '2026-07-02'
    )
    expect(block.startMin).toBe(1380)
    expect(block.endMin).toBe(1440)
  })

  it('skips slots outside their effective window and other weekdays', () => {
    const slots = [
      slot({ effectiveDate: '2026-08-01' }), // not yet effective
      slot({ expiresDate: '2026-06-01' }), // expired
      slot({ dayOfWeek: 5 }), // Friday, not Thursday
    ]
    expect(expandBlocks(slots, shows, keys, '2026-07-02')).toHaveLength(0)
  })
})

describe('enrichBlocks', () => {
  const registry: QirShowKeyInfo[] = [
    { key: 'dn', showGroup: 'Democracy Now', showName: 'KPFK - Democracy Now!', active: true },
    { key: 'democragoodman', showGroup: null, showName: 'Democracy Now!', active: true },
    // The overnight strip: one logical show, many feed keys, one show_group.
    { key: 'somethingshappening', showGroup: "Something's Happening", showName: 'A hour 1', active: true },
    { key: 'somethihappenihour', showGroup: "Something's Happening", showName: 'A hour 2', active: true },
    { key: 'somethingshappeningb', showGroup: "Something's Happening", showName: 'B hour 1', active: true },
    { key: 'lawsnddisor', showGroup: null, showName: 'KPFK - Law and Disorder', active: true },
    { key: 'reggaecent', showGroup: null, showName: 'Reggae Central', active: false },
  ]

  it('expands accepted keys through show_group', () => {
    const blocks = enrichBlocks(
      expandBlocks(
        [slot({ showId: 'show-sh', startTime: '00:00:00', endTime: '06:00:00' })],
        new Map([['show-sh', { id: 'show-sh', title: "Something's Happening", programSlug: 'somethingshappening' }]]),
        new Map(),
        '2026-07-02'
      ),
      registry
    )
    expect(blocks[0].acceptedKeys.sort()).toEqual([
      'somethihappenihour',
      'somethingshappening',
      'somethingshappeningb',
    ])
    expect(blocks[0].tracked).toBe(true)
  })

  it('marks a block untracked when no active show_keys row matches key or name', () => {
    const blocks = enrichBlocks(
      expandBlocks(
        [
          slot({ label: 'Reggae Central', startTime: '14:00:00', endTime: '17:00:00' }), // inactive key
          slot({ label: 'CinemaScore', startTime: '17:00:00', endTime: '18:00:00' }), // no row at all
          slot({ label: 'Law and Disorder', startTime: '08:00:00', endTime: '09:00:00' }), // active, prefixed name
        ],
        shows,
        keys,
        '2026-07-02'
      ),
      registry
    )
    const byTitle = new Map(blocks.map((b) => [b.showTitle, b.tracked]))
    expect(byTitle.get('Reggae Central')).toBe(false)
    expect(byTitle.get('CinemaScore')).toBe(false)
    // "KPFK - Law and Disorder" suffix-matches the label despite the display prefix.
    expect(byTitle.get('Law and Disorder')).toBe(true)
  })

  it('after group expansion, sibling-feed airings match the block', () => {
    const blocks = enrichBlocks(
      expandBlocks(
        [
          slot({ showId: 'show-sh', startTime: '00:00:00', endTime: '01:00:00' }),
          slot({ showId: 'show-sh', startTime: '01:00:00', endTime: '02:00:00' }),
        ],
        new Map([['show-sh', { id: 'show-sh', title: "Something's Happening", programSlug: 'somethingshappening' }]]),
        new Map(),
        '2026-07-02'
      ),
      registry
    )
    const report = reconcileDay('2026-07-02', blocks, [
      airing({ episodeId: 1, showKey: 'somethingshappening', showName: 'A hour 1', airStart: '00:00:00', airEnd: '01:00:00' }),
      airing({ episodeId: 2, showKey: 'somethihappenihour', showName: 'A hour 2', airStart: '01:00:00', airEnd: '02:00:00' }),
    ])
    expect(report.blocks[0].verdict).toBe('aired')
    expect(report.blocks[0].coverage).toBe(1)
    expect(report.unscheduled).toHaveLength(0)
  })
})

describe('airingInterval', () => {
  it('prefers air_end, falls back to duration, then 60 minutes', () => {
    expect(airingInterval(airing({ airEnd: '08:30:00' }))).toEqual({ startMin: 420, endMin: 510 })
    expect(airingInterval(airing({ airEnd: null, durationMin: 90 }))).toEqual({ startMin: 420, endMin: 510 })
    expect(airingInterval(airing({ airEnd: null, durationMin: null }))).toEqual({ startMin: 420, endMin: 480 })
  })
  it('wraps an end at/before the start past midnight and rejects null air_start', () => {
    expect(airingInterval(airing({ airStart: '23:00:00', airEnd: '00:00:00' }))).toEqual({
      startMin: 1380,
      endMin: 1440,
    })
    expect(airingInterval(airing({ airStart: null }))).toBeNull()
  })
})

describe('reconcileDay', () => {
  const dnBlock = () => expandBlocks([slot({ showId: 'show-dn' })], shows, keys, '2026-07-02')

  it('marks a fully covered block aired via key match', () => {
    const report = reconcileDay('2026-07-02', dnBlock(), [airing({})])
    expect(report.blocks[0].verdict).toBe('aired')
    expect(report.blocks[0].coverage).toBe(1)
    expect(report.blocks[0].airings[0].matchType).toBe('key')
    expect(report.unscheduled).toHaveLength(0)
  })

  it('accepts an alternate mapped key for the same show', () => {
    const report = reconcileDay('2026-07-02', dnBlock(), [airing({ showKey: 'democragoodman' })])
    expect(report.blocks[0].verdict).toBe('aired')
  })

  it('falls back to normalized-name matching for label-only slots', () => {
    const blocks = expandBlocks(
      [slot({ label: 'Law & Disorder', startTime: '08:00:00', endTime: '09:00:00' })],
      shows,
      keys,
      '2026-07-02'
    )
    const report = reconcileDay('2026-07-02', blocks, [
      airing({ showKey: 'lawsnddisor', showName: 'Law and Disorder', airStart: '08:00:00', airEnd: '09:00:00' }),
    ])
    expect(report.blocks[0].verdict).toBe('aired')
    expect(report.blocks[0].airings[0].matchType).toBe('name')
  })

  it('marks a block missing when nothing overlaps it', () => {
    const report = reconcileDay('2026-07-02', dnBlock(), [])
    expect(report.blocks[0].verdict).toBe('missing')
    expect(report.blocks[0].coverage).toBe(0)
  })

  it('marks a half-covered block partial', () => {
    const report = reconcileDay('2026-07-02', dnBlock(), [airing({ airEnd: '07:30:00', durationMin: 30 })])
    expect(report.blocks[0].verdict).toBe('partial')
    expect(report.blocks[0].coverage).toBeCloseTo(0.5)
  })

  it('lets one long airing cover consecutive blocks of the same show', () => {
    const blocks = expandBlocks(
      [
        slot({ showId: 'show-dn', startTime: '07:00:00', endTime: '08:00:00' }),
        slot({ showId: 'show-dn', startTime: '16:00:00', endTime: '17:00:00' }),
      ],
      shows,
      keys,
      '2026-07-02'
    )
    const report = reconcileDay('2026-07-02', blocks, [
      airing({ episodeId: 1 }),
      airing({ episodeId: 2, airStart: '16:00:00', airEnd: '17:00:00' }),
    ])
    expect(report.blocks.every((b) => b.verdict === 'aired')).toBe(true)
  })

  it('classifies a right-time wrong-show airing as unscheduled with the displaced show', () => {
    const report = reconcileDay('2026-07-02', dnBlock(), [
      airing({ showKey: 'mystery', showName: 'Mystery Hour' }),
    ])
    expect(report.blocks[0].verdict).toBe('missing')
    expect(report.unscheduled).toHaveLength(1)
    expect(report.unscheduled[0].displaced[0].showTitle).toBe('Democracy Now!')
  })

  it('ignores sub-threshold boundary overlap', () => {
    // Ends 07:02 — a 2-minute spill into the block must not count as a match.
    const report = reconcileDay('2026-07-02', dnBlock(), [
      airing({ airStart: '06:00:00', airEnd: '07:02:00' }),
    ])
    expect(report.blocks[0].verdict).toBe('missing')
    expect(report.unscheduled).toHaveLength(1)
  })

  it('collects airings without air_start as unplaced', () => {
    const report = reconcileDay('2026-07-02', dnBlock(), [airing({ airStart: null })])
    expect(report.unplaced).toHaveLength(1)
    expect(report.blocks[0].verdict).toBe('missing')
  })
})

describe('datesInWindow', () => {
  it('is inclusive of both ends and crosses month boundaries', () => {
    expect(datesInWindow('2026-06-29', '2026-07-02')).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
    ])
  })
})
