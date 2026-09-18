import { describe, it, expect } from 'vitest'
import {
  applyAi,
  applyHuman,
  buildHumanFieldSources,
  hasConflict,
  resolveChoice,
  setFieldChoice,
  type DualField,
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

// --- applyHuman: the Confessor re-sync path ------------------------------
// Ingest captures the pubfile once. A producer who fills in a guest or fixes a
// name afterwards must reach us without destroying anything a human decided
// inside QIR.
describe('applyHuman', () => {
  const H = (h: Partial<Record<DualField, string | null>>): Record<DualField, string | null> => ({
    host: null, guest: null, issue_category: null, summary: null, ...h,
  })

  it('fills a field the producer left blank at air time', () => {
    const before = buildHumanFieldSources(H({ host: 'Margaret Prescod' }))
    const { fieldSources, flat, changed } = applyHuman(before, H({ host: 'Margaret Prescod', guest: 'Jane Doe' }))
    expect(flat.guest).toBe('Jane Doe')
    expect(fieldSources.guest?.human).toBe('Jane Doe')
    expect(changed).toEqual(['guest'])
  })

  it('reports nothing changed when the pubfile is untouched', () => {
    const before = buildHumanFieldSources(H({ host: 'A', guest: 'B' }))
    expect(applyHuman(before, H({ host: 'A', guest: 'B' })).changed).toEqual([])
  })

  it('never touches the AI copy', () => {
    const seeded = buildHumanFieldSources(H({ summary: 'human v1' }))
    const withAi = applyAi(seeded, H({ summary: 'ai summary', issue_category: 'Health' }))
    const after = applyHuman(withAi.fieldSources, H({ summary: 'human v2' }))
    expect(after.fieldSources.summary?.ai).toBe('ai summary')
    expect(after.fieldSources.issue_category?.ai).toBe('Health')
  })

  it('never touches a manual override, and manual keeps winning', () => {
    const seeded = buildHumanFieldSources(H({ host: 'upstream A' }))
    const pinned = setFieldChoice(seeded, 'host', 'manual', 'hand-typed')
    const after = applyHuman(pinned.fieldSources, H({ host: 'upstream B' }))
    expect(after.fieldSources.host?.manual).toBe('hand-typed')
    expect(after.flat.host).toBe('hand-typed')
  })

  it('refreshes the human copy of a PINNED field without changing what wins', () => {
    const seeded = buildHumanFieldSources(H({ guest: 'old guest' }))
    const withAi = applyAi(seeded, H({ guest: 'ai guest' }))
    // Someone deliberately chose the AI value.
    const pinned = setFieldChoice(withAi.fieldSources, 'guest', 'ai')
    const after = applyHuman(pinned.fieldSources, H({ guest: 'corrected guest' }))
    expect(after.fieldSources.guest?.human).toBe('corrected guest') // copy refreshed
    expect(after.fieldSources.guest?.active).toBe('ai')             // choice respected
    expect(after.fieldSources.guest?.pinned).toBe(true)             // still pinned
    expect(after.flat.guest).toBe('ai guest')
  })

  it('keeps the default policy for un-pinned fields (issue_category still prefers AI)', () => {
    const seeded = buildHumanFieldSources(H({ issue_category: 'Arts' }))
    const withAi = applyAi(seeded, H({ issue_category: 'Immigration' }))
    const after = applyHuman(withAi.fieldSources, H({ issue_category: 'Arts & Culture' }))
    expect(after.fieldSources.issue_category?.human).toBe('Arts & Culture')
    expect(after.flat.issue_category).toBe('Immigration')
  })

  it('falls back to AI when a segment is deleted upstream', () => {
    const seeded = buildHumanFieldSources(H({ summary: 'human text' }))
    const withAi = applyAi(seeded, H({ summary: 'ai text' }))
    expect(withAi.flat.summary).toBe('human text')
    const after = applyHuman(withAi.fieldSources, H({ summary: null }))
    expect(after.flat.summary).toBe('ai text')
    expect(after.changed).toContain('summary')
  })

  it('works on an episode that has no field_sources yet (RSS-ingested)', () => {
    const { fieldSources, flat } = applyHuman(null, H({ host: 'New Host', guest: 'New Guest' }))
    expect(flat.host).toBe('New Host')
    expect(fieldSources.host?.active).toBe('human')
  })

  it('leaves a conflict visible after a refresh', () => {
    const seeded = buildHumanFieldSources(H({ host: 'Human A' }))
    const withAi = applyAi(seeded, H({ host: 'AI B' }))
    const after = applyHuman(withAi.fieldSources, H({ host: 'Human C' }))
    expect(hasConflict(after.fieldSources.host)).toBe(true)
  })
})
