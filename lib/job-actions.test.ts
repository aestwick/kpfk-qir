import { describe, it, expect } from 'vitest'
import { JOB_ACTION_ACCESS, jobActionAccess, describePause } from './job-actions'

describe('jobActionAccess', () => {
  it('lets station editors pause/resume their own station', () => {
    expect(jobActionAccess('pause_pipeline')).toBe('editor')
    expect(jobActionAccess('resume_pipeline')).toBe('editor')
  })

  it('reserves platform-wide controls for super-admins', () => {
    expect(jobActionAccess('pause_all')).toBe('super')
    expect(jobActionAccess('resume_all')).toBe('super')
    expect(jobActionAccess('set_pipeline_mode')).toBe('super')
  })

  it('keeps station-scoped retry/clear and enqueues at editor', () => {
    for (const a of ['retry_failed', 'clear_failed', 'advance-pipeline', 'ingest', 'transcribe', 'summarize', 'compliance']) {
      expect(jobActionAccess(a)).toBe('editor')
    }
  })

  it('treats unknown/malformed actions as editor (the route 400s them)', () => {
    expect(jobActionAccess('nope')).toBe('editor')
    expect(jobActionAccess(undefined)).toBe('editor')
    expect(jobActionAccess(42)).toBe('editor')
  })

  it('every action that writes global state is super-only', () => {
    const globalWriters = ['pause_all', 'resume_all', 'set_pipeline_mode']
    for (const a of globalWriters) expect(JOB_ACTION_ACCESS[a]).toBe('super')
  })
})

describe('describePause', () => {
  it('reports running when neither flag is set', () => {
    expect(describePause({ global: false, station: false })).toMatchObject({ paused: false })
  })
  it('names the station pause', () => {
    expect(describePause({ global: false, station: true }).headline).toBe('This station is paused')
  })
  it('says the global switch is on even if the station is not paused', () => {
    const d = describePause({ global: true, station: false })
    expect(d.paused).toBe(true)
    expect(d.headline).toBe('All stations are paused')
    expect(d.detail).toMatch(/super-admin/)
  })
  it('an over-budget station is not shown as running', () => {
    const d = describePause({ global: false, station: false, overBudget: true })
    expect(d.paused).toBe(true)
    expect(d.headline).toMatch(/spending limit/)
  })
  it('a pause flag takes precedence over the budget message', () => {
    expect(describePause({ global: false, station: true, overBudget: true }).headline).toBe('This station is paused')
  })
  it('mentions both when both are on', () => {
    expect(describePause({ global: true, station: true }).detail).toMatch(/also paused on its own/)
  })
})
