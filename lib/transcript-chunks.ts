// Transcript chunking for semantic search (Phase 2 of ideas/TRANSCRIPT_SEARCH_SPEC.md).
//
// Pure functions, no DB and no network (per the §13 engineering directives —
// mirrors lib/vtt.ts). Groups the VTT cues into ~paragraph-sized passages so each
// embedded chunk carries a real start_ms/end_ms range for the audio deep-link.
// Chunking from the cues (not the reflowed plain transcript) is what makes the
// timestamp a first-class fact, exactly as the cue table does for lexical search.

import type { VttCue } from './vtt'

export interface TranscriptChunk {
  /** 0-based chunk index in cue order. */
  chunkIdx: number
  startMs: number
  endMs: number
  content: string
}

// ~200 words ≈ ~260 tokens for text-embedding-3-small: small enough to localize a
// timestamp, large enough to carry context for a concept match. A single cue that
// already exceeds this still becomes its own chunk (never split mid-cue, so the
// timestamps stay exact).
export const CHUNK_TARGET_WORDS = 200

function wordCount(s: string): number {
  const t = s.trim()
  return t ? t.split(/\s+/).length : 0
}

/**
 * Group consecutive cues into chunks of roughly `targetWords` words. A new chunk
 * starts when adding the next cue would push the running chunk over the target
 * (but every chunk holds at least one cue). start_ms is the first cue's start,
 * end_ms the last cue's end. Deterministic — the same VTT always yields the same
 * chunks, so re-embedding is idempotent against the unique (episode_id, chunk_idx).
 */
export function chunkCues(
  cues: VttCue[],
  targetWords: number = CHUNK_TARGET_WORDS
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = []
  let buf: VttCue[] = []
  let words = 0
  let idx = 0

  const flush = () => {
    if (!buf.length) return
    const content = buf
      .map((c) => c.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (content) {
      chunks.push({
        chunkIdx: idx++,
        startMs: buf[0].startMs,
        endMs: buf[buf.length - 1].endMs,
        content,
      })
    }
    buf = []
    words = 0
  }

  for (const cue of cues) {
    const w = wordCount(cue.text)
    // Start a fresh chunk before this cue once the current one has reached target.
    if (buf.length && words + w > targetWords) flush()
    buf.push(cue)
    words += w
  }
  flush()

  return chunks
}
