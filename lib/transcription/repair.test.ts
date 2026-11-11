import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../settings', () => ({
  isEmbeddingsEnabled: vi.fn(async () => false),
  getEmbeddingModel: vi.fn(async () => ''),
}))
vi.mock('../usage', () => ({ logEmbeddingUsage: vi.fn() }))
vi.mock('../transcript-embeddings', () => ({
  buildEpisodeChunkRows: vi.fn(),
  storeEpisodeChunks: vi.fn(),
}))
vi.mock('./cues', () => ({ replaceEpisodeCues: vi.fn(async () => {}) }))
vi.mock('../api-cache', () => ({ bumpCacheVersion: vi.fn(async () => {}) }))

import { backfillPendingCorrections } from './repair'
import { bumpCacheVersion } from '../api-cache'

const STATION = 'station-1'
const EPISODE = 10705

interface Write { table: string; payload: Record<string, unknown> }

/** Minimal stand-in for the Supabase query builder: every chain method returns
 *  the builder, awaiting it resolves per table/operation, and updates are
 *  recorded so the test can inspect exactly what repair writes. */
function fakeClient(transcriptRow: { transcript: string; vtt: string | null }) {
  const writes: Write[] = []
  const rule = {
    id: 1,
    wrong: 'Shireen Nishat',
    correct: 'Shirin Neshat',
    case_sensitive: false,
    is_regex: false,
    episode_id: EPISODE,
    show_key: null,
    backfilled_at: null,
  }
  const client = {
    from(table: string) {
      let op: 'select' | 'update' = 'select'
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'range', 'filter']) {
        builder[m] = () => builder
      }
      builder.update = (payload: Record<string, unknown>) => {
        op = 'update'
        writes.push({ table, payload })
        return builder
      }
      const resolve = () => {
        if (op === 'update') return { data: null, error: null }
        if (table === 'transcript_corrections') return { data: [rule], error: null }
        if (table === 'show_keys') return { data: [], error: null }
        return { data: [], error: null }
      }
      builder.maybeSingle = async () => ({
        data: { ...transcriptRow, episode_log: { station_id: STATION, show_key: 'bradcast' } },
        error: null,
      })
      builder.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(ok, fail)
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, writes }
}

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHoy con Shireen Nishat\n'

describe('backfillPendingCorrections — cached English translation', () => {
  beforeEach(() => vi.mocked(bumpCacheVersion).mockClear())

  it('nulls english_transcript/english_vtt when the repair changes the transcript', async () => {
    const { client, writes } = fakeClient({ transcript: 'Hoy con Shireen Nishat.', vtt: VTT })
    const res = await backfillPendingCorrections(client, STATION, { apply: true })

    expect(res.changedEpisodes).toBe(1)
    const tx = writes.find((w) => w.table === 'transcripts')
    expect(tx?.payload).toMatchObject({
      transcript: 'Hoy con Shirin Neshat.',
      english_transcript: null,
      english_vtt: null,
    })
    expect(tx?.payload.vtt).toContain('Shirin Neshat')
    // Public API caches for captions/episodes are orphaned so ?lang=en can't
    // serve the stale translation from Redis.
    expect(bumpCacheVersion).toHaveBeenCalledWith(STATION, 'transcripts')
    expect(bumpCacheVersion).toHaveBeenCalledWith(STATION, 'episodes')
  })

  it('leaves the translation alone when the rule changes nothing', async () => {
    const { client, writes } = fakeClient({ transcript: 'Hoy con Shirin Neshat.', vtt: null })
    const res = await backfillPendingCorrections(client, STATION, { apply: true })

    expect(res.changedEpisodes).toBe(0)
    expect(writes.find((w) => w.table === 'transcripts')).toBeUndefined()
    expect(bumpCacheVersion).not.toHaveBeenCalled()
  })

  it('writes nothing on a dry run', async () => {
    const { client, writes } = fakeClient({ transcript: 'Hoy con Shireen Nishat.', vtt: VTT })
    const res = await backfillPendingCorrections(client, STATION, { apply: false })

    expect(res.changedEpisodes).toBe(1)
    expect(writes).toHaveLength(0)
  })
})
