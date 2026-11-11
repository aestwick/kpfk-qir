/**
 * Re-read the Confessor pubfile for episodes already in the log and refresh the
 * HUMAN copies of the dual-authored fields. Shared by the nightly worker
 * (workers/confessor-resync.ts) and the operator CLI (scripts/resync-confessor.ts).
 *
 * Why this exists: ingest is insert-only. It dedupes by mp3_url and skips any
 * airing it has seen, so the human pubfile is a snapshot taken once, usually
 * within an hour of air. A producer who fills in a guest the next morning,
 * corrects a spelling, or adds the FCC issue tags afterwards would otherwise be
 * editing into a void as far as QIR and the quarterly report are concerned.
 *
 * What it will not do (lib/field-sources.ts#applyHuman enforces this):
 *   - overwrite an AI copy
 *   - overwrite a hand-typed manual override
 *   - change which source wins on a PINNED field — someone chose that
 * A pinned field still gets its human copy refreshed so the dashboard shows the
 * current upstream value; the pinned choice keeps driving the flat column.
 *
 * Re-summarize (opt-in, `resummarize: true`): when a write changes anything the
 * summarizer is fed (lib/summarize-input.ts: resolved host/guest, producer notes,
 * producer issue tags) on a published episode, it is sent back through summarize (status → transcribed, priority so
 * the current-quarter window can't strand it; compliance clears priority when it
 * re-checks). The AI copies are regenerated; pinned/manual choices still win.
 *
 * Scope limit: Confessor's `?req=fil` only returns airings still inside the
 * archive window (~60 days for most KPFK shows). Older episodes cannot be
 * re-read at any `days` value, which is why this runs nightly.
 *
 * Side effect: every updated row's updated_at moves, so it appears in the next
 * /api/v1/episodes?updated_since= delta. Correct — the data did change.
 */
import { supabaseAdmin } from './supabase'
import { fetchConfessorEpisodes, normalizeConfessorMp3Url, projectPubfile } from './confessor'
import {
  applyHuman,
  seedMissingFromFlat,
  type DualField,
  type FieldSources,
} from './field-sources'
import { logAuditEvent, AUDIT_ACTIONS } from './audit'
import { fetchAllRows } from './fetch-all'
import { PUBLISHED_STATUSES } from './episode-feed'
import { summarizeQueue } from './queue'
import { getExcludedCategories } from './settings'
import { summarizeInputs, summarizeInputsChanged } from './summarize-input'
import type { ConfessorPubfile } from './types'

export interface ResyncOptions {
  /** Look-back window on air_date. Confessor itself stops at ~60 days. */
  days: number
  /** Limit to one show key. */
  show?: string
  /** Write changes. False = dry run (report only). */
  apply: boolean
  /** Rows to ask Confessor for per show (a daily show needs ≥ days). */
  num: number
  /** Re-run the summarizer when a write moves a published episode's host/guest. */
  resummarize: boolean
  /** Recorded on the audit row: 'cron' | 'cli'. */
  trigger: string
}

interface EpisodeRow {
  id: number
  public_id: string
  show_key: string
  air_date: string | null
  status: string
  host: string | null
  guest: string | null
  issue_category: string | null
  summary: string | null
  human_summary: string | null
  field_sources: FieldSources | null
  mp3_url: string
}

export interface ResyncChange {
  publicId: string
  showKey: string
  airDate: string | null
  fields: DualField[]
  before: Record<DualField, string | null>
  after: Record<DualField, string | null>
  /** Fields whose human copy changed but whose display is held by a pin. */
  pinned: DualField[]
}

export interface ResyncReport {
  station: { id: string; slug: string; name: string }
  since: string
  showsRead: number
  fetched: number
  matched: number
  changes: ResyncChange[]
  written: number
  conflicts: string[]
  failures: string[]
  failedShows: string[]
  resummarized: string[]
  byField: Partial<Record<DualField, number>>
}

type WriteResult = { result: 'written'; resummarized: boolean } | { result: 'conflict' | 'failed' }

const PUBLISHED = new Set<string>(PUBLISHED_STATUSES)

/**
 * Write one episode's refreshed human metadata, re-reading its current state
 * first and writing only if nothing else has touched the row since.
 *
 * Episodes are loaded up front, before the per-show network fetches, so the
 * in-memory snapshot can be minutes old by write time. A curator's pin or edit
 * in that window would be silently overwritten by stale field_sources. So:
 * re-read, recompute against what is actually there, and make the UPDATE
 * conditional on updated_at being unchanged. A row that moved is a conflict and
 * is left alone — the next run picks it up.
 */
async function writeEpisode(
  episode: EpisodeRow,
  pubfile: ConfessorPubfile[] | null,
  humanSummary: string | null,
  human: Record<DualField, string | null>,
  resummarize: boolean,
  excludedCategories: string[],
): Promise<WriteResult> {
  const { data: fresh, error: readErr } = await supabaseAdmin
    .from('episode_log')
    .select('field_sources, host, guest, issue_category, summary, human_summary, status, category, updated_at')
    .eq('id', episode.id)
    .maybeSingle()

  if (readErr || !fresh) {
    console.warn(`[confessor-resync] re-read failed for ${episode.public_id}: ${readErr?.message ?? 'row vanished'}`)
    return { result: 'failed' }
  }

  const f = fresh as unknown as {
    field_sources: FieldSources | null
    host: string | null
    guest: string | null
    issue_category: string | null
    summary: string | null
    human_summary: string | null
    status: string
    category: string | null
    updated_at: string
  }
  const beforeFlat = { host: f.host, guest: f.guest, issue_category: f.issue_category, summary: f.summary }

  const seeded = seedMissingFromFlat(f.field_sources, beforeFlat)
  const { fieldSources, flat, changed } = applyHuman(seeded, human)
  if (changed.length === 0) return { result: 'conflict' } // someone already applied it

  // Only a published episode is sent back: anything earlier in the pipeline
  // will be summarized with the new host/guest anyway, and a failed one is
  // auto-retry's business.
  // The summarizer never claims an excluded category (workers/summarize.ts,
  // priority or not), so resetting one to `transcribed` would strand it
  // unpublished. Same substring semantics as the summarizer.
  const excluded = excludedCategories.some((exc) => f.category?.includes(exc))
  const rerun =
    resummarize &&
    !excluded &&
    PUBLISHED.has(f.status) &&
    summarizeInputsChanged(
      summarizeInputs({ ...beforeFlat, human_summary: f.human_summary, field_sources: f.field_sources }),
      summarizeInputs({ ...flat, human_summary: humanSummary, field_sources: fieldSources }),
    )
  const now = new Date().toISOString()

  const { data: updated, error: upErr } = await supabaseAdmin
    .from('episode_log')
    .update({
      confessor_meta: pubfile && pubfile.length ? pubfile : null,
      field_sources: fieldSources,
      human_summary: humanSummary,
      // Flat columns carry the RESOLVED active value, never the raw human copy —
      // a pinned or AI-winning field must keep what it had.
      host: flat.host,
      guest: flat.guest,
      issue_category: flat.issue_category,
      summary: flat.summary,
      // Bump it: nothing in the DB does, and the public feed's ?updated_since=
      // delta relies on it moving on every edit.
      updated_at: now,
      ...(rerun ? { status: 'transcribed', priority: true, error_message: null } : {}),
    })
    .eq('id', episode.id)
    .eq('updated_at', f.updated_at) // optimistic: bail if the row moved
    .select('id')

  if (upErr) {
    console.warn(`[confessor-resync] update failed for ${episode.public_id}: ${upErr.message}`)
    return { result: 'failed' }
  }
  if (!updated || updated.length === 0) {
    console.warn(`[confessor-resync] ${episode.public_id} changed mid-run — skipped`)
    return { result: 'conflict' }
  }
  return { result: 'written', resummarized: rerun }
}

export async function resyncConfessor(stationId: string, opts: ResyncOptions): Promise<ResyncReport> {
  const { data: station, error: stErr } = await supabaseAdmin
    .from('stations')
    .select('id, slug, name, confessor_base_url, rss_base_url')
    .eq('id', stationId)
    .maybeSingle()

  if (stErr) throw new Error(`station lookup failed: ${stErr.message}`)
  if (!station) throw new Error(`no station with id '${stationId}'`)
  if (!station.confessor_base_url) {
    throw new Error(
      `station '${station.slug}' has no confessor_base_url — only Confessor stations carry human pubfile metadata`,
    )
  }

  // 'archived' is the inert PRA import with no Confessor relationship;
  // everything else is fair game, including RSS-ingested rows (a Confessor row
  // can match one by mp3_url, which is how an RSS episode picks up human
  // metadata it never had). Paged: 60 days of KPFK is ~1,400 episodes and
  // PostgREST caps a response at 1000.
  const since = new Date(Date.now() - opts.days * 86400_000).toISOString().slice(0, 10)
  const episodes = (await fetchAllRows('episodes', (from, to) => {
    let q = supabaseAdmin
      .from('episode_log')
      .select('id, public_id, show_key, air_date, status, host, guest, issue_category, summary, human_summary, field_sources, mp3_url')
      .eq('station_id', station.id)
      .neq('status', 'archived')
      .gte('air_date', since)
    if (opts.show) q = q.eq('show_key', opts.show)
    return q.order('id').range(from, to)
  })) as unknown as EpisodeRow[]

  const byUrl = new Map<string, EpisodeRow>()
  for (const e of episodes) byUrl.set(e.mp3_url, e)

  const excludedCategories = opts.resummarize ? await getExcludedCategories(station.id) : []

  const showKeys = opts.show ? [opts.show] : Array.from(new Set(episodes.map((e) => e.show_key)))

  const report: ResyncReport = {
    station: { id: station.id, slug: station.slug, name: station.name },
    since,
    showsRead: showKeys.length,
    fetched: 0,
    matched: 0,
    changes: [],
    written: 0,
    conflicts: [],
    failures: [],
    failedShows: [],
    resummarized: [],
    byField: {},
  }

  for (const key of showKeys) {
    let rows
    try {
      rows = await fetchConfessorEpisodes(station.confessor_base_url, key, opts.num)
    } catch (err) {
      // Reported, never silently skipped — a network blip must not read as
      // "nothing changed upstream".
      report.failedShows.push(key)
      console.warn(`[confessor-resync] ${key}: ${err instanceof Error ? err.message : err}`)
      continue
    }
    report.fetched += rows.length

    for (const row of rows) {
      if (!row.mp3 || row.mp3 === 'expired') continue
      const episode = byUrl.get(normalizeConfessorMp3Url(row.mp3, station.rss_base_url))
      if (!episode) continue // outside the window, or never ingested
      report.matched++

      const proj = projectPubfile(row.pubfile)
      const human: Record<DualField, string | null> = {
        host: proj.host,
        guest: proj.guest,
        issue_category: proj.issueCategory,
        summary: proj.humanSummary,
      }
      // Seed provenance for fields that have none (~2,500 episodes predate
      // migration 036); without it any field the pubfile does not supply would
      // resolve to null and the existing value would be destroyed on write.
      const seeded = seedMissingFromFlat(episode.field_sources, {
        host: episode.host,
        guest: episode.guest,
        issue_category: episode.issue_category,
        summary: episode.summary,
      })
      const { fieldSources, changed } = applyHuman(seeded, human)
      if (changed.length === 0) continue

      report.changes.push({
        publicId: episode.public_id,
        showKey: episode.show_key,
        airDate: episode.air_date,
        fields: changed,
        before: {
          host: episode.field_sources?.host?.human ?? null,
          guest: episode.field_sources?.guest?.human ?? null,
          issue_category: episode.field_sources?.issue_category?.human ?? null,
          summary: episode.field_sources?.summary?.human ?? null,
        },
        after: human,
        pinned: changed.filter((f) => fieldSources[f]?.pinned),
      })
      for (const f of changed) report.byField[f] = (report.byField[f] ?? 0) + 1

      if (opts.apply) {
        const w = await writeEpisode(episode, row.pubfile ?? null, proj.humanSummary, human, opts.resummarize, excludedCategories)
        if (w.result === 'written') {
          report.written++
          if (w.resummarized) report.resummarized.push(episode.public_id)
        } else if (w.result === 'conflict') report.conflicts.push(episode.public_id)
        else report.failures.push(episode.public_id)
      }
    }
  }

  // One summarize job drains every episode we sent back: they are `transcribed`
  // + priority, so the candidate query picks them up whatever their air date.
  // source 'chain' so it cascades on into compliance, which returns them to
  // compliance_checked and clears priority (reviewer triage on existing flags
  // is preserved by the compliance worker).
  if (report.resummarized.length) {
    await summarizeQueue.add('confessor-resync-resummarize', { stationId: station.id, source: 'chain', chain: true })
  }

  if (opts.apply) {
    await logAuditEvent({
      action: AUDIT_ACTIONS.CONFESSOR_RESYNC,
      operation: 'update',
      stationId: station.id,
      resourceType: 'episode_log',
      metadata: {
        trigger: opts.trigger,
        days: opts.days,
        show: opts.show ?? null,
        shows_read: report.showsRead,
        shows_failed: report.failedShows,
        rows_fetched: report.fetched,
        episodes_matched: report.matched,
        episodes_with_changes: report.changes.length,
        episodes_written: report.written,
        episodes_skipped_conflict: report.conflicts,
        episodes_failed: report.failures,
        episodes_resummarized: report.resummarized,
        by_field: report.byField,
      },
    })
  }

  return report
}
