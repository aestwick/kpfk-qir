import { describe, it, expect } from 'vitest'
import { buildBatchJsonl, parseBatchOutput, whisperToResult, episodeIdFromCustomId, isTerminalBatchStatus } from './groq-batch'

describe('buildBatchJsonl', () => {
  it('writes one transcription request per episode, audio by URL', () => {
    const jsonl = buildBatchJsonl(
      [
        { episodeId: 10986, mp3Url: 'https://archive.kpfk.org/mp3/kpfk_261117_220000suplemento.mp3' },
        { episodeId: 10987, mp3Url: 'https://archive.kpfk.org/mp3/b.mp3', prompt: 'Sonali Kolhatkar' },
      ],
      'whisper-large-v3-turbo',
    )
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      custom_id: 'ep-10986',
      method: 'POST',
      url: '/v1/audio/transcriptions',
      body: {
        model: 'whisper-large-v3-turbo',
        url: 'https://archive.kpfk.org/mp3/kpfk_261117_220000suplemento.mp3',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
      },
    })
    expect(lines[1].body.prompt).toBe('Sonali Kolhatkar')
  })
})

describe('parseBatchOutput', () => {
  it('maps successes and failures back to episodes, ignoring foreign/garbled lines', () => {
    const jsonl = [
      JSON.stringify({ custom_id: 'ep-1', response: { status_code: 200, body: { text: 'hello', duration: 3600, segments: [] } } }),
      JSON.stringify({ custom_id: 'ep-2', response: { status_code: 400, body: { error: { message: 'file too large' } } } }),
      JSON.stringify({ custom_id: 'ep-3', error: { message: 'could not fetch url' } }),
      JSON.stringify({ custom_id: 'someone-else', response: { status_code: 200, body: { text: 'x' } } }),
      '{not json',
      '',
    ].join('\n')
    const r = parseBatchOutput(jsonl)
    expect(r).toHaveLength(3)
    expect(r[0]).toMatchObject({ episodeId: 1, ok: true })
    expect(r[1]).toEqual({ episodeId: 2, ok: false, error: 'Groq batch: file too large' })
    expect(r[2]).toEqual({ episodeId: 3, ok: false, error: 'Groq batch: could not fetch url' })
  })
})

describe('whisperToResult', () => {
  it('converts a whole-file response with no chunk offsets', () => {
    const r = whisperToResult(
      { text: 'a b', duration: 3600.5, language: 'spanish', segments: [{ start: 0, end: 2, text: 'a' }, { start: 2, end: 4, text: 'b' }] },
      'whisper-large-v3-turbo',
    )
    expect(r).toMatchObject({ text: 'a b', durationSec: 3600.5, language: 'spanish', providerId: 'groq', diarized: false })
    expect(r.segments[1]).toEqual({ startSec: 2, endSec: 4, text: 'b' })
  })
  it('falls back to the last segment end when duration is missing', () => {
    expect(whisperToResult({ text: 'a', segments: [{ start: 0, end: 42, text: 'a' }] }, 'm').durationSec).toBe(42)
  })
})

describe('helpers', () => {
  it('round-trips custom ids', () => {
    expect(episodeIdFromCustomId('ep-10986')).toBe(10986)
    expect(episodeIdFromCustomId('ep-x')).toBeNull()
    expect(episodeIdFromCustomId(5)).toBeNull()
  })
  it('knows terminal statuses', () => {
    expect(isTerminalBatchStatus('completed')).toBe(true)
    expect(isTerminalBatchStatus('expired')).toBe(true)
    expect(isTerminalBatchStatus('in_progress')).toBe(false)
  })
})
