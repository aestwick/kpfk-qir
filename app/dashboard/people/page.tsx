'use client'

// People — "who was on, when, and on which shows?" Type a name (misspellings
// are fine: "Greg Palace" finds Greg Palast) → matching hosts/guests with their
// spelling variants merged → one person's appearances, newest first, plus a
// link to everywhere they're mentioned in transcripts.
//   /dashboard/people?q=palast          search
//   /dashboard/people?name=Greg%20Palast one person

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useApiJson, ErrorPanel, FindSwitcher, RowsSkeleton, StatusBadge, CARD, INPUT, BUTTON } from '@/app/components/browse-ui'
import { formatAirDate, formatAirTime, episodeMomentHref, personHref, broadcastDayHref, timeToMinutes } from '@/lib/broadcast-format'
import { locationFrom } from '@/lib/nav'
import type { Person } from '@/lib/people'

interface ListResponse {
  people: Person[]
}
interface DetailResponse {
  person: Person | null
  others: Person[]
  appearances: {
    episodeId: number
    roles: string[]
    spelledAs: string
    airDate: string | null
    airStart: string | null
    showKey: string
    showName: string
    headline: string | null
    issueCategory: string | null
    status: string
  }[]
}

function span(p: Person) {
  if (!p.firstDate) return ''
  return p.firstDate === p.lastDate ? formatAirDate(p.firstDate, { weekday: false }) : `${formatAirDate(p.firstDate, { weekday: false })} – ${formatAirDate(p.lastDate, { weekday: false })}`
}

function roleText(p: Person) {
  const parts = []
  if (p.asGuest) parts.push(`guest ${p.asGuest}×`)
  if (p.asHost) parts.push(`host ${p.asHost}×`)
  return parts.join(', ')
}

export default function PeoplePage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const q = searchParams.get('q') ?? ''
  const name = searchParams.get('name') ?? ''

  const [draft, setDraft] = useState(name || q)
  useEffect(() => setDraft(name || q), [name, q])
  const debounce = useRef<ReturnType<typeof setTimeout>>()
  function search(v: string, now = false) {
    setDraft(v)
    clearTimeout(debounce.current)
    const go = () => router.replace(v.trim() ? `${pathname}?q=${encodeURIComponent(v.trim())}` : pathname, { scroll: false })
    if (now) go()
    else debounce.current = setTimeout(go, 400)
  }

  const list = useApiJson<ListResponse>(!name && q.trim().length >= 2 ? `/api/people?q=${encodeURIComponent(q)}` : null)
  const detail = useApiJson<DetailResponse>(name ? `/api/people?name=${encodeURIComponent(name)}` : null)
  const here = locationFrom(pathname, searchParams.toString())

  return (
    <div className="space-y-4 max-w-4xl">
      <FindSwitcher active="/dashboard/people" />
      <div>
        <h2 className="text-2xl font-bold">Who was on</h2>
        <p className="text-sm text-warm-500 dark:text-warm-400">
          Hosts and guests from every episode. Spelling doesn&apos;t have to be exact.
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          search(draft, true)
        }}
      >
        <input
          type="search"
          autoFocus
          aria-label="Name"
          placeholder="e.g. Greg Palast, Gerald Horne, Sonali"
          value={draft}
          onChange={(e) => search(e.target.value)}
          className={`${INPUT} w-full`}
        />
        <button type="submit" className={`${BUTTON} shrink-0`}>
          Find
        </button>
      </form>

      {name ? (
        detail.error ? (
          <ErrorPanel message={detail.error} onRetry={detail.reload} />
        ) : detail.loading && !detail.data ? (
          <div className={CARD}>
            <RowsSkeleton />
          </div>
        ) : detail.data && !detail.data.person ? (
          <div className={`${CARD} px-4 py-10 text-center text-sm text-warm-500 dark:text-warm-400`}>
            Nobody called “{name}” is listed as a host or guest.{' '}
            <Link href={`/dashboard/search?q=${encodeURIComponent(`"${name}"`)}`} className="underline">
              Search transcripts for the name
            </Link>
            .
          </div>
        ) : detail.data?.person ? (
          <>
            <section className={`${CARD} p-4 space-y-1`}>
              <h3 className="text-xl font-semibold">{detail.data.person.name}</h3>
              <p className="text-sm text-warm-600 dark:text-warm-300">
                {detail.data.appearances.length} episode{detail.data.appearances.length === 1 ? '' : 's'} · {roleText(detail.data.person)} · {span(detail.data.person)}
              </p>
              {detail.data.person.variants.length > 0 && (
                <p className="text-xs text-warm-500 dark:text-warm-400">Also spelled: {detail.data.person.variants.join(', ')}</p>
              )}
              <p className="text-sm pt-1">
                <Link href={`/dashboard/search?q=${encodeURIComponent(detail.data.person.name)}`} className="text-blue-700 dark:text-blue-400 hover:underline">
                  Where they&apos;re mentioned in transcripts →
                </Link>
              </p>
            </section>
            <section className={CARD}>
              <ul className="divide-y divide-warm-100 dark:divide-warm-700">
                {detail.data.appearances.map((a) => {
                  const hour = timeToMinutes(a.airStart)
                  return (
                    <li key={a.episodeId} className="px-4 py-2.5 sm:flex sm:gap-4">
                      <div className="sm:w-40 shrink-0 text-sm">
                        {a.airDate ? (
                          <Link href={broadcastDayHref(a.airDate, hour != null ? Math.floor(hour / 60) : null)} className="hover:underline">
                            {formatAirDate(a.airDate)}
                          </Link>
                        ) : (
                          '—'
                        )}
                        <div className="text-xs text-warm-400 dark:text-warm-500">{formatAirTime(a.airStart)}</div>
                      </div>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-x-2 text-sm">
                          <Link href={episodeMomentHref(a.episodeId, null, here)} className="font-medium text-blue-700 dark:text-blue-400 hover:underline">
                            {a.showName}
                          </Link>
                          <span className="text-xs text-warm-500 dark:text-warm-400">{a.roles.join(' & ')}</span>
                          {a.spelledAs !== detail.data!.person!.name && <span className="text-xs text-warm-400">(listed as “{a.spelledAs}”)</span>}
                          {a.status !== 'compliance_checked' && a.status !== 'summarized' && <StatusBadge status={a.status} />}
                        </div>
                        {a.headline && <p className="text-sm text-warm-700 dark:text-warm-300">{a.headline}</p>}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
            {detail.data.others.length > 0 && (
              <p className="text-xs text-warm-500 dark:text-warm-400">
                Not who you meant?{' '}
                {detail.data.others.map((o, i) => (
                  <span key={o.name}>
                    {i > 0 && ' · '}
                    <Link href={personHref(o.name)} className="underline">
                      {o.name}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </>
        ) : null
      ) : list.error ? (
        <ErrorPanel message={list.error} onRetry={list.reload} />
      ) : q.trim().length < 2 ? (
        <div className={`${CARD} px-4 py-10 text-center text-sm text-warm-500 dark:text-warm-400`}>Type a name to see when they were on and on which shows.</div>
      ) : list.loading && !list.data ? (
        <div className={CARD}>
          <RowsSkeleton />
        </div>
      ) : list.data && list.data.people.length === 0 ? (
        <div className={`${CARD} px-4 py-10 text-center text-sm text-warm-500 dark:text-warm-400`}>
          No host or guest matches “{q}”.{' '}
          <Link href={`/dashboard/search?q=${encodeURIComponent(q)}`} className="underline">
            Search transcripts instead
          </Link>
          .
        </div>
      ) : (
        <section className={CARD}>
          <ul className="divide-y divide-warm-100 dark:divide-warm-700">
            {list.data?.people.map((p) => (
              <li key={p.name}>
                <Link href={personHref(p.name)} className="block px-4 py-2.5 hover:bg-warm-50 dark:hover:bg-warm-700/50">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-blue-700 dark:text-blue-400">{p.name}</span>
                    <span className="text-xs text-warm-500 dark:text-warm-400">
                      {p.appearances} episode{p.appearances === 1 ? '' : 's'} · {roleText(p)} · {span(p)}
                    </span>
                  </div>
                  <div className="text-xs text-warm-500 dark:text-warm-400 truncate">
                    {p.shows.slice(0, 4).join(' · ')}
                    {p.variants.length > 0 && <> · also spelled {p.variants.slice(0, 3).join(', ')}</>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
