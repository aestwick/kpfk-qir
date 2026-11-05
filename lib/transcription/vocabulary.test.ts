import { describe, it, expect } from 'vitest'
import {
  buildVocabularyPrompt,
  dropPromptEchoSegments,
  shouldUseVocabularyHint,
  VOCABULARY_PROMPT_MAX_BYTES,
} from './vocabulary'
import { splitPersonNames, looksLikePersonName } from './names'
import { episodeHumanNames } from './store'
import { filterMinedVariants, snippetAround } from './suggestions'
import { cleanCmsHostName } from './miner'

describe('buildVocabularyPrompt', () => {
  it('lists station, show, then episode names as a comma list, de-duplicated', () => {
    const p = buildVocabularyPrompt({
      stationTerms: ['KPFK', 'Pacifica'],
      showNames: ['Cary Harrison', 'Renee Yaworski'],
      episodeNames: ['cary harrison', 'Jasper Culpepper'],
    })
    expect(p).toBe('KPFK, Pacifica, Cary Harrison, Renee Yaworski, Jasper Culpepper')
  })
  it('returns nothing when the show has no names (station terms alone are not worth it)', () => {
    expect(buildVocabularyPrompt({ stationTerms: ['KPFK'], showNames: [], episodeNames: [] })).toBe('')
  })
  it('stops before the byte cap, counting UTF-8 bytes not characters', () => {
    const names = Array.from({ length: 200 }, (_, i) => `Renée Gudiño ${i}`)
    const p = buildVocabularyPrompt({ stationTerms: [], showNames: names, episodeNames: [] })
    expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(VOCABULARY_PROMPT_MAX_BYTES)
    expect(p.startsWith('Renée Gudiño 0, Renée Gudiño 1')).toBe(true)
  })
  it('strips commas and newlines inside a name so the list stays a list', () => {
    expect(buildVocabularyPrompt({ stationTerms: [], showNames: ['Doe,\nJane'], episodeNames: [] })).toBe('Doe Jane')
  })
})

describe('shouldUseVocabularyHint', () => {
  it('never hints music', () => {
    expect(shouldUseVocabularyHint('Music')).toBe(false)
    expect(shouldUseVocabularyHint('Syndicated Music')).toBe(false)
  })
  it('hints talk and uncategorized episodes', () => {
    expect(shouldUseVocabularyHint('Public Affairs - Local')).toBe(true)
    expect(shouldUseVocabularyHint('Español')).toBe(true)
    expect(shouldUseVocabularyHint(null)).toBe(true)
  })
})

describe('dropPromptEchoSegments', () => {
  const prompt = 'KPFK, Pacifica, Awakenings, Michelle Coltrane'
  const seg = (text: string, startSec = 0) => ({ startSec, endSec: startSec + 1, text })

  it('drops the name list read back as speech', () => {
    const out = dropPromptEchoSegments([seg('KPFK, Pacifica, Awakenings, Michelle Coltrane.'), seg('Here is a song by Alice.')], prompt)
    expect(out.map((s) => s.text)).toEqual(['Here is a song by Alice.'])
  })
  it('keeps a host saying their own name', () => {
    const out = dropPromptEchoSegments([seg("This is Michelle Coltrane on KPFK."), seg('Michelle Coltrane')], prompt)
    expect(out).toHaveLength(2)
  })
  it('drops the third and later copies of a repeated line', () => {
    const out = dropPromptEchoSegments([seg('Ski'), seg('Ski'), seg('Ski'), seg('Ski'), seg('Next')], prompt)
    expect(out.map((s) => s.text)).toEqual(['Ski', 'Ski', 'Next'])
  })
  it('is a no-op without a prompt', () => {
    const segs = [seg('Ski'), seg('Ski'), seg('Ski')]
    expect(dropPromptEchoSegments(segs, '')).toBe(segs)
  })
})

describe('splitPersonNames', () => {
  it('splits the separators producers use', () => {
    expect(splitPersonNames('Harvey "Sunny" Wasserman & Kevin Kamps')).toEqual(['Harvey Sunny Wasserman', 'Kevin Kamps'])
    expect(splitPersonNames('Kate Wolf, Medaya Ocher, and Eric Newman.')).toEqual(['Kate Wolf', 'Medaya Ocher', 'Eric Newman'])
    expect(splitPersonNames('Freya Rojo, Lily Lopez & Rosario Vigil')).toEqual(['Freya Rojo', 'Lily Lopez', 'Rosario Vigil'])
    expect(splitPersonNames('Nita Vallens (Guest Host)')).toEqual(['Nita Vallens'])
  })
  it('drops placeholders, phone numbers and bios', () => {
    expect(splitPersonNames('Various hosts')).toEqual([])
    expect(splitPersonNames('Mitch Jeserich at 800-958-9008')).toEqual([])
    expect(splitPersonNames('a professor of history and Chicano studies at the university')).toEqual([])
    expect(splitPersonNames(null)).toEqual([])
  })
})

describe('episodeHumanNames', () => {
  it('reads only the human (Confessor) copies', () => {
    expect(
      episodeHumanNames({
        host: { human: 'Maria Armoudian', ai: 'Maria Armudian' } as never,
        guest: { human: 'Gregory Treverton, William Hartung', ai: null } as never,
        summary: { human: 'not a name' } as never,
      }),
    ).toEqual(['Maria Armoudian', 'Gregory Treverton', 'William Hartung'])
    expect(episodeHumanNames(null)).toEqual([])
  })
})

describe('miner filtering', () => {
  const base = { show_key: 'caryharrisfiles', name: 'Cary Harrison', occurrences: 38, episodes: 6, sample_episode_id: 1 }
  it('keeps a real misspelling and drops sentence noise, known people and fixed variants', () => {
    const rows = [
      { ...base, variant: 'Carrie Harrison' },
      { ...base, variant: 'Your Harrison' },
      { ...base, variant: 'Gary Harrison' },
      { ...base, variant: 'Kerry Harrison' },
    ]
    const kept = filterMinedVariants(rows, {
      knownNames: new Set(['gary harrison']),
      rulesForShow: () => [{ wrong: 'Kerry Harrison', correct: 'Cary Harrison', caseSensitive: false, isRegex: false }],
    })
    expect(kept.map((r) => r.variant)).toEqual(['Carrie Harrison'])
  })
  it('looksLikePersonName rejects sentence words', () => {
    expect(looksLikePersonName('Kevin Camps')).toBe(true)
    expect(looksLikePersonName('The Harrison')).toBe(false)
    expect(looksLikePersonName('Harrison')).toBe(false)
  })
  it('snippetAround returns context around the first hit', () => {
    expect(snippetAround('aaaa Carrie Harrison bbbb', 'carrie harrison', 3)).toBe('…aa Carrie Harrison bb…')
    expect(snippetAround('nothing here', 'x y')).toBeNull()
  })
  it('cleanCmsHostName strips aliases and drops group entries', () => {
    expect(cleanCmsHostName('Arnella Barbara (Dark Star Gurl)')).toBe('Arnella Barbara')
    expect(cleanCmsHostName('Armando "Dino" Gudiño')).toBe('Armando Dino Gudiño')
    expect(cleanCmsHostName('Contributors & Community Reporters')).toBeNull()
  })
})
