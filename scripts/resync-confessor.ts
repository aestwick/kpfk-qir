/**
 * Re-read the Confessor pubfile for episodes already in the log, and refresh the
 * HUMAN copies of the dual-authored fields.
 *
 * Why this exists: ingest is insert-only. It dedupes by mp3_url and skips any
 * airing it has seen (`if (existing) continue`), so the human pubfile is a
 * snapshot taken once, usually within an hour of air. A producer who fills in a
 * guest the next morning, corrects a spelling, or adds the FCC issue tags after
 * the fact was, until this script, editing into a void as far as QIR and the
 * quarterly report were concerned.
 *
 *   npm run resync-confessor -- --station kpfk                 # dry run, last 30 days
 *   npm run resync-confessor -- --station kpfk --apply         # actually write
 *   npm run resync-confessor -- --station kpfk --days 7 --apply
 *   npm run resync-confessor -- --station kpfk --show uprising --apply
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --apply.
 *
 * What it will not do (lib/field-sources.ts#applyHuman enforces this):
 *   - overwrite an AI copy
 *   - overwrite a hand-typed manual override
 *   - change which source wins on a PINNED field — someone chose that
 * A pinned field still gets its human copy refreshed so the dashboard shows the
 * current upstream value; the pinned choice keeps driving the flat column.
 *
 * Scope limit worth knowing: Confessor's `?req=fil` only returns airings still
 * inside the archive window (older rows report mp3="expired" and are dropped by
 * the API itself). Episodes past that window cannot be re-read at any --days
 * value, so run this often enough to catch edits while the audio is still live.
 *
 * Side effect worth knowing: every updated row's updated_at moves, which pushes
 * it into the next delta for anyone syncing /api/v1/episodes?updated_since=.
 * That is correct — the data did change — but a first large run will look like a
 * burst to a consumer.
 *
 * Exit status is non-zero if any episode write failed or any show could not be
 * read — "nothing changed upstream" and "we could not ask" must not look alike
 * to a cron.
 *
 * Requirements: worker env (SUPABASE service role). Writes episode_log and one
 * audit_log row; reads Confessor over the network.
 */
import { supabaseAdmin } from '../lib/supabase'
import { fetchConfessorEpisodes, normalizeConfessorMp3Url, projectPubfile } from '../lib/confessor'
import { applyHuman, seedMissingFromFlat, type DualField, type FieldSources } from '../lib/field-sources'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import type { ConfessorPubfile } from '../lib/types'

interface Args {
  station: string
  days: number
  show?: string
  apply: boolean
  /** How many rows to ask Confessor for per show. */
  num: number
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const station = get('--station')
  if (!station) {
    console.error('Usage: npm run resync-confessor -- --station <slug> [--days 30] [--show <key>] [--num 50] [--apply]')
    process.exit(1)
  }
  return {
    station,
    days: Number(get('--days') ?? 30),
    show: get('--show'),
    num: Number(get('--num') ?? 50),
    apply: argv.includes('--apply'),
  }
}

/** The episode columns this script reads and may rewrite. */
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
}

interface Change {
  episode: EpisodeRow
  fields: DualField[]
  before: Record<DualField, string | null>
  after: Record<DualField, string | null>
  pubfile: ConfessorPubfile[] | null
  humanSummary: string | null
  fieldSources: FieldSources
}

const trunc = (v: string | null, n = 60): string =>
  v == null ? '(none)' : v.length > n ? v.slice(0, n - 1) + '…' : v

type WriteResult = 'written' | 'conflict' | 'failed'

/**
 * Write one episode's refreshed human metadata, re-reading its current state
 * first and writing only if nothing else has touched the row since.
 *
 * Every episode is loaded up front, before the per-show network fetches, so the
 * snapshot in memory can be minutes old by the time we write. A curator who
 * pins a field or an edit that lands in that window would be silently
 * overwritten by the stale field_sources. So: re-read, recompute against what
 * is actually there now, and make the UPDATE conditional on updated_at being
 * unchanged. A row that moved under us is reported as a conflict and left
 * alone — re-running the script picks it up cleanly.
 */
async function writeEpisode(
  episode: EpisodeRow,
  pubfile: ConfessorPubfile[] | null,
  humanSummary: string | null,
  human: Record<DualField, string | null>,
): Promise<WriteResult> {
  const { data: fresh, error: readErr } = await supabaseAdmin
    .from('episode_log')
    .select('field_sources, host, guest, issue_category, summary, updated_at')
    .eq('id', episode.id)
    .maybeSingle()

  if (readErr || !fresh) {
    console.warn(`  ! re-read failed for ${episode.public_id}: ${readErr?.message ?? 'row vanished'}`)
    return 'failed'
  }

  const f = fresh as unknown as {
    field_sources: FieldSources | null
    host: string | null
    guest: string | null
    issue_category: string | null
    summary: string | null
    updated_at: string
  }

  const seeded = seedMissingFromFlat(f.field_sources, {
    host: f.host, guest: f.guest, issue_category: f.issue_category, summary: f.summary,
  })
  const { fieldSources, flat, changed } = applyHuman(seeded, human)
  if (changed.length === 0) return 'conflict' // someone already applied it

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
    })
    .eq('id', episode.id)
    .eq('updated_at', f.updated_at) // optimistic: bail if the row moved
    .select('id')

  if (upErr) {
    console.warn(`  ! update failed for ${episode.public_id}: ${upErr.message}`)
    return 'failed'
  }
  if (!updated || updated.length === 0) {
    console.warn(`  ! ${episode.public_id} changed mid-run — skipped, re-run to pick it up`)
    return 'conflict'
  }
  return 'written'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const { data: station, error: stErr } = await supabaseAdmin
    .from('stations')
    .select('id, slug, name, confessor_base_url, rss_base_url, ingest_primary')
    .eq('slug', args.station)
    .maybeSingle()

  if (stErr) throw new Error(`station lookup failed: ${stErr.message}`)
  if (!station) throw new Error(`no station with slug '${args.station}'`)
  if (!station.confessor_base_url) {
    throw new Error(
      `station '${args.station}' has no confessor_base_url — only Confessor-primary stations carry human pubfile metadata`,
    )
  }

  // Episodes in the window. 'archived' is the inert PRA import and has no
  // Confessor relationship; everything else is fair game, including RSS-ingested
  // rows (a Confessor row can match one by mp3_url, which is how an RSS episode
  // picks up human metadata it never had).
  const since = new Date(Date.now() - args.days * 86400_000).toISOString().slice(0, 10)
  let epQuery = supabaseAdmin
    .from('episode_log')
    .select('id, public_id, show_key, air_date, status, host, guest, issue_category, summary, human_summary, field_sources, mp3_url')
    .eq('station_id', station.id)
    .neq('status', 'archived')
    .gte('air_date', since)
  if (args.show) epQuery = epQuery.eq('show_key', args.show)

  const { data: episodes, error: epErr } = await epQuery
  if (epErr) throw new Error(`episode load failed: ${epErr.message}`)

  const byUrl = new Map<string, EpisodeRow>()
  for (const e of episodes ?? []) byUrl.set((e as unknown as { mp3_url: string }).mp3_url, e as unknown as EpisodeRow)

  const showKeys = args.show
    ? [args.show]
    : Array.from(new Set((episodes ?? []).map((e) => (e as unknown as EpisodeRow).show_key)))

  console.log(
    `${station.name} — re-reading Confessor for ${showKeys.length} show(s), ` +
      `${byUrl.size} episode(s) aired since ${since}${args.apply ? '' : '  [DRY RUN]'}`,
  )

  const changes: Change[] = []
  let fetched = 0
  let matched = 0
  let written = 0
  const failedShows: string[] = []
  const failures: string[] = []
  const conflicts: string[] = []

  for (const key of showKeys) {
    let rows
    try {
      rows = await fetchConfessorEpisodes(station.confessor_base_url, key, args.num)
    } catch (err) {
      // A show that fails to fetch is reported, never silently skipped — a
      // network blip must not read as "nothing changed upstream".
      failedShows.push(key)
      console.warn(`  ! ${key}: ${err instanceof Error ? err.message : err}`)
      continue
    }
    fetched += rows.length

    for (const row of rows) {
      if (!row.mp3 || row.mp3 === 'expired') continue
      const url = normalizeConfessorMp3Url(row.mp3, station.rss_base_url)
      const episode = byUrl.get(url)
      if (!episode) continue // not in our window, or never ingested
      matched++

      const proj = projectPubfile(row.pubfile)
      const human: Record<DualField, string | null> = {
        host: proj.host,
        guest: proj.guest,
        issue_category: proj.issueCategory,
        summary: proj.humanSummary,
      }
      // Seed provenance for fields that have none. ~2,500 episodes predate
      // migration 036 and carry real flat values with no field_sources entry;
      // without this, any field the pubfile does not supply resolves to null and
      // the existing value is destroyed on write.
      const seeded = seedMissingFromFlat(episode.field_sources, {
        host: episode.host,
        guest: episode.guest,
        issue_category: episode.issue_category,
        summary: episode.summary,
      })
      const { fieldSources, flat, changed } = applyHuman(seeded, human)
      if (changed.length === 0) continue

      changes.push({
        episode,
        fields: changed,
        before: {
          host: episode.field_sources?.host?.human ?? null,
          guest: episode.field_sources?.guest?.human ?? null,
          issue_category: episode.field_sources?.issue_category?.human ?? null,
          summary: episode.field_sources?.summary?.human ?? null,
        },
        after: human,
        pubfile: row.pubfile && row.pubfile.length ? row.pubfile : null,
        humanSummary: proj.humanSummary,
        fieldSources,
      })

      if (args.apply) {
        const ok = await writeEpisode(episode, row.pubfile ?? null, proj.humanSummary, human)
        if (ok === 'written') written++
        else if (ok === 'conflict') conflicts.push(episode.public_id)
        else failures.push(episode.public_id)
      }
    }
  }

  // --- report ---
  console.log(
    `\nfetched ${fetched} Confessor row(s), matched ${matched} episode(s), ` +
      `${changes.length} with changed human metadata`,
  )
  if (failedShows.length) {
    console.log(`\n${failedShows.length} show(s) could not be read: ${failedShows.join(', ')}`)
  }

  for (const c of changes) {
    console.log(`\n  ${c.episode.air_date ?? '(no date)'}  ${c.episode.show_key}  ${c.episode.public_id}`)
    for (const f of c.fields) {
      console.log(`    ${f}: ${trunc(c.before[f])}  →  ${trunc(c.after[f])}`)
    }
    const pinned = c.fields.filter((f) => c.fieldSources[f]?.pinned)
    if (pinned.length) {
      console.log(`    (pinned, copy refreshed but display unchanged: ${pinned.join(', ')})`)
    }
  }

  const byField = new Map<DualField, number>()
  for (const c of changes) for (const f of c.fields) byField.set(f, (byField.get(f) ?? 0) + 1)
  if (byField.size) {
    console.log('\nby field: ' + Array.from(byField).map(([f, n]) => `${f} ${n}`).join(', '))
  }

  if (!args.apply && changes.length) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to persist.')
  }

  if (args.apply) {
    // Counts report what actually landed. A write that failed or was skipped as
    // a conflict is NOT an episode changed — an overstated success is worse than
    // a loud failure, because nobody re-runs a run that claimed to work.
    console.log(`\napplied: ${written} written, ${conflicts.length} skipped (changed mid-run), ${failures.length} failed`)
    if (conflicts.length) console.log(`  skipped: ${conflicts.join(', ')}`)
    if (failures.length) console.log(`  failed:  ${failures.join(', ')}`)

    await logAuditEvent({
      action: AUDIT_ACTIONS.CONFESSOR_RESYNC,
      operation: 'update',
      stationId: station.id,
      resourceType: 'episode_log',
      metadata: {
        days: args.days,
        show: args.show ?? null,
        shows_read: showKeys.length,
        shows_failed: failedShows,
        rows_fetched: fetched,
        episodes_matched: matched,
        episodes_with_changes: changes.length,
        episodes_written: written,
        episodes_skipped_conflict: conflicts,
        episodes_failed: failures,
        by_field: Object.fromEntries(byField),
      },
    })
  }

  // Non-zero when anything did not land, so a cron or an operator's shell sees
  // a failed run rather than a silent partial one. A show whose fetch failed
  // counts too: "nothing changed upstream" and "we could not ask" are different
  // answers and must not look alike.
  if (failures.length || failedShows.length) process.exit(1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
