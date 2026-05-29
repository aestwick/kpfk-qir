import { useEffect, useState } from 'react'
import { authedFetch } from '@/lib/api-client'

export interface ActiveJobInfo {
  id: string
  name: string
  progress: { current?: number; total?: number; episodeId?: number; showName?: string; airDate?: string } | null
  processedOn: number | null
}

interface QueueCounts {
  active: number
  waiting: number
  completed: number
  failed: number
  activeJobs?: ActiveJobInfo[]
}

export interface EpisodeCounts {
  ingested: number
  transcribed: number
  summarized: number
  complianceChecked: number
  failed: number
}

export interface EpisodeBacklog {
  pendingTranscription: number
  pendingSummarization: number
  pendingCompliance: number
  failed: number
  episodeCounts?: EpisodeCounts
}

export interface QueueData {
  ingest: QueueCounts
  transcribe: QueueCounts
  summarize: QueueCounts
  compliance: QueueCounts
  backlog?: EpisodeBacklog
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function useQueueSSE() {
  const [queues, setQueues] = useState<QueueData | null>(null)

  useEffect(() => {
    // Consume /api/events as a text/event-stream over fetch (not EventSource) so
    // the request can carry the Supabase bearer token via authedFetch — the same
    // auth path as every other route. The server closes the stream after ~5min,
    // so we loop to reconnect until the component unmounts.
    const controller = new AbortController()
    let stopped = false

    async function connect() {
      while (!stopped) {
        try {
          const res = await authedFetch('/api/events', {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          })
          if (!res.ok || !res.body) {
            // e.g. 400 (no active station) / 401 — back off, then retry.
            await delay(5000)
            continue
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (!stopped) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            // SSE frames are separated by a blank line.
            let sep: number
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, sep)
              buffer = buffer.slice(sep + 2)
              const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
              if (!dataLine) continue
              const payload = dataLine.slice(5).trim()
              if (!payload || payload === '{}') continue // skip the connected ping
              try {
                setQueues(JSON.parse(payload))
              } catch {
                // ignore a malformed frame; the next tick replaces it
              }
            }
          }
        } catch {
          if (controller.signal.aborted) return // unmounted — stop cleanly
          // network error — fall through to reconnect
        }
        if (!stopped) await delay(3000) // brief backoff before reconnecting
      }
    }

    connect()
    return () => {
      stopped = true
      controller.abort()
    }
  }, [])

  return queues
}
