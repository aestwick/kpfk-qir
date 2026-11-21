// How the Groq path cuts audio: 15-minute mono 16 kHz 64k AAC (M4A) segments.
// Shared by the transcribe worker and scripts/benchmark-names.ts so a benchmark
// chunk is byte-for-byte what production sends to Groq.

export const CHUNK_DURATION_SECONDS = 900 // 15 minutes

/** ffmpeg output-encoding arguments for one transcription chunk. */
export const CHUNK_ENCODE_ARGS = ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k'] as const

/**
 * ffmpeg input arguments for reading the archive MP3 over HTTP. `-rw_timeout`
 * (microseconds) makes a stalled read an error instead of a forever-wait: on
 * 2026-11-18 the archive stopped answering mid-download and ffmpeg blocked in a
 * socket read for days, holding the station's transcribe lock (SIGTERM from the
 * execFile timeout doesn't interrupt a blocked read). 60 s of no data → fail.
 */
export const CHUNK_INPUT_ARGS = ['-rw_timeout', '60000000'] as const
