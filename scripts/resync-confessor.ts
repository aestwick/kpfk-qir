/**
 * Operator CLI for the Confessor re-sync. The same logic runs nightly in the
 * workers (workers/confessor-resync.ts → lib/confessor-resync.ts); use this for
 * a dry-run preview, one show, or a run between nightly passes.
 *
 *   npm run resync-confessor -- --station kpfk                 # dry run, last 30 days
 *   npm run resync-confessor -- --station kpfk --apply         # actually write
 *   npm run resync-confessor -- --station kpfk --days 7 --apply
 *   npm run resync-confessor -- --station kpfk --show uprising --apply
 *   npm run resync-confessor -- --station kpfk --apply --resummarize
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --apply. --resummarize
 * (with --apply) sends published episodes whose host/guest moved back through
 * the summarizer, as the nightly job does; it needs REDIS_URL.
 *
 * Exit status is non-zero if any episode write failed or any show could not be
 * read — "nothing changed upstream" and "we could not ask" must not look alike.
 *
 * Requirements: worker env (SUPABASE service role). Writes episode_log and one
 * audit_log row; reads Confessor over the network.
 */
import { supabaseAdmin } from '../lib/supabase'
import { resyncConfessor } from '../lib/confessor-resync'
import { summarizeQueue } from '../lib/queue'

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const station = get('--station')
  if (!station) {
    console.error(
      'Usage: npm run resync-confessor -- --station <slug> [--days 30] [--show <key>] [--num 50] [--apply] [--resummarize]',
    )
    process.exit(1)
  }
  const apply = argv.includes('--apply')
  return {
    station,
    days: Number(get('--days') ?? 30),
    show: get('--show'),
    num: Number(get('--num') ?? 50),
    apply,
    resummarize: apply && argv.includes('--resummarize'),
  }
}

const trunc = (v: string | null, n = 60): string =>
  v == null ? '(none)' : v.length > n ? v.slice(0, n - 1) + '…' : v

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const { data: station, error } = await supabaseAdmin
    .from('stations')
    .select('id')
    .eq('slug', args.station)
    .maybeSingle()
  if (error) throw new Error(`station lookup failed: ${error.message}`)
  if (!station) throw new Error(`no station with slug '${args.station}'`)

  const r = await resyncConfessor(station.id, {
    days: args.days,
    show: args.show,
    num: args.num,
    apply: args.apply,
    resummarize: args.resummarize,
    trigger: 'cli',
  })

  console.log(
    `${r.station.name} — re-read Confessor for ${r.showsRead} show(s), episodes aired since ${r.since}` +
      `${args.apply ? '' : '  [DRY RUN]'}`,
  )
  console.log(
    `fetched ${r.fetched} Confessor row(s), matched ${r.matched} episode(s), ` +
      `${r.changes.length} with changed human metadata`,
  )
  if (r.failedShows.length) {
    console.log(`\n${r.failedShows.length} show(s) could not be read: ${r.failedShows.join(', ')}`)
  }

  for (const c of r.changes) {
    console.log(`\n  ${c.airDate ?? '(no date)'}  ${c.showKey}  ${c.publicId}`)
    for (const f of c.fields) console.log(`    ${f}: ${trunc(c.before[f])}  →  ${trunc(c.after[f])}`)
    if (c.pinned.length) console.log(`    (pinned, copy refreshed but display unchanged: ${c.pinned.join(', ')})`)
  }

  const byField = Object.entries(r.byField)
  if (byField.length) console.log('\nby field: ' + byField.map(([f, n]) => `${f} ${n}`).join(', '))

  if (!args.apply && r.changes.length) console.log('\nDRY RUN — nothing written. Re-run with --apply to persist.')

  if (args.apply) {
    // Counts report what actually landed — an overstated success is worse than
    // a loud failure, because nobody re-runs a run that claimed to work.
    console.log(
      `\napplied: ${r.written} written, ${r.conflicts.length} skipped (changed mid-run), ${r.failures.length} failed` +
        (args.resummarize ? `, ${r.resummarized.length} sent to re-summarize` : ''),
    )
    if (r.conflicts.length) console.log(`  skipped: ${r.conflicts.join(', ')}`)
    if (r.failures.length) console.log(`  failed:  ${r.failures.join(', ')}`)
  }

  if (args.resummarize) await summarizeQueue.close()
  if (r.failures.length || r.failedShows.length) process.exit(1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
