// Remote (URL-based) transcription providers: AssemblyAI and Deepgram.
//
// Unlike Groq Whisper — which we feed locally-chunked 15-min M4A segments — both
// of these providers fetch the source MP3 themselves from a URL, so the worker's
// ffmpeg chunking step is skipped entirely for them. Each returns a unified
// shape: the full transcript text plus a flat list of timed segments (ABSOLUTE
// seconds from the start of the episode) for VTT/cue building, the audio
// duration (for cost), and a detected language code.
//
// A provider that cannot download the source URL (404 / unreachable) throws a
// TranscriptionUnavailableError so the worker can mark the episode `unavailable`
// — the same terminal state the ffmpeg path uses for a 404 MP3 — instead of
// burning a retry on something that will never succeed.

export interface TranscriptionSegment {
  start: number // seconds, absolute from episode start
  end: number // seconds
  text: string
}

export interface RemoteTranscriptionResult {
  text: string
  segments: TranscriptionSegment[]
  duration: number // seconds of audio billed
  language: string | null
}

export type RemoteProvider = 'assemblyai' | 'deepgram'

// Signals an episode whose source audio could not be fetched (404 / unreachable)
// — terminal, not retryable. The worker maps this to status 'unavailable'.
export class TranscriptionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptionUnavailableError'
  }
}

const ASSEMBLYAI_BASE = 'https://api.assemblyai.com/v2'
const DEEPGRAM_URL =
  'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&utterances=true&detect_language=true'

// AssemblyAI returns word-level timestamps; group them into readable cues that
// break on sentence-ending punctuation, or every ~14 words / ~8s, whichever
// comes first. Keeps VTT cues a sane length without a separate sentences call.
function groupWordsIntoSegments(
  words: Array<{ text: string; startMs: number; endMs: number }>
): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = []
  let current: { text: string[]; start: number; end: number } | null = null

  const flush = () => {
    if (current && current.text.length) {
      segments.push({
        start: current.start / 1000,
        end: current.end / 1000,
        text: current.text.join(' ').trim(),
      })
    }
    current = null
  }

  for (const w of words) {
    if (!current) current = { text: [], start: w.startMs, end: w.endMs }
    current.text.push(w.text)
    current.end = w.endMs
    const endsSentence = /[.!?]$/.test(w.text.trim())
    const longEnough = current.text.length >= 14 || current.end - current.start >= 8000
    if (endsSentence || longEnough) flush()
  }
  flush()
  return segments
}

// ─── AssemblyAI ─────────────────────────────────────────────────────────────
// Async API: submit the audio_url, then poll the transcript id until it reaches
// a terminal status. Auth header is the bare key (no "Bearer ").

async function transcribeAssemblyAI(audioUrl: string): Promise<RemoteTranscriptionResult> {
  const key = process.env.ASSEMBLYAI_API_KEY
  if (!key) throw new Error('ASSEMBLYAI_API_KEY not set')

  const submit = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl, language_detection: true, punctuate: true, format_text: true }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!submit.ok) {
    throw new Error(`AssemblyAI submit error ${submit.status}: ${await submit.text()}`)
  }
  const { id } = (await submit.json()) as { id: string }
  if (!id) throw new Error('AssemblyAI did not return a transcript id')

  // Poll until completed/error. Cap total wait at ~30 min — well beyond the
  // realtime length of a 1-2h show processed at several times realtime.
  const deadline = Date.now() + 30 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const poll = await fetch(`${ASSEMBLYAI_BASE}/transcript/${id}`, {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(60_000),
    })
    if (!poll.ok) throw new Error(`AssemblyAI poll error ${poll.status}: ${await poll.text()}`)
    const data = (await poll.json()) as {
      status: string
      text?: string
      words?: Array<{ text: string; start: number; end: number }>
      audio_duration?: number
      language_code?: string
      error?: string
    }

    if (data.status === 'completed') {
      const words = (data.words ?? []).map((w) => ({ text: w.text, startMs: w.start, endMs: w.end }))
      return {
        text: data.text ?? '',
        segments: groupWordsIntoSegments(words),
        duration: data.audio_duration ?? 0,
        language: data.language_code ?? null,
      }
    }
    if (data.status === 'error') {
      const msg = data.error ?? 'unknown error'
      // A source-download failure is terminal, not retryable.
      if (/download|not be downloaded|does not appear to contain audio|404/i.test(msg)) {
        throw new TranscriptionUnavailableError(`AssemblyAI could not fetch audio: ${msg}`)
      }
      throw new Error(`AssemblyAI transcription failed: ${msg}`)
    }
    // queued | processing — keep polling
  }
  throw new Error('AssemblyAI transcription timed out after 30 minutes')
}

// ─── Deepgram ───────────────────────────────────────────────────────────────
// Synchronous prerecorded API: POST the source url, get the result back in one
// response. Auth header is "Token <key>". Segments come from utterances.

async function transcribeDeepgram(audioUrl: string): Promise<RemoteTranscriptionResult> {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('DEEPGRAM_API_KEY not set')

  const res = await fetch(DEEPGRAM_URL, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: audioUrl }),
    signal: AbortSignal.timeout(30 * 60 * 1000),
  })

  if (!res.ok) {
    const body = await res.text()
    // Deepgram reports an unfetchable source URL as REMOTE_CONTENT_ERROR.
    if (res.status === 400 && /REMOTE_CONTENT_ERROR|failed to fetch|download|404/i.test(body)) {
      throw new TranscriptionUnavailableError(`Deepgram could not fetch audio: ${body}`)
    }
    throw new Error(`Deepgram error ${res.status}: ${body}`)
  }

  const data = (await res.json()) as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: string }>
        detected_language?: string
      }>
      utterances?: Array<{ start: number; end: number; transcript: string }>
    }
    metadata?: { duration?: number }
  }

  const channel = data.results?.channels?.[0]
  const text = channel?.alternatives?.[0]?.transcript ?? ''
  const segments: TranscriptionSegment[] = (data.results?.utterances ?? []).map((u) => ({
    start: u.start,
    end: u.end,
    text: u.transcript.trim(),
  }))

  return {
    text,
    segments,
    duration: data.metadata?.duration ?? 0,
    language: channel?.detected_language ?? null,
  }
}

/**
 * Transcribe an episode's source MP3 directly from its URL with the given
 * remote provider. Throws TranscriptionUnavailableError when the provider
 * cannot download the source (terminal, like a 404 MP3).
 */
export async function transcribeRemote(
  provider: RemoteProvider,
  audioUrl: string
): Promise<RemoteTranscriptionResult> {
  return provider === 'assemblyai' ? transcribeAssemblyAI(audioUrl) : transcribeDeepgram(audioUrl)
}

// Default model label per provider, logged to usage_log for cost attribution.
export const REMOTE_PROVIDER_MODEL: Record<RemoteProvider, string> = {
  assemblyai: 'best',
  deepgram: 'nova-2',
}
