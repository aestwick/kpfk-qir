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
