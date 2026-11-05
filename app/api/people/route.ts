import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { mergePeople, rankForQuery, samePerson, isLikelyPersonName, type PersonRow } from '@/lib/people'
import { loadShowCatalog, catalogName } from '@/lib/show-catalog'

export const dynamic = 'force-dynamic'

const PAGE = 1000
const MAX_APPEARANCE_ROWS = 10_000

// GET /api/people?q=<name>   — hosts/guests matching a (possibly misspelled)
//                              name, spelling variants merged into one person.
// GET /api/people?name=<name> — one person's appearances (every spelling),
//                              newest first.
// Backed by search_people()/person_appearances() (migration 046): SECURITY
// DEFINER with an explicit station-membership check, plus our station_id arg.
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const sp = new URL(request.url).searchParams
    // % and _ are LIKE wildcards inside search_people(); a name never needs them.
    const clean = (v: string | null) => (v ?? '').replace(/[%_\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    const name = clean(sp.get('name'))
    const q = clean(sp.get('q')) || name
    if (q.length < 2) return NextResponse.json({ people: [] })

    // "David Corn Mother Jones": a name typed with extra words (an affiliation,
    // a show) — also try each two-word window, so the name part can match.
    const words = q.split(/\s+/).filter(Boolean)
    const queries = [q, ...(words.length >= 3 ? words.slice(0, -1).map((w, i) => `${w} ${words[i + 1]}`).slice(0, 3) : [])]
    const answers = await Promise.all(
      queries.map((text) => supabase.rpc('search_people', { p_station_id: stationId, p_query: text, p_limit: 40 }))
    )
    const failed = answers.find((a) => a.error)
    if (failed?.error) return NextResponse.json({ error: failed.error.message }, { status: 500 })
    // One row per spelling (the windows overlap), keeping its best score.
    const bySpelling = new Map<string, PersonRow>()
    for (const a of answers)
      for (const r of (a.data ?? []) as PersonRow[]) {
        // The SQL splitter keeps affiliation fragments ("Amherst College");
        // the JS heuristic (shared with the Show report) drops them.
        if (!isLikelyPersonName(r.name)) continue
        const prev = bySpelling.get(r.folded)
        if (!prev || Number(r.score) > Number(prev.score)) bySpelling.set(r.folded, r)
      }
    const people = rankForQuery(mergePeople(Array.from(bySpelling.values())), q)

    if (!name) return NextResponse.json({ people: people.slice(0, 20) })

    // Detail: the merged person whose spellings best match the requested name.
    const person = people.find((p) => samePerson(p.name, name) || p.variants.some((v) => samePerson(v, name))) ?? people[0]
    if (!person) return NextResponse.json({ person: null, appearances: [] })

    // Page the appearances: PostgREST caps one response at 1,000 rows, and a
    // long-running host can exceed that (MAX_APPEARANCE_ROWS bounds a runaway).
    const loadAppearances = async () => {
      const rows: Record<string, any>[] = []
      for (let from = 0; from < MAX_APPEARANCE_ROWS; from += PAGE) {
        const { data, error } = await supabase
          .rpc('person_appearances', { p_station_id: stationId, p_folded: person.spellings })
          .range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        rows.push(...((data ?? []) as Record<string, any>[]))
        if (!data || data.length < PAGE) return { rows, truncated: false }
      }
      return { rows, truncated: true }
    }
    const [{ rows: apps, truncated }, catalog] = await Promise.all([loadAppearances(), loadShowCatalog(supabase, stationId)])

    // One row per episode: an episode can list the person as host AND guest.
    const byEpisode = new Map<number, Record<string, unknown>>()
    for (const a of apps) {
      const id = Number(a.episode_id)
      const prev = byEpisode.get(id)
      if (prev) {
        ;(prev.roles as string[]).push(a.role)
        continue
      }
      byEpisode.set(id, {
        episodeId: id,
        roles: [a.role],
        spelledAs: a.name,
        airDate: a.air_date,
        airStart: a.air_start,
        showKey: a.show_key,
        showName: catalogName(catalog, a.show_key, a.show_name),
        headline: a.headline,
        issueCategory: a.issue_category,
        status: a.status,
      })
    }
    const appearances = Array.from(byEpisode.values()).sort(
      (a, b) => String(b.airDate ?? '').localeCompare(String(a.airDate ?? '')) || String(b.airStart ?? '').localeCompare(String(a.airStart ?? ''))
    )
    return NextResponse.json({ person, appearances, truncated, others: people.filter((p) => p !== person).slice(0, 8) })
  } catch (err) {
    console.error('GET /api/people failed:', err)
    return NextResponse.json({ error: 'Failed to search people' }, { status: 500 })
  }
}
