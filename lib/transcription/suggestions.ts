// Suggested corrections — pure filtering of the miner's raw candidates.
// The database finds "<First> <Word>" / "<Word> <Last>" pairs that look like a
// show's known names (supabase/migrations/047 mine_name_variants); this decides
// which are worth putting in front of a person.

import { applyCorrections, type Correction } from './corrections'
import { looksLikePersonName } from './names'

export interface MinedVariant {
  show_key: string
  name: string
  variant: string
  occurrences: number
  episodes: number
  sample_episode_id: number | null
}

export interface MinerContext {
  /** Every name in the station's vocabulary, any show, lower-cased: a variant
   *  that IS someone we know ("Taylor Nichols") is a different person. */
  knownNames: Set<string>
  /** The rules that would apply to the show's episodes today. */
  rulesForShow: (showKey: string) => Correction[]
}

/** Keep candidates that look like a misspelling of the name and that no
 *  existing rule already fixes. */
export function filterMinedVariants(rows: MinedVariant[], ctx: MinerContext): MinedVariant[] {
  return rows.filter((r) => {
    const variant = r.variant.trim()
    if (!looksLikePersonName(variant)) return false
    if (variant.toLowerCase() === r.name.trim().toLowerCase()) return false
    if (ctx.knownNames.has(variant.toLowerCase())) return false
    const fixed = applyCorrections(variant, ctx.rulesForShow(r.show_key))
    return fixed === variant
  })
}

/** ~160 characters of transcript around the first occurrence, for the reviewer. */
export function snippetAround(text: string, needle: string, radius = 80): string | null {
  const i = text.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return null
  const start = Math.max(0, i - radius)
  const end = Math.min(text.length, i + needle.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}
