import { useEffect, useRef, useState } from 'react'

interface QueueCounts {
  active: number
  waiting: number
  completed: number
  failed: number
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

export function useQueueSSE() {
  const [queues, setQueues] = useState<QueueData | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/events')
    esRef.current = es

    es.onmessage = (event) => {
      try {
        setQueues(JSON.parse(event.data))
      } catch {
        // ignore malformed data
      }
    }

    es.onerror = () => {
      // Browser will auto-reconnect
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [])

  return queues
}
