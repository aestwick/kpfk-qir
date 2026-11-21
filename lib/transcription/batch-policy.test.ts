import { describe, it, expect } from 'vitest'
import { pickBatchCandidates, resolveBatchSettings, fitsBatchSizeLimit, DEFAULT_BATCH_SETTINGS } from './batch-policy'

const now = new Date('2026-11-21T12:00:00Z')
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()
const ep = (id: number, ageH: number, extra: Partial<{ neverBatched: boolean; priority: boolean }> = {}) => ({
  id, created_at: hoursAgo(ageH), neverBatched: true, ...extra,
})

describe('pickBatchCandidates', () => {
  const s = DEFAULT_BATCH_SETTINGS

  it('does nothing below the backlog threshold — normal days stay on the fast path', () => {
    const small = Array.from({ length: 19 }, (_, i) => ep(i + 1, 48))
    expect(pickBatchCandidates(small, s, { windowed: false, now })).toEqual([])
  })

  it('in a backlog, batches only episodes that have already waited 6h+', () => {
    const backlog = [
      ...Array.from({ length: 15 }, (_, i) => ep(i + 1, 72)), // stuck since the incident
      ...Array.from({ length: 10 }, (_, i) => ep(100 + i, 1)), // just ingested
    ]
    const picked = pickBatchCandidates(backlog, s, { windowed: false, now })
    expect(picked.map((e) => e.id)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
  })

  it('never re-batches an episode that already came back from batch, nor priority work', () => {
    const backlog = Array.from({ length: 25 }, (_, i) => ep(i + 1, 10))
    backlog[0].neverBatched = false
    ;(backlog[1] as { priority?: boolean }).priority = true
    const ids = pickBatchCandidates(backlog, s, { windowed: false, now }).map((e) => e.id)
    expect(ids).not.toContain(1)
    expect(ids).not.toContain(2)
    expect(ids).toHaveLength(23)
  })

  it('windowed backfills batch regardless of backlog size or age', () => {
    const picked = pickBatchCandidates([ep(1, 0), ep(2, 0)], s, { windowed: true, now })
    expect(picked).toHaveLength(2)
  })

  it('caps one batch and takes the oldest first', () => {
    const many = Array.from({ length: 300 }, (_, i) => ep(i + 1, 10 + i))
    const picked = pickBatchCandidates(many, { ...s, maxPerBatch: 50 }, { windowed: false, now })
    expect(picked).toHaveLength(50)
    expect(picked[0].id).toBe(300)
  })

  it('is off when disabled', () => {
    const backlog = Array.from({ length: 40 }, (_, i) => ep(i + 1, 48))
    expect(pickBatchCandidates(backlog, { ...s, enabled: false }, { windowed: true, now })).toEqual([])
  })
})

describe('resolveBatchSettings', () => {
  it('defaults when unset or malformed', () => {
    expect(resolveBatchSettings(null)).toEqual(DEFAULT_BATCH_SETTINGS)
    expect(resolveBatchSettings('yes')).toEqual(DEFAULT_BATCH_SETTINGS)
  })
  it('takes valid overrides and ignores bad ones', () => {
    const r = resolveBatchSettings({ enabled: false, backlog_threshold: 50, min_age_hours: -3, max_file_mb: '100' })
    expect(r.enabled).toBe(false)
    expect(r.backlogThreshold).toBe(50)
    expect(r.minAgeHours).toBe(DEFAULT_BATCH_SETTINGS.minAgeHours)
    expect(r.maxFileMb).toBe(DEFAULT_BATCH_SETTINGS.maxFileMb)
  })
})

describe('fitsBatchSizeLimit', () => {
  it('fits a 1-hour KPFK MP3 (57.7 MB) but not a 2-hour one (~115 MB)', () => {
    expect(fitsBatchSizeLimit(57_660_400, DEFAULT_BATCH_SETTINGS)).toBe(true)
    expect(fitsBatchSizeLimit(115_320_800, DEFAULT_BATCH_SETTINGS)).toBe(false)
  })
  it('keeps unknown sizes on the sync path', () => {
    expect(fitsBatchSizeLimit(null, DEFAULT_BATCH_SETTINGS)).toBe(false)
  })
})
