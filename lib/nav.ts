/**
 * The dashboard's navigation: ONE definition, reused everywhere.
 *
 * - The sidebar (app/components/sidebar-nav.tsx) renders NAV_GROUPS.
 * - Breadcrumbs (app/components/breadcrumbs.tsx) label paths via labelForPath().
 * - Episode detail's "← back to …" link resolves its origin via resolveOrigin().
 * - The phone header shows the current page's label.
 *
 * Rename a page here and every one of those follows. Proposal and rationale:
 * docs/navigation-proposal.md.
 *
 * Visibility by role is a convenience (don't show people links they can't use),
 * never a security boundary — every page and API route enforces its own access.
 *
 * The episode detail page can be reached from several places (Episodes list, a
 * Show page, Compliance, Search …). We thread the originating location through
 * a `from` query param so its back link, breadcrumb and the highlighted menu
 * item reflect where the user actually came from.
 */

/* ─── Roles ─── */

/** Station roles (station_users.role) plus the network-wide super-admin. */
export type NavRole = 'viewer' | 'editor' | 'admin' | 'super'

const ROLE_RANK: Record<NavRole, number> = { viewer: 0, editor: 1, admin: 2, super: 3 }

/** Does `role` meet `min`? An unknown role (still loading) is treated as viewer. */
export function roleAllows(role: NavRole | null | undefined, min: NavRole): boolean {
  return ROLE_RANK[role ?? 'viewer'] >= ROLE_RANK[min]
}

/* ─── Menu definition ─── */

export type NavIcon =
  | 'home' | 'episodes' | 'shows' | 'day' | 'coverage' | 'people' | 'search' | 'checkup'
  | 'report' | 'downloads' | 'flag' | 'grid' | 'settings' | 'members' | 'key'
  | 'queue' | 'log' | 'stations' | 'cost' | 'users' | 'history'

export interface NavItem {
  id: string
  /** Where the link goes. May carry a query (e.g. a Settings tab). */
  href: string
  label: string
  icon: NavIcon
  /** Lowest role that sees this link. */
  minRole: NavRole
  /** Extra path prefixes that count as "on this page" (beyond href's path). */
  match?: string[]
  /** Path prefixes that must NOT count as this item even though they share its prefix. */
  exclude?: string[]
  /** The item a breadcrumb trail puts before this one (by id). */
  parent?: string
  /** A slot for a page another session is still building: hidden until this
   *  flag is removed (in the same PR that adds the page). */
  reserved?: boolean
  /** Acts across all stations — the station switcher doesn't apply. */
  network?: boolean
  /** A live count shown next to the label. */
  badge?: 'complianceToReview'
  /** One-line plain-English hint (tooltip). */
  hint?: string
}

export interface NavGroup {
  id: string
  /** Section heading; omitted for the top (Home) group. */
  label?: string
  /** Collapsed by default; opens automatically when you're on one of its pages. */
  collapsible?: boolean
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'top',
    items: [
      { id: 'home', href: '/dashboard', label: 'Home', icon: 'home', minRole: 'viewer', hint: 'Is everything healthy? This quarter at a glance.' },
    ],
  },
  {
    id: 'programming',
    label: 'Programming',
    items: [
      { id: 'episodes', href: '/dashboard/episodes', label: 'Episodes', icon: 'episodes', minRole: 'viewer', hint: 'Every episode we recorded, with summaries' },
      { id: 'shows', href: '/dashboard/shows', label: 'Shows', icon: 'shows', minRole: 'viewer', exclude: ['/dashboard/shows/audit'], hint: 'Our programs, and each one’s episodes' },
      // Reserved for the search session (branch claude/qir-search-views). When a
      // page ships, delete its `reserved: true` (and fix the href if the route
      // differs) — nothing else needs to change.
      { id: 'broadcast-day', href: '/dashboard/broadcast-day', label: 'Broadcast day', icon: 'day', minRole: 'viewer', reserved: true, hint: 'What aired on a given date' },
      { id: 'coverage', href: '/dashboard/coverage', label: 'Show coverage', icon: 'coverage', minRole: 'viewer', reserved: true, hint: 'What a show covered over a period' },
      { id: 'people', href: '/dashboard/people', label: 'Guests & people', icon: 'people', minRole: 'viewer', reserved: true, hint: 'Who has been on air, and when' },
      { id: 'search', href: '/dashboard/search', label: 'Search transcripts', icon: 'search', minRole: 'viewer', hint: 'Find what was said on air, and jump to the moment' },
      { id: 'show-checkup', href: '/dashboard/shows/audit', label: 'Show check-up', icon: 'checkup', minRole: 'viewer', hint: 'Check one show’s episodes are complete, then get its issues report' },
      { id: 'downloads', href: '/dashboard/downloads', label: 'Downloads', icon: 'downloads', minRole: 'viewer', hint: 'Transcripts, captions and episode spreadsheets by quarter' },
    ],
  },
  {
    id: 'fcc',
    label: 'FCC report',
    items: [
      { id: 'report', href: '/dashboard/generate', label: 'Quarterly report', icon: 'report', minRole: 'viewer', hint: 'Build, review and finalize the Quarterly Issues Report; past reports are listed there too' },
    ],
  },
  {
    id: 'compliance',
    label: 'Compliance',
    items: [
      { id: 'compliance', href: '/dashboard/compliance', label: 'Review flags', icon: 'flag', minRole: 'viewer', exclude: ['/dashboard/compliance/grid'], badge: 'complianceToReview', hint: 'Possible profanity and indecency to review' },
      { id: 'compliance-grid', href: '/dashboard/compliance/grid', label: 'Flags by time slot', icon: 'grid', minRole: 'viewer', parent: 'compliance', hint: 'When in the week flags happen' },
    ],
  },
  {
    id: 'station',
    label: 'Station settings',
    items: [
      { id: 'settings', href: '/dashboard/settings', label: 'Settings', icon: 'settings', minRole: 'editor', hint: 'Shows tracked, prompts, word list, corrections' },
      { id: 'members', href: '/dashboard/settings?tab=members', label: 'Station members', icon: 'members', minRole: 'admin', parent: 'settings', hint: 'Who can use this station, and their role' },
      { id: 'api-keys', href: '/dashboard/api-keys', label: 'API keys', icon: 'key', minRole: 'admin', hint: 'Keys for other apps that read our data' },
    ],
  },
  {
    id: 'system',
    label: 'Behind the scenes',
    collapsible: true,
    items: [
      { id: 'jobs', href: '/dashboard/jobs', label: 'Processing queue', icon: 'queue', minRole: 'editor', hint: 'Transcription and summary jobs for this station' },
      { id: 'activity', href: '/dashboard/activity', label: 'Processing log', icon: 'log', minRole: 'editor', hint: 'Which episodes moved through processing, and when' },
      { id: 'master', href: '/dashboard/master', label: 'All stations', icon: 'stations', minRole: 'super', network: true, hint: 'Every station’s processing, pause/resume, spend caps' },
      { id: 'usage', href: '/dashboard/usage', label: 'AI costs', icon: 'cost', minRole: 'super', hint: 'What transcription and AI cost, by day' },
      { id: 'users', href: '/dashboard/users', label: 'All users', icon: 'users', minRole: 'super', network: true, hint: 'Accounts and roles across every station' },
      { id: 'audit', href: '/dashboard/audit', label: 'Change history', icon: 'history', minRole: 'super', network: true, hint: 'Who changed what, and when' },
    ],
  },
]

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

export function navItemById(id: string): NavItem | undefined {
  return ALL_NAV_ITEMS.find((i) => i.id === id)
}

/**
 * The groups/items a given person should see. Reserved slots stay hidden unless
 * listed in `reservedAvailable` (used by tests / previews).
 */
export function visibleNav(
  role: NavRole | null | undefined,
  reservedAvailable: ReadonlySet<string> = new Set(),
  groups: NavGroup[] = NAV_GROUPS,
): NavGroup[] {
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => roleAllows(role, i.minRole) && (!i.reserved || reservedAvailable.has(i.id))),
    }))
    .filter((g) => g.items.length > 0)
}

/* ─── Matching a URL to a menu item ─── */

function splitHref(href: string): { path: string; query: URLSearchParams } {
  const [path, q] = href.split('?')
  return { path, query: new URLSearchParams(q ?? '') }
}

function pathMatches(path: string, prefix: string): boolean {
  if (prefix === '/dashboard') return path === '/dashboard' || path === '/dashboard/'
  return path === prefix || path.startsWith(prefix + '/')
}

/**
 * The menu item a location belongs to (longest matching prefix wins; items whose
 * href carries a query, like Settings → Members, win only when the query matches).
 * Episode detail pages belong to Episodes here — use activeNavItem() to account
 * for where the user came from.
 */
export function matchNavItem(location: string, items: NavItem[] = ALL_NAV_ITEMS): NavItem | null {
  const { path, query } = splitHref(location)
  let best: { item: NavItem; score: number } | null = null
  for (const item of items) {
    const own = splitHref(item.href)
    const prefixes = [own.path, ...(item.match ?? [])]
    if (item.exclude?.some((x) => pathMatches(path, x))) continue
    const hit = prefixes.filter((p) => pathMatches(path, p)).sort((a, b) => b.length - a.length)[0]
    if (!hit) continue
    let queryHits = 0
    let queryMiss = false
    own.query.forEach((v, k) => {
      if (query.get(k) === v) queryHits++
      else queryMiss = true
    })
    if (queryMiss) continue
    const score = hit.length * 10 + queryHits
    if (!best || score > best.score) best = { item, score }
  }
  return best?.item ?? null
}

const EPISODE_DETAIL = /^\/dashboard\/episodes\/[^/]+\/?$/

/**
 * The item to highlight in the menu. On an episode page, highlight the section
 * the user came from (its `from` hint), so opening an episode from a compliance
 * flag keeps "Compliance flags" lit rather than jumping to Episodes.
 */
export function activeNavItem(pathname: string, search?: string | null): NavItem | null {
  const query = new URLSearchParams(search ?? '')
  if (EPISODE_DETAIL.test(pathname)) {
    const from = query.get('from')
    if (from && from.startsWith('/dashboard')) {
      const origin = matchNavItem(from)
      if (origin && origin.id !== 'home') return origin
    }
  }
  return matchNavItem(search ? `${pathname}?${search}` : pathname)
}

/** Plain-language label for a path (exact or by section), or null when unknown. */
export function labelForPath(location: string): string | null {
  return matchNavItem(location)?.label ?? null
}

/* ─── Breadcrumbs ─── */

export interface Crumb { label: string; href: string }

/**
 * Breadcrumb trail for a page: Home › [parent] › section. Leaf pages under a
 * section (an episode, a show) append their own name. An `origin` replaces the
 * section crumb on episode pages so the trail follows how the user got there.
 */
export function breadcrumbTrail(
  pathname: string,
  opts: { leafLabel?: string; origin?: Crumb } = {},
): Crumb[] {
  const home = navItemById('home')!
  const crumbs: Crumb[] = [{ label: home.label, href: home.href }]
  const isEpisode = EPISODE_DETAIL.test(pathname)
  const section = isEpisode ? navItemById('episodes')! : matchNavItem(pathname)

  if (isEpisode && opts.origin) {
    if (opts.origin.href.split('?')[0] !== home.href) crumbs.push(opts.origin)
  } else if (section && section.id !== 'home') {
    const parent = section.parent ? navItemById(section.parent) : undefined
    if (parent) crumbs.push({ label: parent.label, href: parent.href })
    crumbs.push({ label: section.label, href: section.href })
  }

  const onSectionPage = section && splitHref(section.href).path === pathname
  if (opts.leafLabel && !onSectionPage) crumbs.push({ label: opts.leafLabel, href: pathname })

  return crumbs.filter((c, i) => crumbs.findIndex((o) => o.href === c.href) === i)
}

/* ─── Episode origins (`from` param) ─── */

export interface NavOrigin {
  label: string
  href: string
}

/** Default origin when we have no `from` hint (or it's unrecognized). */
const DEFAULT_ORIGIN: NavOrigin = { label: navItemById('episodes')!.label, href: '/dashboard/episodes' }

/** Current location (path + query) suitable for use as a `from` value. */
export function locationFrom(pathname: string, search?: string | null): string {
  return search ? `${pathname}?${search}` : pathname
}

/** Append a `from` hint to an episode-detail href, preserving any existing query. */
export function withFrom(href: string, from?: string | null): string {
  if (!from) return href
  const sep = href.includes('?') ? '&' : '?'
  return `${href}${sep}from=${encodeURIComponent(from)}`
}

/** Build an episode-detail href that remembers where the user came from. */
export function episodeHref(id: number | string, from?: string | null): string {
  return withFrom(`/dashboard/episodes/${id}`, from)
}

/**
 * Resolve a `from` value (path + optional query) into the `{ label, href }`
 * the back link / breadcrumb should point at. For a Show page the label is the
 * show's display name when known, since show keys aren't human-friendly.
 */
export function resolveOrigin(
  from: string | null | undefined,
  show?: { name?: string | null; key?: string | null },
): NavOrigin {
  if (!from || !from.startsWith('/dashboard')) return DEFAULT_ORIGIN
  const path = from.split('?')[0]

  // A specific show page (/dashboard/shows/<key>) — not the index, not check-up.
  if (/^\/dashboard\/shows\/[^/]+/.test(path) && !path.startsWith('/dashboard/shows/audit')) {
    return { label: show?.name || show?.key || 'Show', href: from }
  }

  const item = matchNavItem(from)
  return item ? { label: item.label, href: from } : DEFAULT_ORIGIN
}

/* ─── FCC filing deadline ─── */

export interface QuarterRef { year: number; quarter: number }

export interface FilingStatus {
  /** The quarter whose report this is about. */
  year: number
  quarter: number
  label: string
  /** Calendar date the report is due (10th of the month after the quarter). */
  due: Date
  /** 'finalized' means finalized in this app — the station still uploads it to
   *  the FCC public file itself. */
  state: 'due' | 'overdue' | 'finalized'
  /** When `state` is 'finalized': the following quarter and its due date. */
  next?: { year: number; quarter: number; label: string; due: Date }
}

/** The FCC quarterly issues/programs list is due in the public file by the
 *  10th day of the month after the quarter ends: Jan 10, Apr 10, Jul 10, Oct 10. */
export function filingDueDate(year: number, quarter: number): Date {
  // Month index quarter*3 is the month after the quarter (Q4 → 12 → next January).
  return new Date(year, quarter * 3, 10)
}

function prevQuarter({ year, quarter }: QuarterRef): QuarterRef {
  return quarter === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: quarter - 1 }
}

/**
 * Which report is due next, and whether it's done. The report that matters is
 * always the one for the quarter that just ended: until it's finalized it is
 * "due" (or "overdue" after the 10th); once finalized the status points ahead
 * to the current quarter's deadline. Older/backfill quarters are ignored.
 *
 * @param now   today's date AS A LOCAL CALENDAR DATE in the station's time zone
 *              (see stationToday()) — the deadline is the station's 10th.
 * @param finalized quarters with a FINALIZED report for the active station.
 */
export function filingStatus(now: Date, finalized: QuarterRef[]): FilingStatus {
  const current = { year: now.getFullYear(), quarter: Math.floor(now.getMonth() / 3) + 1 }
  const last = prevQuarter(current)
  const due = filingDueDate(last.year, last.quarter)
  const label = `Q${last.quarter} ${last.year}`
  const isFiled = finalized.some((f) => f.year === last.year && f.quarter === last.quarter)
  if (isFiled) {
    return {
      ...last, label, due, state: 'finalized',
      next: { ...current, label: `Q${current.quarter} ${current.year}`, due: filingDueDate(current.year, current.quarter) },
    }
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return { ...last, label, due, state: today > due ? 'overdue' : 'due' }
}

/**
 * Today's calendar date in an IANA time zone, as a local Date at midnight —
 * so date math (quarters, the 10th) follows the station, not the viewer's
 * browser. Falls back to the browser's date for an unknown zone.
 */
export function stationToday(timeZone: string | null | undefined, now: Date = new Date()): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined, year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(now)
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    return new Date(get('year'), get('month') - 1, get('day'))
  } catch {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }
}

/** Public, print-friendly page for a finalized report (what goes in the public file). */
export function publicReportHref(stationSlug: string, q: QuarterRef): string {
  return `/${stationSlug}/${q.year}/q${q.quarter}`
}

/** Link to the report builder with a quarter preselected (?quarter=YYYY-Qn). */
export function reportHref(q: QuarterRef): string {
  return `/dashboard/generate?quarter=${q.year}-Q${q.quarter}`
}

/** Parse ?quarter=YYYY-Qn (as reportHref writes it, and as Episodes/Search use). */
export function parseQuarterParam(value: string | null | undefined): QuarterRef | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(value ?? '')
  return m ? { year: Number(m[1]), quarter: Number(m[2]) } : null
}
