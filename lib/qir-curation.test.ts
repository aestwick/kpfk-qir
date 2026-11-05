import { describe, it, expect } from 'vitest'
import { parseCurationResponse, selectionLine, selectionUserMessage, selectedIdsFor, rewriteInput, rewriteUserMessage, rewriteFor, applyCuration, mapLimit } from './qir-curation'
import type { QirEntry } from './qir-format'

const longSummary =
  'Ian Masters introduces Lincoln Mitchell, who argues the administration is driving a shift towards a plutocracy, with wealth ' +
  'concentrated among a handful of billionaire donors who now shape tax, labor and antitrust policy through their foundations and super PACs. Later, Allan Lichtman lays out his keys to the 2028 race and why he expects the incumbent ' +
  'party to lose ground in the midterms, citing turnout data from Georgia and Arizona.'

const entry: QirEntry = {
  episode_id: 6162,
  show_name: 'Background Briefing',
  host: 'Ian Masters',
  air_date: 'July 14, 2026',
  start_time: '5:00 PM',
  duration: 60,
  headline: 'Plutocracy and the midterms',
  guest: 'Lincoln Mitchell; Allan Lichtman',
  summary: longSummary,
  issue_category: 'Government / Politics',
}

describe('parseCurationResponse', () => {
  it('reads {id, topic, description} objects', () => {
    const p = parseCurationResponse({ Health: [{ id: 1, topic: 'T', description: 'D' }], 'Gov': [{ id: 2 }] })
    expect(Array.from(p.ids)).toEqual([1, 2])
    expect(p.rewrites.get(1)).toEqual({ topic: 'T', description: 'D' })
    expect(p.rewrites.get(2)).toEqual({ topic: undefined, description: undefined })
  })
  it('accepts bare ids (selection-only prompt) with no rewrites', () => {
    const p = parseCurationResponse({ Health: [101, 202] })
    expect(Array.from(p.ids)).toEqual([101, 202])
    expect(p.rewrites.size).toBe(0)
  })
  it('ignores junk', () => {
    expect(parseCurationResponse(null).ids.size).toBe(0)
    expect(parseCurationResponse({ x: 'nope', y: [{ id: 'str' }, null] }).ids.size).toBe(0)
  })
})

describe('selection vs rewrite input', () => {
  it('selection line is a snippet and now names the host', () => {
    const line = selectionLine(entry)
    expect(line).toContain('Host: Ian Masters')
    expect(line).not.toContain('turnout data') // the summary's later segment is past the 200-char snippet
  })
  it('rewrite input carries the FULL summary and host', () => {
    const parsed = JSON.parse(rewriteInput([entry]))
    expect(parsed[0]).toMatchObject({ id: 6162, host: 'Ian Masters', show_title: 'Background Briefing', air_time: '5:00 PM' })
    expect(parsed[0].summary).toBe(longSummary)
    expect(parsed[0].summary).toContain('Allan Lichtman')
  })
  it('rewrite message sends exactly one episode, pinned to its id and category', () => {
    const msg = rewriteUserMessage(entry)
    expect(msg).toContain('under the key "Government / Politics"')
    expect(msg).toContain('with its id 6162')
    expect(JSON.parse(msg.slice(msg.indexOf('['))).length).toBe(1)
  })
})

describe('rewriteFor', () => {
  it('takes the rewrite only under this entry’s own id', () => {
    expect(rewriteFor(entry, parseCurationResponse({ g: [{ id: 6162, topic: 'T', description: 'D' }] }))).toEqual({ topic: 'T', description: 'D' })
  })
  it('rejects a description returned under a different id (the cross-wiring bug)', () => {
    expect(rewriteFor(entry, parseCurationResponse({ g: [{ id: 9142, topic: 'CNN ban', description: 'A federal judge…' }] }))).toBeUndefined()
  })
  it('rejects an empty description', () => {
    expect(rewriteFor(entry, parseCurationResponse({ g: [{ id: 6162, topic: 'T', description: '  ' }] }))).toBeUndefined()
  })
})

describe('applyCuration', () => {
  it('files the rewrite written from the full summary', () => {
    const out = applyCuration(entry, { topic: 'Plutocracy, midterm keys', description: 'Full-summary description.' })
    expect(out).toMatchObject({ headline: 'Plutocracy, midterm keys', summary: 'Full-summary description.' })
  })
  it('without a rewrite, files the episode’s own headline and full summary (nothing from the selection pass)', () => {
    expect(applyCuration(entry, undefined)).toEqual(entry)
  })
  it('ignores blank rewrite strings', () => {
    expect(applyCuration(entry, { topic: '  ', description: '' })).toEqual(entry)
  })
})

describe('mapLimit', () => {
  it('keeps order and caps concurrency', async () => {
    let inFlight = 0, peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50, 60])
    expect(peak).toBe(2)
  })
  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})

describe('per-category selection', () => {
  const other: QirEntry = { ...entry, episode_id: 9142, headline: 'Banking and empire', guest: 'Alex Cranor' }

  it('asks for one category only, keyed by it, listing only its candidates', () => {
    const msg = selectionUserMessage({
      category: 'Government / Politics',
      candidates: [entry, other],
      maxPerCategory: 12,
      quarterMonths: ['July', 'August', 'September'],
      guidance: 'Prefer local stories',
    })
    expect(msg).toContain('Select up to 12 entries in the category "Government / Politics"')
    expect(msg).toContain('under the key "Government / Politics"')
    expect(msg).toContain('## Government / Politics (2 entries)')
    expect(msg).toContain('ID:6162')
    expect(msg).toContain('ID:9142')
    expect(msg).toContain('July, August, September')
    expect(msg).toContain('Prefer local stories')
  })

  it('keeps only offered ids, in returned order, capped', () => {
    const parsed = parseCurationResponse({ 'Government / Politics': [9142, 5555, { id: 6162, description: 'x' }] })
    expect(selectedIdsFor(parsed, [entry, other], 12)).toEqual([9142, 6162])
    expect(selectedIdsFor(parsed, [entry, other], 1)).toEqual([9142])
  })

  it('accepts picks returned under a different key (the model renamed the category)', () => {
    const parsed = parseCurationResponse({ Politics: [6162] })
    expect(selectedIdsFor(parsed, [entry, other], 12)).toEqual([6162])
  })
})
