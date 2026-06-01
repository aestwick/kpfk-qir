import { describe, it, expect } from 'vitest'
import {
  cleanFeedName,
  resolveShowDisplayName,
  resolveShowGroup,
  resolveGroupDisplayName,
} from './shows'

const KPFK = ['KPFK -']

describe('cleanFeedName', () => {
  it('strips a configured station prefix', () => {
    expect(cleanFeedName('KPFK - Car Show', KPFK)).toBe('Car Show')
  })

  it('strips a leading "the" after the prefix', () => {
    expect(cleanFeedName('KPFK - The Car Show', KPFK)).toBe('Car Show')
    expect(cleanFeedName('KPFK - The Lawyers Guild', KPFK)).toBe('Lawyers Guild')
  })

  it('is case-insensitive on the prefix and the "the"', () => {
    expect(cleanFeedName('kpfk - THE Lab', KPFK)).toBe('Lab')
  })

  it('only strips "the" as a whole word, not "Theater"', () => {
    expect(cleanFeedName('KPFK - Theater Hour', KPFK)).toBe('Theater Hour')
  })

  it('leaves names without the prefix untouched', () => {
    expect(cleanFeedName('Democracy Now!', KPFK)).toBe('Democracy Now!')
  })

  it('returns the trimmed name when no prefixes are configured', () => {
    expect(cleanFeedName('  KPFK - Car Show  ', null)).toBe('KPFK - Car Show')
    expect(cleanFeedName('KPFK - Car Show', [])).toBe('KPFK - Car Show')
  })

  it('does not return empty when the name is only prefix + the', () => {
    // Falls back rather than yielding an empty string.
    expect(cleanFeedName('KPFK - The', KPFK)).toBe('The')
  })

  it('tries prefixes in order, first match wins', () => {
    expect(cleanFeedName('WBAI - The News', ['KPFK -', 'WBAI -'])).toBe('News')
  })
})

describe('resolveShowDisplayName', () => {
  it('uses the manual override verbatim (no prefix stripping)', () => {
    expect(
      resolveShowDisplayName(
        { key: 'x', display_name: 'KPFK - The Special', feed_name: 'KPFK - Other' },
        KPFK
      )
    ).toBe('KPFK - The Special')
  })

  it('cleans the feed_name when no override', () => {
    expect(resolveShowDisplayName({ key: 'carshow', feed_name: 'KPFK - The Car Show' }, KPFK)).toBe('Car Show')
  })

  it('falls back to show_name then key', () => {
    expect(resolveShowDisplayName({ key: 'k', show_name: 'KPFK - Legacy' }, KPFK)).toBe('Legacy')
    expect(resolveShowDisplayName({ key: 'k' }, KPFK)).toBe('k')
  })
})

describe('resolveShowGroup', () => {
  it('uses show_group when set, else the key', () => {
    expect(resolveShowGroup({ key: 'dn6', show_group: 'Democracy Now' })).toBe('Democracy Now')
    expect(resolveShowGroup({ key: 'dn6', show_group: null })).toBe('dn6')
    expect(resolveShowGroup({ key: 'dn6', show_group: '   ' })).toBe('dn6')
  })
})

describe('resolveGroupDisplayName', () => {
  it('prefers an explicit display_name override on any feed', () => {
    const feeds = [
      { key: 'a', feed_name: 'KPFK - A', show_group: 'g' },
      { key: 'b', display_name: 'My Show', show_group: 'g' },
    ]
    expect(resolveGroupDisplayName(feeds, KPFK)).toBe('My Show')
  })

  it('uses the hand-entered group label over arbitrary RSS titles', () => {
    const feeds = [
      { key: 'a', feed_name: 'KPFK - Car Show, The', show_group: 'The Car Show' },
      { key: 'b', feed_name: 'KPFK - The Car Show', show_group: 'The Car Show' },
    ]
    expect(resolveGroupDisplayName(feeds, KPFK)).toBe('The Car Show')
  })

  it('cleans the first feed name when ungrouped (no group label)', () => {
    const feeds = [{ key: 'a', feed_name: 'KPFK - The Lab', show_group: null }]
    expect(resolveGroupDisplayName(feeds, KPFK)).toBe('Lab')
  })

  it('returns Unknown Show for an empty group', () => {
    expect(resolveGroupDisplayName([], KPFK)).toBe('Unknown Show')
  })
})
