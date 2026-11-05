// Word-list matching for the profanity check. Pure — unit-tested and shared by
// the compliance worker's word-list check and its AI-flag de-duplication.
//
// Why not `\b`: JavaScript's \b only treats ASCII [A-Za-z0-9_] as word
// characters, so an accented letter counts as a boundary. "vehículo",
// "artículo" and "espectáculo" therefore matched the list word "culo" — 243 of
// KPFK's first 1,291 profanity flags (19%) were that bug. Unicode letter/number
// lookarounds treat "í" as part of the word, like a human reader does.

export function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu')
}

// FCC restricted hours are 6am–10pm local; outside them (safe harbor) profanity
// and indecency are informational warnings. A show can straddle a boundary
// (a 5am–7am block), so the check works on the moment a word aired:
// show start + the flag's offset into the audio. When the offset is unknown
// (excerpt not found in the captions), it stays restricted if ANY part of the
// show falls in 6am–10pm — never inherit safe harbor by default.
export type RestrictedAt = (offsetSec: number | null) => boolean

export function restrictedHoursCheck(airStart: string | null, durationMin: number | null): RestrictedAt {
  if (!airStart) return () => true // unknown air time: assume restricted
  const [h, m] = airStart.split(':').map(Number)
  const startMin = h * 60 + (m || 0)
  const isRestrictedMinute = (minute: number) => {
    const hour = Math.floor((((minute % 1440) + 1440) % 1440) / 60)
    return hour >= 6 && hour < 22
  }
  const lengthMin = Math.max(1, durationMin ?? 60)
  let anyRestricted = false
  for (let t = 0; t < lengthMin && !anyRestricted; t += 5) anyRestricted = isRestrictedMinute(startMin + t)
  anyRestricted ||= isRestrictedMinute(startMin + lengthMin - 1)
  return (offsetSec) => (offsetSec == null ? anyRestricted : isRestrictedMinute(startMin + offsetSec / 60))
}

// Where each whole-word occurrence of `word` sits: its index in the transcript
// and the start time of the caption cue it was spoken in. The transcript and
// the captions come from the same transcription, so the k-th match in one is
// the k-th match in the other; pairing by order (with the same Unicode-aware
// pattern on both sides) times each hit at its own cue. A plain substring
// search over cues used to time "fuck" at the first "motherfucking" and "culo"
// at "vehículo", sending "Listen" to the wrong moment. `time` is null when the
// captions have fewer matches than the transcript (no VTT, or a word split
// across cues).
export interface CueLike { startSeconds: number; text: string }
export interface WordOccurrence { index: number; time: number | null }

export function wordOccurrences(transcript: string, cues: CueLike[], word: string): WordOccurrence[] {
  const times: number[] = []
  for (const cue of cues) {
    const p = wordPattern(word)
    while (p.exec(cue.text) !== null) times.push(Math.floor(cue.startSeconds))
  }
  const out: WordOccurrence[] = []
  const p = wordPattern(word)
  let m: RegExpExecArray | null
  while ((m = p.exec(transcript)) !== null) {
    out.push({ index: m.index, time: times[out.length] ?? null })
  }
  return out
}
