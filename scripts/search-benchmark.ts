// Search benchmark: runs a fixed set of real questions against a RUNNING QIR app
// over HTTP, as a signed-in user, and scores the answers. Same harness for the
// "before" and "after" runs, so the comparison measures what a user actually
// gets (auth, RLS, the 8s statement timeout, ranking) — not a lab query.
//
// Usage:
//   BENCH_EMAIL=… BENCH_PASSWORD=… tsx scripts/search-benchmark.ts \
//     --file reports/benchmark.json --base http://localhost:3000 --variant before|after \
//     [--out reports/bench-after.json]
//
// Benchmark entries: { id, need: 'day'|'moment'|'show'|'people', query, params, expect:{episode_ids, start_ms_near} }
//   variant "before" = only what the old UI could do (episode list + transcript search)
//   variant "after"  = the new Broadcast Day / Search / Show report / People APIs
//
// Scoring per entry: recall of expected episode ids in the answer (top 20 for
// search-style needs), and for moment queries whether a returned moment for an
// expected episode is within ±90s of the known cue.

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'

interface Entry {
  id: string
  need: 'day' | 'moment' | 'show' | 'people'
  query: string
  params?: Record<string, string>
  expect: { episode_ids?: number[]; start_ms_near?: number; notes?: string }
}

interface Hit {
  episodeId: number
  startMs?: number | null
}

interface Outcome {
  id: string
  need: string
  query: string
  supported: boolean
  recall: number // 0..1 of expected ids found
  momentOk: boolean | null // null = n/a
  ms: number
  got: number[]
  note?: string
}

function arg(flag: string, fallback?: string): string {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback === undefined) throw new Error(`missing ${flag}`)
  return fallback
}

const BASE = arg('--base', 'http://localhost:3000')
const VARIANT = arg('--variant', 'after') as 'before' | 'after'
const FILE = arg('--file')
const OUT = arg('--out', '')
const MOMENT_TOLERANCE_MS = 90_000

let token = ''
async function api(path: string): Promise<{ status: number; body: any; ms: number }> {
  const t = Date.now()
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}`, 'x-station-slug': 'kpfk' } })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body, ms: Date.now() - t }
}

const q = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  return p.toString()
}

/** Old transcript search (both modes exist before and after). */
async function transcriptSearch(query: string, extra: Record<string, string | undefined> = {}) {
  const r = await api(`/api/transcript-search?${q({ q: query, limit: 20, ...extra })}`)
  const hits: Hit[] = (r.body?.results ?? []).map((x: any) => ({ episodeId: x.episodeId, startMs: x.startMs }))
  return { hits, ms: r.ms, status: r.status }
}

/** Each variant answers each need with the tools it has. */
async function answer(e: Entry): Promise<{ hits: Hit[]; ms: number; supported: boolean; note?: string }> {
  const p = e.params ?? {}
  // The old UI's quarter dropdown defaults to the current quarter; a user hunting
  // older material would pick "All Quarters" — give "before" that benefit.
  const allTime = { quarter: 'all' }

  if (e.need === 'day') {
    if (VARIANT === 'before') {
      // The Episodes list has no date filter and Search has none either: the
      // only route is paging through the list. Not answerable in a few clicks.
      return { hits: [], ms: 0, supported: false, note: 'no date filter anywhere in the UI' }
    }
    const r = await api(`/api/broadcast-day?${q({ date: p.date })}`)
    const from = p.from ?? '00:00'
    const to = p.to && p.to > from ? p.to : from
    const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5)
    const lo = toMin(from)
    const hi = Math.max(toMin(to), lo + 1)
    // The user reads the rows covering the asked hours (overlap, not start time).
    const hits: Hit[] = (r.body?.blocks ?? [])
      .filter((b: any) => b.startMin != null && b.startMin < hi && (b.endMin ?? b.startMin + 60) > lo)
      .flatMap((b: any) => [{ episodeId: b.episodeId }, ...(b.alsoAired ?? []).map((id: number) => ({ episodeId: id }))])
    return { hits, ms: r.ms, supported: r.status === 200, note: r.status !== 200 ? `HTTP ${r.status}` : undefined }
  }

  if (e.need === 'moment') {
    const mode = p.mode === 'semantic' ? 'semantic' : undefined
    if (VARIANT === 'before') {
      const r = await transcriptSearch(e.query, { ...allTime, mode })
      return { hits: r.hits, ms: r.ms, supported: true, note: r.status !== 200 ? `HTTP ${r.status}` : undefined }
    }
    const r = await api(`/api/transcript-search?${q({ q: e.query, limit: 20, quarter: 'all', mode })}`)
    const hits: Hit[] = (r.body?.results ?? []).map((x: any) => ({ episodeId: x.episodeId, startMs: x.startMs }))
    return { hits, ms: r.ms, supported: true, note: r.status !== 200 ? `HTTP ${r.status}` : undefined }
  }

  if (e.need === 'show') {
    if (VARIANT === 'before') {
      // Episodes list: filter by show + the quarter (no month range), newest first.
      const r = await api(`/api/episodes?${q({ show_key: p.show, quarter: '2026-Q4', limit: 50, sort: 'air_date', order: 'desc' })}`)
      const inRange = (r.body?.episodes ?? []).filter((x: any) => x.air_date >= p.from && x.air_date <= p.to)
      return {
        hits: inRange.map((x: any) => ({ episodeId: x.id })),
        ms: r.ms,
        supported: true,
        note: 'episode list only — no topics/guests/issue rollup; month must be eyeballed',
      }
    }
    const r = await api(`/api/show-report?${q({ show: p.show, from: p.from, to: p.to })}`)
    const hits: Hit[] = (r.body?.episodes ?? []).map((x: any) => ({ episodeId: x.id }))
    const rollup = r.body ? `${(r.body.issues ?? []).length} issue cats, ${(r.body.guests ?? []).length} guests` : ''
    return { hits, ms: r.ms, supported: r.status === 200, note: rollup }
  }

  // people
  if (VARIANT === 'before') {
    // Only route: type the name into transcript search (every quarter).
    const r = await transcriptSearch(e.query, allTime)
    return { hits: r.hits, ms: r.ms, supported: true, note: 'transcript text only (no guest/host field search)' }
  }
  const r = await api(`/api/people?${q({ q: e.query })}`)
  const top = r.body?.people?.[0]
  if (!top) return { hits: [], ms: r.ms, supported: true, note: 'no person matched' }
  const d = await api(`/api/people?${q({ name: top.name })}`)
  const hits: Hit[] = (d.body?.appearances ?? []).map((x: any) => ({ episodeId: x.episodeId }))
  return { hits, ms: r.ms + d.ms, supported: true, note: `matched "${top.name}"` }
}

async function main() {
  const email = process.env.BENCH_EMAIL
  const password = process.env.BENCH_PASSWORD
  if (!email || !password) throw new Error('BENCH_EMAIL / BENCH_PASSWORD required')
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  })
  const { data, error } = await sb.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`sign-in failed: ${error?.message}`)
  token = data.session.access_token

  const entries: Entry[] = JSON.parse(readFileSync(FILE, 'utf8'))
  const outcomes: Outcome[] = []
  for (const e of entries) {
    const { hits, ms, supported, note } = await answer(e)
    const expected = e.expect.episode_ids ?? []
    // Search results are judged on page 1 (top 20). Day/show/person views list
    // everything on one page, so their whole answer counts.
    const onePage = e.need === 'show' || e.need === 'day' || (e.need === 'people' && VARIANT === 'after')
    const window = onePage ? hits : hits.slice(0, 20)
    const gotIds = Array.from(new Set(window.map((h) => h.episodeId)))
    const found = expected.filter((id) => gotIds.includes(id)).length
    let momentOk: boolean | null = null
    if (e.need === 'moment' && e.expect.start_ms_near != null) {
      momentOk = window.some(
        (h) => expected.includes(h.episodeId) && h.startMs != null && Math.abs(h.startMs - e.expect.start_ms_near!) <= MOMENT_TOLERANCE_MS
      )
    }
    const o: Outcome = {
      id: e.id,
      need: e.need,
      query: e.query,
      supported,
      recall: expected.length ? found / expected.length : 0,
      momentOk,
      ms,
      got: gotIds.slice(0, 12),
      note,
    }
    outcomes.push(o)
    console.log(
      `${o.id.padEnd(3)} ${o.need.padEnd(6)} recall ${(o.recall * 100).toFixed(0).padStart(3)}%` +
        `${momentOk == null ? '' : momentOk ? '  moment ✓' : '  moment ✗'}  ${String(ms).padStart(5)}ms  ${note ?? ''}`
    )
  }

  const byNeed: Record<string, { n: number; recall: number; moment: number; momentN: number }> = {}
  for (const o of outcomes) {
    const b = (byNeed[o.need] ??= { n: 0, recall: 0, moment: 0, momentN: 0 })
    b.n++
    b.recall += o.supported ? o.recall : 0
    if (o.momentOk != null) {
      b.momentN++
      if (o.momentOk) b.moment++
    }
  }
  console.log(`\n== ${VARIANT} ==`)
  for (const [need, b] of Object.entries(byNeed)) {
    console.log(
      `${need.padEnd(7)} avg recall ${((b.recall / b.n) * 100).toFixed(0)}%` +
        (b.momentN ? `, moment found ${b.moment}/${b.momentN}` : '')
    )
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ variant: VARIANT, at: new Date().toISOString(), outcomes }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
