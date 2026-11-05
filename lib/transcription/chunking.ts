// How the Groq path cuts audio: 15-minute mono 16 kHz 64k AAC (M4A) segments.
// Shared by the transcribe worker and scripts/benchmark-names.ts so a benchmark
// chunk is byte-for-byte what production sends to Groq.

export const CHUNK_DURATION_SECONDS = 900 // 15 minutes

/** ffmpeg output-encoding arguments for one transcription chunk. */
export const CHUNK_ENCODE_ARGS = ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k'] as const
