import { describe, it, expect } from 'vitest'
import {
  tokenize,
  parseSearchQuery,
  lookupWords,
  chooseVariants,
  alsoMatched,
  buildTsQuery,
  reciprocalRankFusion,
  type VariantRow,
} from './search-query'

const row = (term: string, variant: string, kind: string, sim = 1, ndoc = 5): VariantRow => ({ term, variant, kind, sim, ndoc })

describe('tokenize', () => {
  it('lowercases, keeps accents, splits punctuation', () => {
    expect(tokenize("Movilización, don't Fabara-Anelli!")).toEqual(['movilización', 'don', 't', 'fabara', 'anelli'])
  })
})

describe('parseSearchQuery', () => {
  it('ANDs plain words', () => {
    expect(parseSearchQuery('housing crisis').clauses).toEqual([
      { anyOf: [{ kind: 'word', word: 'housing' }] },
      { anyOf: [{ kind: 'word', word: 'crisis' }] },
    ])
  })
  it('keeps quoted phrases and exclusions', () => {
    const q = parseSearchQuery('"war on voting" -ballot')
    expect(q.clauses).toEqual([{ anyOf: [{ kind: 'phrase', words: ['war', 'on', 'voting'] }] }])
    expect(q.excluded).toEqual(['ballot'])
  })
  it('joins OR alternatives into one clause', () => {
    expect(parseSearchQuery('rent OR eviction').clauses).toEqual([
      { anyOf: [{ kind: 'word', word: 'rent' }, { kind: 'word', word: 'eviction' }] },
    ])
  })
  it('treats a hyphenated name as a tiny phrase', () => {
    expect(parseSearchQuery('Fabara-Anelli').clauses[0].anyOf[0]).toEqual({ kind: 'phrase', words: ['fabara', 'anelli'] })
  })
  it('tolerates an unclosed quote and punctuation-only input', () => {
    expect(parseSearchQuery('"state of oregon').clauses[0].anyOf[0]).toEqual({ kind: 'phrase', words: ['state', 'of', 'oregon'] })
    expect(parseSearchQuery('?? !!').clauses).toEqual([])
  })
})

describe('chooseVariants', () => {
  it('adds accent twins, inflections and plausible typos', () => {
    const v = chooseVariants(
      ['movilizacion', 'hartmann'],
      [
        row('movilizacion', 'movilización', 'exact', 1, 115),
        row('movilizacion', 'movilizaciones', 'inflection', 0.9, 109),
        row('hartmann', 'hartmann', 'exact', 1, 2),
        row('hartmann', 'hartman', 'fuzzy', 0.7, 400),
      ]
    )
    expect(v.get('movilizacion')).toEqual(['movilizacion', 'movilización', 'movilizaciones'])
    expect(v.get('hartmann')).toEqual(['hartmann', 'hartman'])
  })
  it('rejects look-alikes of a different length or weak similarity', () => {
    const v = chooseVariants(['prosegur'], [row('prosegur', 'prose', 'fuzzy', 0.46, 121), row('prosegur', 'prosegura', 'fuzzy', 0.8, 1)])
    expect(v.get('prosegur')).toEqual(['prosegur', 'prosegura'])
  })
  it('never expands short or filler words', () => {
    const v = chooseVariants(['the', 'on', 'about'], [row('the', 'þe', 'exact'), row('on', 'ón', 'exact'), row('about', 'abouts', 'inflection')])
    expect(v.get('the')).toEqual(['the'])
    expect(v.get('on')).toEqual(['on'])
    expect(v.get('about')).toEqual(['about'])
  })
  it('caps variants per word', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row('word', `word${i}`, 'exact'))
    expect(chooseVariants(['word'], rows).get('word')).toHaveLength(6)
  })
})

describe('buildTsQuery', () => {
  it('builds an AND of OR-groups and an any-words fallback', () => {
    const q = parseSearchQuery('Hartmann voter')
    const v = chooseVariants(lookupWords(q), [row('hartmann', 'hartman', 'fuzzy', 0.7)])
    expect(buildTsQuery(q, v)).toEqual({
      all: "('hartmann' | 'hartman') & 'voter'",
      any: "('hartmann' | 'hartman') | 'voter'",
    })
    expect(alsoMatched(v)).toEqual(['hartman'])
  })
  it('turns a phrase into followed-by operators and drops stopwords from any', () => {
    const built = buildTsQuery(parseSearchQuery('"war on voting"'))
    expect(built?.all).toBe("('war' <-> 'on' <-> 'voting')")
    expect(built?.any).toBe("'war' | 'voting'")
  })
  it('applies exclusions to both queries', () => {
    const built = buildTsQuery(parseSearchQuery('housing rent -eviction'))
    expect(built?.all).toBe("'housing' & 'rent' & !'eviction'")
    expect(built?.any).toBe("('housing' | 'rent') & !'eviction'")
  })
  it('single word has no separate any query; empty input builds nothing', () => {
    expect(buildTsQuery(parseSearchQuery('Prosegur'))).toEqual({ all: "'prosegur'", any: null })
    expect(buildTsQuery(parseSearchQuery('   '))).toBeNull()
  })
  it('quotes apostrophes safely', () => {
    expect(buildTsQuery(parseSearchQuery('x'), new Map([['x', ["o'neil"]]]))?.all).toBe("'o''neil'")
  })
})

describe('reciprocalRankFusion', () => {
  it('rewards ids ranked high in several lists', () => {
    const fused = reciprocalRankFusion([[1, 2, 3], [3, 1, 4]])
    expect(fused.map((f) => f.id)).toEqual([1, 3, 2, 4])
  })
})
