// Whisper vocabulary hint — pure functions. See docs/names-vocabulary-scan.md §5.
//
// Groq's Whisper accepts a `prompt` that biases spelling. Measured on real
// KPFK audio (2026-11-04):
//   - a SHORT comma list of names fixes them ("Carrie" ×5 → "Cary" ×5);
//   - a sentence with labels ("Hosts: … Guests: …") leaks the label words into
//     the transcript and replaced up to 247 words of real speech;
//   - a long list (~55 names) fixed nothing — Whisper keeps only the tail;
//   - on MUSIC every prompt made it worse (prompt names repeated through the
//     songs), and Groq's no_speech_prob is 0.00 even on pure music, so music
//     can't be detected per segment — it must be decided per show;
//   - Groq REJECTS an oversized prompt with HTTP 400 (accepted 888 ASCII
//     bytes, rejected 1,068) instead of trimming it.
// So: names only, comma-separated, de-duplicated, hard byte cap, never for
// music shows, and drop any segment that is just the prompt echoed back.

import type { NormalizedSegment } from './types'

/** Hard cap, in UTF-8 bytes — well under Groq's observed rejection point. */
export const VOCABULARY_PROMPT_MAX_BYTES = 600

const encoder = new TextEncoder()
const byteLength = (s: string) => encoder.encode(s).length

export interface VocabularyInput {
  /** Station-wide terms first (call letters, network). */
  stationTerms: string[]
  /** This show's hosts and regulars (every feed of its show group). */
  showNames: string[]
  /** Names known for THIS episode before transcription (Confessor host/guest). */
  episodeNames: string[]
}

/**
 * Build the prompt: station terms, then show names, then episode names,
 * case-insensitively de-duplicated (first spelling wins), comma-separated,
 * stopping before the byte cap. Returns '' when there are no show or episode
 * names — station terms alone aren't worth the risk.
 */
export function buildVocabularyPrompt(
  input: VocabularyInput,
  maxBytes: number = VOCABULARY_PROMPT_MAX_BYTES,
): string {
  if (!input.showNames.length && !input.episodeNames.length) return ''
  const seen = new Set<string>()
  const parts: string[] = []
  let size = 0
  for (const raw of [...input.stationTerms, ...input.showNames, ...input.episodeNames]) {
    const term = raw.replace(/[,\n]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    const added = byteLength(term) + (parts.length ? 2 : 0)
    if (size + added > maxBytes) break
    seen.add(key)
    parts.push(term)
    size += added
  }
  return parts.join(', ')
}

/**
 * Should this episode get a hint? Never for music (the episode's category, as
 * ingest stamped it — e.g. "Music"; Perspectiva's talk episodes are "Español").
 */
export function shouldUseVocabularyHint(category: string | null | undefined): boolean {
  return !/music/i.test(category ?? '')
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Remove what a prompted run invents: segments that are the prompt's name list
 * read back ("Awakenings, Michelle Coltrane, Alice Coltrane"). A host saying
 * their own name ("This is Cary Harrison") is KEPT — an echo is a contiguous
 * piece of the list with at least two show/episode names, or three-plus with
 * almost nothing else. Station terms ("KPFK, Pacifica Radio") never count
 * toward an echo: a spoken station ID must survive (compliance reads it).
 * Segments this can't judge (non-Latin script, "♪") are always kept. Only
 * call this on output produced WITH a prompt.
 */
export function dropPromptEchoSegments(
  segments: NormalizedSegment[],
  prompt: string,
  stationTerms: string[] = [],
): NormalizedSegment[] {
  if (!prompt) return segments
  const ignore = new Set(stationTerms.map(norm))
  const allTerms = prompt.split(',').map(norm).filter(Boolean)
  const terms = allTerms.filter((t) => !ignore.has(t))
  const promptNorm = allTerms.join(' ')
  const termTokens = new Set(promptNorm.split(' '))
  const out: NormalizedSegment[] = []
  for (const seg of segments) {
    const t = norm(seg.text)
    if (!t) {
      out.push(seg)
      continue
    }
    const padded = ` ${t} `
    const termsHit = terms.filter((term) => padded.includes(` ${term} `)).length
    const otherTokens = t.split(' ').filter((x) => !termTokens.has(x)).length
    const contiguousEcho = termsHit >= 2 && ` ${promptNorm} `.includes(padded)
    const listEcho = termsHit >= 3 && otherTokens <= 1
    if (contiguousEcho || listEcho) continue
    out.push(seg)
  }
  return out
}
