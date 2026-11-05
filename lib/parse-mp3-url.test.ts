import { describe, it, expect } from 'vitest'
import { parseMp3Url } from './parse-mp3-url'

describe('parseMp3Url', () => {
  it('parses the standard KPFK form', () => {
    expect(parseMp3Url('https://archive.kpfk.org/mp3/kpfk_260106_233000casc.mp3', 'kpfk'))
      .toEqual({ airDate: '2026-01-06', airStart: '23:30:00', showKey: 'casc' })
  })
  it('accepts a stream-suffixed prefix (KPFT HD3: kpfthd3_ under prefix kpft)', () => {
    expect(parseMp3Url('https://archive.kpft.org/mp3/kpfthd3_260627_160000quantum.mp3', 'kpft'))
      .toEqual({ airDate: '2026-06-27', airStart: '16:00:00', showKey: 'quantum' })
  })
  it('accepts show keys with digits and underscores', () => {
    expect(parseMp3Url('kpfthd3_260510_210000ragradio2.mp3', 'kpft')?.showKey).toBe('ragradio2')
    expect(parseMp3Url('kpfk_261018_100000bts_friday.mp3', 'kpfk')?.showKey).toBe('bts_friday')
    expect(parseMp3Url('kpfk_260615_110000gv_derek.mp3', 'kpfk')?.showKey).toBe('gv_derek')
  })
  it('still parses the 2kpfk_ online-feed copies', () => {
    expect(parseMp3Url('2kpfk_251229_150000bradcast2.mp3', 'kpfk')).toEqual({ airDate: '2025-12-29', airStart: '15:00:00', showKey: 'bradcast2' })
  })
  it('rejects another station’s files and non-archive names', () => {
    expect(parseMp3Url('wpfw_260101_120000show.mp3', 'kpfk')).toBeNull()
    expect(parseMp3Url('https://example.org/episode.mp3', 'kpfk')).toBeNull()
  })
})
