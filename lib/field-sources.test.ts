import { describe, it, expect } from 'vitest'
import {
  buildHumanFieldSources,
  applyAi,
  setFieldChoice,
  resolveChoice,
  hasConflict,
} from './field-sources'

const human = (over: Partial<Record<'host' | 'guest' | 'issue_category' | 'summary', string | null>> = {}) => ({
  host: null, guest: null, issue_category: null, summary: null, ...over,
})

describe('buildHumanFieldSources', () => {
  it('seeds human copies, active=human where present else ai', () => {
    const fs = buildHumanFieldSources(human({ host: 'Sonali', summary: 'A rundown' }))
    expect(fs.host).toEqual({ human: 'Sonali', ai: null, active: 'human' })
    expect(fs.guest).toEqual({ human: null, ai: null, active: 'ai' })
    expect(fs.summary!.active).toBe('human')
  })
})

describe('applyAi default policy', () => {
  it('human wins for host/guest/summary, AI wins for issue_category when both exist', () => {
    const seeded = buildHumanFieldSources(
      human({ host: 'H', guest: 'G', issue_category: 'Health', summary: 'human text' })
    )
    const { fieldSources, flat } = applyAi(seeded, {
      host: 'H (AI)', guest: 'G (AI)', issue_category: 'Health, Immigration', summary: 'ai text',
    })
    expect(flat.host).toBe('H')
    expect(flat.guest).toBe('G')
    expect(flat.summary).toBe('human text')
    // categories default to AI
    expect(flat.issue_category).toBe('Health, Immigration')
    expect(fieldSources.issue_category!.active).toBe('ai')
    // both copies preserved
    expect(fieldSources.host).toEqual({ human: 'H', ai: 'H (AI)', active: 'human' })
  })

  it('falls back to AI when there is no human value (RSS episode)', () => {
    const { fieldSources, flat } = applyAi(null, {
      host: 'AI host', guest: null, issue_category: 'Education', summary: 'AI summary',
    })
    expect(flat.host).toBe('AI host')
    expect(flat.summary).toBe('AI summary')
    expect(fieldSources.host!.active).toBe('ai')
    expect(fieldSources.guest!.active).toBe('ai') // no copy at all → resolves null
    expect(resolveChoice(fieldSources.guest)).toBeNull()
  })

  it('does not override a pinned field on re-summarize', () => {
    // human pinned issue_category to "human" even though policy default is AI
    const pinned = setFieldChoice(
      buildHumanFieldSources(human({ issue_category: 'Health' })),
      'issue_category',
      'human',
    ).fieldSources
    const { fieldSources, flat } = applyAi(pinned, {
      host: null, guest: null, issue_category: 'Health, Immigration', summary: null,
    })
    expect(fieldSources.issue_category!.active).toBe('human')
    expect(flat.issue_category).toBe('Health')
  })
})

describe('setFieldChoice', () => {
  it('toggles active to AI and pins it', () => {
    const seeded = buildHumanFieldSources(human({ summary: 'human' }))
    const withAi = applyAi(seeded, human({ summary: 'ai' })).fieldSources
    const { fieldSources, value } = setFieldChoice(withAi, 'summary', 'ai')
    expect(value).toBe('ai')
    expect(fieldSources.summary!.active).toBe('ai')
    expect(fieldSources.summary!.pinned).toBe(true)
  })

  it('records a manual override value', () => {
    const { fieldSources, value } = setFieldChoice(null, 'host', 'manual', 'Hand Typed')
    expect(value).toBe('Hand Typed')
    expect(fieldSources.host).toMatchObject({ manual: 'Hand Typed', active: 'manual', pinned: true })
  })
})

describe('hasConflict', () => {
  it('true only when human and ai both exist and differ', () => {
    expect(hasConflict({ human: 'a', ai: 'b', active: 'human' })).toBe(true)
    expect(hasConflict({ human: 'a', ai: 'a', active: 'human' })).toBe(false)
    expect(hasConflict({ human: 'a', ai: null, active: 'human' })).toBe(false)
    expect(hasConflict(undefined)).toBe(false)
  })
})
