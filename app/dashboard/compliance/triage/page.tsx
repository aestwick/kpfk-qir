'use client'

// Review flags — the triage screen. Flags are sorted into tiers
// (lib/compliance-tier.ts) so the reviewer starts with what the FCC could act
// on, listens in place, decides with one key, and moves straight to the next.
// Safe-harbor flags and checks that are switched off close in bulk. Every
// decision is a normal PATCH /api/compliance write, so it lands in the audit
// log with the signed-in reviewer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { authedFetch } from '@/lib/api-client'
import { Breadcrumbs } from '@/app/components/breadcrumbs'
import { useToast } from '@/app/components/toast'
import { useNavAccess } from '@/app/components/nav-access'
import { getQuarterOptions, getCurrentQuarter } from '@/lib/quarters'
import { TIERS, TIER_LABELS, termSpan, OPEN_STATUSES, type Tier } from '@/lib/compliance-tier'
import { flagTypeLabel, type ReviewStatus } from '@/lib/compliance-status'
import { locationFrom, withFrom } from '@/lib/nav'

interface TriageFlag {
  id: number
  episode_id: number
  tier: Tier
  term: string | null
  flag_type: string
  severity: string
  excerpt: string | null
  details: string | null
  timestamp_seconds: number | null
  review_status: ReviewStatus
  resolved_by: string | null
  resolved_notes: string | null
  show_name: string
  show_key: string
  air_date: string | null
  aired_minute: number | null
  mp3_url: string | null
  check_off: boolean
}

interface TriageData {
  quarter: string
  counts: Record<Tier, { open: number; done: number }>
  flags: TriageFlag[]
}

// Kept for the tab so coming back from an episode paints instantly.
const dataCache = new Map<string, TriageData>()

const DECISIONS: { key: string; label: string; hint: string; status: ReviewStatus; note: string; tone?: 'bad' | 'neutral' }[] = [
  { key: '1', label: 'Not what aired', hint: 'Misheard, or bleeped on air', status: 'dismissed', note: 'Not what aired (misheard or bleeped)' },
  { key: '2', label: 'News, quote or name', hint: 'Reporting, a title, a name', status: 'dismissed', note: 'Newsworthy, quoted, or a name/title' },
  { key: '3', label: 'Fine in context', hint: 'Add a note if useful', status: 'dismissed', note: 'Fine in context' },
  { key: '4', label: 'Violation', hint: 'Log it for the GM', status: 'violation', note: 'Violation', tone: 'bad' },
  { key: '5', label: 'Needs follow-up', hint: 'Come back to it', status: 'investigating', note: 'Needs follow-up', tone: 'neutral' },
]

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function airedLabel(f: TriageFlag): string {
  let day = ''
  if (f.air_date) {
    const [y, m, d] = f.air_date.split('-').map(Number)
    const dt = new Date(y, m - 1, d)
    day = `${DAYS[dt.getDay()]} ${MONTHS[m - 1]} ${d}`
  }
  if (f.aired_minute == null) return day
  const h = Math.floor(f.aired_minute / 60)
  const mm = String(f.aired_minute % 60).padStart(2, '0')
  return `${day} · ${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'am' : 'pm'}`
}

function fmtOffset(s: number | null): string {
  if (s == null) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function Excerpt({ f }: { f: TriageFlag }) {
  const text = f.excerpt ?? f.details ?? ''
  const span = termSpan(f.excerpt, f.term)
  if (!span) return <>{text}</>
  return (
    <>
      {text.slice(0, span[0])}
      <mark className="bg-amber-200/70 dark:bg-amber-400/30 text-inherit rounded px-0.5 font-semibold">{text.slice(span[0], span[1])}</mark>
      {text.slice(span[1])}
    </>
  )
}

function termChip(f: TriageFlag) {
  const label = f.term ?? (f.flag_type === 'profanity' ? 'AI: profanity' : flagTypeLabel(f.flag_type))
  const tone =
    f.tier === 'A' ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
    : f.tier === 'B' ? 'bg-amber-50 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200'
    : 'bg-warm-100 text-warm-600 dark:bg-warm-700 dark:text-warm-300'
  return <span title={label} className={`shrink-0 self-start w-24 truncate text-center font-mono text-xs px-1.5 py-0.5 rounded ${tone}`}>{label}</span>
}

export default function TriagePage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { role } = useNavAccess()
  const canDecide = role === 'editor' || role === 'admin' || role === 'super'

  const current = getCurrentQuarter()
  const quarter = searchParams.get('quarter') ?? `${current.year}-${current.quarter}`
  const tier = (TIERS.includes(searchParams.get('tier') as Tier) ? searchParams.get('tier') : 'A') as Tier
  const showDone = searchParams.get('done') === '1'

  const [data, setData] = useState<TriageData | null>(() => dataCache.get(quarter) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [scope, setScope] = useState<'one' | 'term-show'>('one')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmBulk, setConfirmBulk] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)

  const setParam = useCallback((changes: Record<string, string | null>) => {
    const p = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(changes)) v == null ? p.delete(k) : p.set(k, v)
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }, [pathname, router, searchParams])

  const load = useCallback(async () => {
    try {
      const res = await authedFetch(`/api/compliance/triage?quarter=${quarter}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as TriageData
      dataCache.set(quarter, d)
      setData(d)
      setError(null)
    } catch {
      setError('The flags could not be loaded. Refresh to try again.')
    }
  }, [quarter])

  useEffect(() => {
    setData(dataCache.get(quarter) ?? null)
    load()
  }, [quarter, load])

  // The list for the current tier: open first (in airing order), done after.
  const list = useMemo(() => {
    const rows = (data?.flags ?? []).filter((f) => f.tier === tier && (showDone || OPEN_STATUSES.has(f.review_status)))
    return rows.sort((a, b) => Number(!OPEN_STATUSES.has(a.review_status)) - Number(!OPEN_STATUSES.has(b.review_status)))
  }, [data, tier, showDone])

  const selected = list.find((f) => f.id === selectedId) ?? list.find((f) => OPEN_STATUSES.has(f.review_status)) ?? list[0] ?? null

  // Same word on the same show, still open, in this tier.
  const siblings = useMemo(() => {
    if (!selected?.term || !data) return []
    return data.flags.filter((f) => f.id !== selected.id && f.tier === selected.tier && f.term === selected.term &&
      f.show_key === selected.show_key && OPEN_STATUSES.has(f.review_status))
  }, [data, selected])

  useEffect(() => { setScope('one'); setNote('') }, [selected?.id])

  // Keep the selected row in view as J/K moves through the list.
  useEffect(() => {
    if (!selected) return
    document.getElementById(`flag-${selected.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── audio ─── */
  const play = useCallback(() => {
    const a = audioRef.current
    if (!a || !selected?.mp3_url) return
    if (!a.paused && a.dataset.flag === String(selected.id)) { a.pause(); return }
    const startAt = Math.max(0, (selected.timestamp_seconds ?? 0) - 10)
    if (a.dataset.src !== selected.mp3_url) {
      a.src = selected.mp3_url
      a.dataset.src = selected.mp3_url
      a.addEventListener('loadedmetadata', () => { a.currentTime = startAt; a.play().catch(() => {}) }, { once: true })
      a.load()
    } else {
      a.currentTime = startAt
      a.play().catch(() => {})
    }
    a.dataset.flag = String(selected.id)
  }, [selected])

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const on = () => setPlaying(!a.paused)
    a.addEventListener('play', on); a.addEventListener('pause', on); a.addEventListener('ended', on)
    return () => { a.removeEventListener('play', on); a.removeEventListener('pause', on); a.removeEventListener('ended', on) }
  }, [])

  // Moving to another flag stops the clip of the previous one.
  useEffect(() => {
    const a = audioRef.current
    if (a && a.dataset.flag && a.dataset.flag !== String(selected?.id)) a.pause()
  }, [selected?.id])

  /* ─── writes ─── */
  const patch = useCallback(async (ids: number[], status: ReviewStatus, notes: string | null) => {
    for (let i = 0; i < ids.length; i += 100) {
      const res = await authedFetch('/api/compliance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids.slice(i, i + 100), review_status: status, resolved_notes: notes }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    }
  }, [])

  const applyLocal = useCallback((changes: Map<number, { review_status: ReviewStatus; resolved_notes: string | null }>) => {
    setData((d) => {
      if (!d) return d
      const counts = structuredClone(d.counts)
      const flags = d.flags.map((f) => {
        const c = changes.get(f.id)
        if (!c) return f
        const wasOpen = OPEN_STATUSES.has(f.review_status)
        const isOpen = OPEN_STATUSES.has(c.review_status)
        if (wasOpen !== isOpen) {
          counts[f.tier].open += isOpen ? 1 : -1
          counts[f.tier].done += isOpen ? -1 : 1
        }
        return { ...f, ...c }
      })
      const next = { ...d, counts, flags }
      dataCache.set(d.quarter, next)
      return next
    })
  }, [])

  const decide = useCallback(async (targets: TriageFlag[], status: ReviewStatus, notes: string, label: string) => {
    if (!targets.length || busy) return
    setBusy(true)
    const before = new Map(targets.map((f) => [f.id, { review_status: f.review_status, resolved_notes: f.resolved_notes }]))
    const after = new Map(targets.map((f) => [f.id, { review_status: status, resolved_notes: notes }]))
    // Move on immediately: the next open flag after this one in the list.
    const idx = list.findIndex((f) => f.id === targets[0].id)
    const ids = new Set(targets.map((t) => t.id))
    const nextOpen = list.slice(idx + 1).find((f) => !ids.has(f.id) && OPEN_STATUSES.has(f.review_status))
      ?? list.find((f) => !ids.has(f.id) && OPEN_STATUSES.has(f.review_status))
    applyLocal(after)
    if (status !== 'investigating' && OPEN_STATUSES.has(targets[0].review_status)) setSelectedId(nextOpen?.id ?? null)
    try {
      await patch(targets.map((t) => t.id), status, notes)
      toast('success', `${targets.length === 1 ? 'Flag' : `${targets.length} flags`}: ${label}`, {
        label: 'Undo',
        onClick: async () => {
          applyLocal(before)
          setSelectedId(targets[0].id)
          // Restore each original status (grouped, so it's one write per status).
          const groups = new Map<string, number[]>()
          before.forEach((v, id) => {
            const k = JSON.stringify([v.review_status, v.resolved_notes])
            groups.set(k, [...(groups.get(k) ?? []), id])
          })
          try {
            for (const [k, gids] of Array.from(groups)) {
              const [st, n] = JSON.parse(k)
              await patch(gids, st, n)
            }
          } catch {
            toast('error', 'Undo failed. Refresh and check those flags.')
          }
        },
      })
    } catch {
      applyLocal(before)
      setSelectedId(targets[0].id)
      toast('error', 'That decision was not saved. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }, [applyLocal, busy, list, patch, toast])

  const decideSelected = useCallback((d: (typeof DECISIONS)[number]) => {
    if (!selected || !canDecide) return
    const targets = scope === 'term-show' ? [selected, ...siblings] : [selected]
    const notes = note.trim() ? `${d.note}: ${note.trim()}` : d.note
    decide(targets, d.status, notes, d.label)
  }, [canDecide, decide, note, scope, selected, siblings])

  const bulkTargets = useMemo(() => {
    if (!data) return []
    if (tier === 'C') return data.flags.filter((f) => f.tier === 'C' && OPEN_STATUSES.has(f.review_status))
    if (tier === 'D') return data.flags.filter((f) => f.tier === 'D' && f.check_off && OPEN_STATUSES.has(f.review_status))
    return []
  }, [data, tier])

  useEffect(() => { setConfirmBulk(false) }, [tier, quarter])

  /* ─── keyboard ─── */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      // Pause shortcuts only while typing (a note, the quarter picker) — not
      // after clicking a radio or checkbox, which also takes focus.
      const typing = t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
        (t.tagName === 'INPUT' && !['radio', 'checkbox'].includes((t as HTMLInputElement).type))
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      const i = selected ? list.findIndex((f) => f.id === selected.id) : -1
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); if (list[i + 1]) setSelectedId(list[i + 1].id) }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) setSelectedId(list[i - 1].id) }
      else if (e.key === ' ') { e.preventDefault(); play() }
      else {
        const d = DECISIONS.find((x) => x.key === e.key)
        if (d) { e.preventDefault(); decideSelected(d) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [decideSelected, list, play, selected])

  /* ─── render ─── */
  const counts = data?.counts
  const quarterOptions = getQuarterOptions(1)
  const from = locationFrom(pathname, searchParams.toString())
  const aTotal = counts ? counts.A.open + counts.A.done : 0

  const detail = selected && (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-warm-500">{airedLabel(selected)}</p>
          <h2 className="text-lg font-semibold text-warm-900 dark:text-warm-50 truncate">{selected.show_name}</h2>
        </div>
        <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${
          selected.tier === 'A' ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
          : selected.tier === 'B' ? 'bg-amber-50 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200'
          : 'bg-warm-100 text-warm-600 dark:bg-warm-700 dark:text-warm-300'}`}>
          {TIER_LABELS[selected.tier].title}
        </span>
      </div>

      <div className="rounded-lg bg-warm-50 dark:bg-warm-800/60 p-3 space-y-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={play}
            disabled={!selected.mp3_url}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warm-900 text-white text-sm font-medium disabled:opacity-40 dark:bg-warm-100 dark:text-warm-900"
          >
            {playing && audioRef.current?.dataset.flag === String(selected.id) ? '❚❚ Pause' : '▶ Play from 10s before'}
          </button>
          <span className="text-xs text-warm-500 font-mono">{selected.timestamp_seconds != null ? `${fmtOffset(selected.timestamp_seconds)} into the episode` : 'moment not found in the captions'}</span>
        </div>
        <p className="text-sm text-warm-700 dark:text-warm-200 leading-relaxed"><Excerpt f={selected} /></p>
        {selected.term == null && selected.details && <p className="text-xs text-warm-500">{selected.details}</p>}
        <Link
          href={withFrom(`/dashboard/episodes/${selected.episode_id}${selected.timestamp_seconds != null ? `?seek=${selected.timestamp_seconds}` : ''}`, from)}
          className="inline-block text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400"
        >
          Open the episode and transcript →
        </Link>
      </div>

      {!OPEN_STATUSES.has(selected.review_status) && (
        <p className="text-sm text-warm-600 dark:text-warm-300">
          Decided: <span className="font-medium">{selected.review_status}</span>
          {selected.resolved_notes ? ` · ${selected.resolved_notes}` : ''}
          {selected.resolved_by ? ` · ${selected.resolved_by}` : ''}
        </p>
      )}

      {canDecide ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            {DECISIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                disabled={busy}
                onClick={() => decideSelected(d)}
                className={`text-left rounded-lg border px-3 py-2 transition-colors disabled:opacity-50 ${
                  d.tone === 'bad' ? 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10'
                  : 'border-warm-200 hover:bg-warm-50 dark:border-warm-600 dark:hover:bg-warm-700/50'}`}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <kbd className="hidden md:inline text-[10px] font-mono border border-warm-300 dark:border-warm-600 rounded px-1">{d.key}</kbd>
                  {d.label}
                </span>
                <span className="block text-xs text-warm-500">{d.hint}</span>
              </button>
            ))}
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (saved with the decision)"
            className="w-full text-sm rounded-lg border border-warm-200 dark:border-warm-600 bg-white dark:bg-warm-800 px-3 py-2"
          />
          {siblings.length > 0 && (
            <fieldset className="space-y-1 text-sm">
              <legend className="text-xs font-semibold uppercase tracking-wide text-warm-500 mb-1">Apply to</legend>
              <label className="flex items-center gap-2"><input type="radio" checked={scope === 'one'} onChange={() => setScope('one')} /> This flag only</label>
              <label className="flex items-center gap-2"><input type="radio" checked={scope === 'term-show'} onChange={() => setScope('term-show')} /> All {siblings.length + 1} open “{selected.term}” flags on {selected.show_name} here</label>
            </fieldset>
          )}
        </>
      ) : (
        <p className="text-sm text-warm-500">You can view flags. Deciding them needs an editor role at this station.</p>
      )}
    </div>
  )

  return (
    <div className="space-y-5">
      <Breadcrumbs />
      <audio ref={audioRef} preload="none" className="hidden" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-warm-900 dark:text-warm-50">Review flags</h1>
          <p className="text-sm text-warm-500">Start with what the FCC could act on. Everything else closes by rule.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Quarter"
            value={quarter}
            onChange={(e) => { setSelectedId(null); setParam({ quarter: e.target.value }) }}
            className="text-sm rounded-lg border border-warm-200 dark:border-warm-600 bg-white dark:bg-warm-800 px-2.5 py-1.5"
          >
            {quarterOptions.map((o) => <option key={`${o.year}-${o.quarter}`} value={`${o.year}-${o.quarter}`}>{o.label}</option>)}
          </select>
          <Link href="/dashboard/compliance" className="text-sm px-3 py-1.5 rounded-lg border border-warm-200 dark:border-warm-600 hover:bg-warm-50 dark:hover:bg-warm-700/50">All flags</Link>
        </div>
      </div>

      {/* Tier tabs — same size whether or not counts have loaded. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" role="tablist" aria-label="Tiers">
        {TIERS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tier === t}
            onClick={() => { setSelectedId(null); setParam({ tier: t }) }}
            className={`text-left rounded-xl border p-3 bg-white dark:bg-surface-raised transition-shadow ${
              tier === t ? 'border-kpfk-red ring-2 ring-kpfk-red/15' : 'border-warm-200 dark:border-warm-700 hover:border-warm-300'}`}
          >
            <span className={`text-xs font-semibold uppercase tracking-wide ${t === 'A' ? 'text-red-600 dark:text-red-400' : t === 'B' ? 'text-amber-700 dark:text-amber-300' : 'text-warm-500'}`}>
              {t} · {TIER_LABELS[t].title}
            </span>
            <span className="block text-2xl font-bold tabular-nums text-warm-900 dark:text-warm-50">
              {counts ? counts[t].open : <span className="inline-block h-7 w-10 rounded bg-warm-100 dark:bg-warm-700 animate-pulse align-middle" />}
            </span>
            <span className="block text-xs text-warm-500">{TIER_LABELS[t].rule}</span>
          </button>
        ))}
      </div>

      {tier === 'A' && counts && (
        <div className="flex items-center gap-3 text-sm text-warm-600 dark:text-warm-300">
          <span className="tabular-nums"><b>{counts.A.done}</b> of <b>{aTotal}</b> listen-now flags decided this quarter</span>
          <div className="flex-1 max-w-xs h-1.5 rounded-full bg-warm-100 dark:bg-warm-700 overflow-hidden">
            <div className="h-full bg-kpfk-red" style={{ width: `${aTotal ? (counts.A.done / aTotal) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      {canDecide && (tier === 'C' || tier === 'D') && bulkTargets.length > 0 && (
        <div className="rounded-xl border border-warm-200 dark:border-warm-700 bg-white dark:bg-surface-raised p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-warm-700 dark:text-warm-200 max-w-2xl">
            {tier === 'C'
              ? <>These {bulkTargets.length} aired between 10pm and 6am, when the FCC allows profane and indecent (not obscene) speech. Acknowledging closes them and keeps them on record.</>
              : <>{bulkTargets.length} of these come from checks that are switched off for this station (usually sponsor and payola, which mostly caught correct underwriting credits). Retiring closes them and keeps them on record.</>}
          </p>
          {confirmBulk ? (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setConfirmBulk(false)} className="text-sm px-3 py-1.5 rounded-lg border border-warm-200 dark:border-warm-600">Cancel</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setConfirmBulk(false); decide(bulkTargets, 'dismissed', tier === 'C' ? 'Safe harbor: aired 10pm–6am' : 'Check turned off for this station', tier === 'C' ? 'acknowledged' : 'retired') }}
                className="text-sm px-3 py-1.5 rounded-lg bg-kpfk-red text-white font-medium disabled:opacity-50"
              >
                Yes, close {bulkTargets.length}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmBulk(true)} className="text-sm px-3 py-1.5 rounded-lg bg-warm-900 text-white font-medium dark:bg-warm-100 dark:text-warm-900">
              {tier === 'C' ? `Acknowledge ${bulkTargets.length}` : `Retire ${bulkTargets.length}`}
            </button>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-4 items-start">
        <div className="rounded-xl border border-warm-200 dark:border-warm-700 bg-white dark:bg-surface-raised overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-warm-100 dark:border-warm-700">
            <h2 className="text-sm font-semibold">{tier} · {TIER_LABELS[tier].title}</h2>
            <div className="flex items-center gap-3 text-xs text-warm-500">
              <span className="hidden md:inline"><kbd className="font-mono">J</kbd>/<kbd className="font-mono">K</kbd> move · <kbd className="font-mono">Space</kbd> play · <kbd className="font-mono">1</kbd>–<kbd className="font-mono">5</kbd> decide</span>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={showDone} onChange={(e) => setParam({ done: e.target.checked ? '1' : null })} /> Show decided
              </label>
            </div>
          </div>
          {!data ? (
            <div className="p-4 space-y-3" aria-busy="true">
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 rounded bg-warm-50 dark:bg-warm-800 animate-pulse" />)}
            </div>
          ) : list.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-warm-500">
              {tier === 'A' || tier === 'B' ? 'Nothing left to decide here. ' : 'Nothing open here. '}
              {counts && counts[tier].done > 0 ? 'Tick “Show decided” to see what was decided.' : ''}
            </p>
          ) : (
            <ul role="listbox" aria-label="Flags" className="divide-y divide-warm-100 dark:divide-warm-700 lg:max-h-[70vh] lg:overflow-y-auto">
              {list.map((f) => {
                const isSel = selected?.id === f.id
                const done = !OPEN_STATUSES.has(f.review_status)
                return (
                  <li key={f.id} id={`flag-${f.id}`} role="option" aria-selected={isSel}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(f.id)}
                      className={`w-full text-left px-4 py-3 flex gap-3 border-l-4 ${isSel ? 'bg-warm-50 dark:bg-warm-800/70 border-kpfk-red' : 'border-transparent hover:bg-warm-50/60 dark:hover:bg-warm-800/40'} ${done ? 'opacity-60' : ''}`}
                    >
                      {termChip(f)}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm">
                          <span className="font-medium truncate">{f.show_name}</span>
                          {done && <span className="text-[11px] px-1.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">{f.review_status}</span>}
                          {f.review_status === 'investigating' && <span className="text-[11px] px-1.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">follow-up</span>}
                        </span>
                        <span className="block text-xs text-warm-500">{airedLabel(f)}</span>
                        <span className="block text-sm text-warm-600 dark:text-warm-300 line-clamp-2"><Excerpt f={f} /></span>
                      </span>
                    </button>
                    {/* On a phone the decision panel opens under the chosen flag. */}
                    {isSel && <div className="lg:hidden px-4 pb-4">{detail}</div>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="hidden lg:block sticky top-6 rounded-xl border border-warm-200 dark:border-warm-700 bg-white dark:bg-surface-raised p-5 min-h-[20rem]">
          {detail ?? <p className="text-sm text-warm-500">{data ? 'Pick a flag to review it.' : 'Loading…'}</p>}
        </div>
      </div>
    </div>
  )
}
