import { describe, it, expect } from 'vitest'
import { chunkCues, CHUNK_TARGET_WORDS } from './transcript-chunks'
import type { VttCue } from './vtt'

function cue(index: number, startMs: number, endMs: number, text: string): VttCue {
  return { index, startMs, endMs, text }
}

// A cue of `n` single-letter "words" so word-budget math is easy to reason about.
function words(n: number): string {
  return Array.from({ length: n }, () => 'w').join(' ')
}

describe('chunkCues', () => {
  it('returns no chunks for an empty cue list', () => {
    expect(chunkCues([])).toEqual([])
  })

  it('packs several small cues into one chunk under the word target', () => {
    const cues = [
      cue(1, 0, 2000, 'Welcome to Uprising today'),
      cue(2, 2000, 4000, 'we look at the latest'),
      cue(3, 4000, 6000, 'measles outbreak data'),
    ]
    const chunks = chunkCues(cues)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({
      chunkIdx: 0,
      startMs: 0,
      endMs: 6000,
      content: 'Welcome to Uprising today we look at the latest measles outbreak data',
    })
  })

  it('starts a new chunk once the running chunk reaches the word target', () => {
    // Two cues that each hold the full target -> two chunks (adding the 2nd would
    // exceed the target, so the 1st flushes first).
    const cues = [
      cue(1, 0, 1000, words(CHUNK_TARGET_WORDS)),
      cue(2, 1000, 2000, words(CHUNK_TARGET_WORDS)),
    ]
    const chunks = chunkCues(cues)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ chunkIdx: 0, startMs: 0, endMs: 1000 })
    expect(chunks[1]).toMatchObject({ chunkIdx: 1, startMs: 1000, endMs: 2000 })
  })

  it('keeps an over-target single cue as its own chunk (never splits a cue)', () => {
    const cues = [cue(1, 0, 5000, words(CHUNK_TARGET_WORDS * 3))]
    const chunks = chunkCues(cues)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].startMs).toBe(0)
    expect(chunks[0].endMs).toBe(5000)
  })

  it('carries start_ms from the first cue and end_ms from the last cue of a chunk', () => {
    const half = Math.ceil(CHUNK_TARGET_WORDS / 2)
    const cues = [
      cue(1, 100, 200, words(half)),
      cue(2, 200, 350, words(half)),
    ]
    const chunks = chunkCues(cues)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].startMs).toBe(100)
    expect(chunks[0].endMs).toBe(350)
  })

  it('assigns contiguous 0-based chunk indexes', () => {
    const cues = Array.from({ length: 5 }, (_, i) =>
      cue(i + 1, i * 1000, (i + 1) * 1000, words(CHUNK_TARGET_WORDS))
    )
    const chunks = chunkCues(cues)
    expect(chunks.map((c) => c.chunkIdx)).toEqual([0, 1, 2, 3, 4])
  })
})
