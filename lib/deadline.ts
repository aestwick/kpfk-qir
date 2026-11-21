// A hard wall-clock limit for a unit of pipeline work.
//
// Every network call in the pipeline has its own timeout, but a stage is a
// chain of them plus child processes and DB writes, and one un-timed link is
// enough to hang the whole chain. On 2026-11-18 an ffmpeg download blocked on a
// dead archive connection for three days; because the per-station chain lock
// keeps refreshing while its holder is alive, every later transcribe job was a
// silent "locked" skip. `withDeadline` turns any such hang into an ordinary
// error the caller already knows how to handle (mark failed, retry later).
//
// It cannot cancel the underlying work — JavaScript has no way to abort an
// arbitrary promise — so callers should also give their child processes and
// requests their own timeouts. What it guarantees is that the *caller* moves on.

export class DeadlineExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 60_000)} min`)
    this.name = 'DeadlineExceededError'
  }
}

export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), ms)
  })
  // A late rejection from abandoned work must not surface as an unhandled rejection.
  work.catch(() => {})
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}
