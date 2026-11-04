import { describe, it, expect } from 'vitest'
import { continuationData } from './job-chain'

describe('continuationData', () => {
  it('keeps a backfill window and its chain flags (backoff used to drop chain)', () => {
    const job = { stationId: 'kpfk', window: { start: '2026-01-01', end: '2026-03-31' }, source: 'chain', chain: true, episodeId: 7 }
    expect(continuationData(job)).toEqual({
      stationId: 'kpfk',
      window: { start: '2026-01-01', end: '2026-03-31' },
      source: 'chain',
      chain: true,
    })
  })
  it('does not invent chain/window for a plain cron job', () => {
    expect(continuationData({ stationId: 'kpfk', source: 'cron' })).toEqual({ stationId: 'kpfk' })
  })
  it('keeps a show-scoped compliance run scoped', () => {
    expect(continuationData({ stationId: 'kpfk', show_key: 'dn' })).toEqual({ stationId: 'kpfk', show_key: 'dn' })
  })
  it('tolerates missing job data', () => {
    expect(continuationData(undefined)).toEqual({ stationId: undefined })
  })
})
