// VTT parsing + cue model for transcript search.
//
// Pure functions, no DB (per the engineering directives in
// ideas/TRANSCRIPT_SEARCH_SPEC.md §13). Two jobs:
//   1. parseVtt — turn a WEBVTT blob into timed cues, used by the transcribe
//      worker and the backfill to populate the transcript_cues table.
//   2. findCueForPhrase — the lean runtime aligner used as a fallback when the
//      cue table has no row for an episode. Returns null rather than guessing a
//      time: a wrong timestamp in an FCC proof is worse than no timestamp.

export interface VttCue {
  /** 1-based cue index in file order. */
  index: number
  startMs: number
  endMs: number
  text: string
}

// Matches a VTT/SRT timing line: HH:MM:SS.mmm --> HH:MM:SS.mmm (',' or '.' ok).
const TIMING_RE =
  /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/

function hmsToMs(h: string, m: string, s: string, ms: string): number {
  return (+h * 3600 + +m * 60 + +s) * 1000 + +ms
}

/**
 * Parse a WEBVTT string into timed cues. Tolerant of the optional numeric cue id
 * line our transcribe worker writes (see buildVtt in workers/transcribe.ts), of
 * blank-line-separated blocks, and of multi-line cue text. Blocks without a
 * timing line (the `WEBVTT` header, NOTE blocks) are skipped.
 */
export function parseVtt(vtt: string | null | undefined): VttCue[] {
  if (!vtt) return []
  const blocks = vtt.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const cues: VttCue[] = []
  let index = 0

  for (const block of blocks) {
    const lines = block.split('\n')
    const timingLineIdx = lines.findIndex((l) => TIMING_RE.test(l))
    if (timingLineIdx === -1) continue

    const m = lines[timingLineIdx].match(TIMING_RE)
    if (!m) continue
    const startMs = hmsToMs(m[1], m[2], m[3], m[4])
    const endMs = hmsToMs(m[5], m[6], m[7], m[8])

    const text = lines
      .slice(timingLineIdx + 1)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue

    index += 1
    cues.push({ index, startMs, endMs, text })
  }

  return cues
}

/** Normalize text for forgiving phrase matching: lowercase, strip punctuation,
 *  collapse whitespace. Unicode-aware so accented Spanish text matches. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Find the cue where a phrase begins, or null if it is not present. Tries a
 * single-cue containment first, then a small sliding window so a phrase split
 * across consecutive cues still resolves to its starting cue. Returns null on no
 * match — never a guessed cue.
 */
export function findCueForPhrase(cues: VttCue[], phrase: string): VttCue | null {
  const needle = normalizeForMatch(phrase)
  if (!needle) return null

  const normalized = cues.map((c) => normalizeForMatch(c.text))

  for (let i = 0; i < cues.length; i++) {
    if (normalized[i].includes(needle)) return cues[i]
  }

  // Cross-cue: a phrase may span cue boundaries. Slide a bounded window.
  const MAX_WINDOW = 6
  for (let i = 0; i < cues.length; i++) {
    let acc = normalized[i]
    for (let j = i + 1; j < cues.length && j - i < MAX_WINDOW; j++) {
      acc += ' ' + normalized[j]
      if (acc.includes(needle)) return cues[i]
    }
  }

  return null
}
