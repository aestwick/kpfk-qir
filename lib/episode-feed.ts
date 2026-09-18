// ===========================================================================
// Episode feed — the pure request/response logic behind GET /api/v1/episodes.
//
// This module holds everything that can be reasoned about without a database or
// a Redis connection: which episodes count as "published", how the published
// contract's query parameters are parsed and validated, how the keyset cursor is
// encoded/decoded, and how the response envelope is shaped. The route file
// (app/api/v1/episodes/route.ts) is left as a thin Supabase query built from
// what this returns, so the interesting parts stay unit-testable.
//
// Two pagination modes coexist on the one route:
//
//   cursor (default) — keyset pagination on (updated_at, id) ascending, which
//     is what an incremental syncer wants: pull once with ?updated_since, then
//     follow next_cursor until it comes back null. Stable under concurrent
//     writes; offset pagination is not (a row updated mid-walk shifts every
//     later page and rows get skipped or repeated).
//
//   legacy — the original offset/page shape, kept verbatim for anything already
//     polling this route. Engaged only when a request carries one of the legacy
//     parameters (page/sort/order/since); new consumers never send those, so
//     they get cursor mode without asking.
// ===========================================================================

/**
 * The published contract. An episode is "published" once the pipeline has
 * produced its summary — before that the row exists but its summary, guest and
 * issue_category are null or half-written, which is not something an external
 * consumer should ever see. `compliance_checked` is the same state one stage
 * later (a summarized episode that has been through the FCC wordlist pass).
 *
 * Everything else (pending/transcribing/transcribed/summarizing/failed/
 * unavailable/dead/transcript_missing) is internal pipeline state and is not
 * reachable through this endpoint at all.
 */
export const PUBLISHED_STATUSES = ['summarized', 'compliance_checked'] as const
export type PublishedStatus = (typeof PUBLISHED_STATUSES)[number]

/** Columns exposed by the published contract. Anything not listed is internal. */
export const FEED_SELECT = [
  'public_id',
  'id',
  'show_key',
  'show_name',
  'category',
  'issue_category',
  'title',
  'headline',
  'host',
  'guest',
  'summary',
  'air_date',
  'air_start',
  'air_end',
  'date',
  'start_time',
  'end_time',
  'duration',
  'status',
  'mp3_url',
  'created_at',
  'updated_at',
].join(', ')

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

/** Legacy query params. Their presence is what selects the old offset shape. */
const LEGACY_PARAMS = ['page', 'sort', 'order', 'since'] as const

export interface FeedCursor {
  /** updated_at of the last row on the previous page. */
  updated_at: string
  /** id of that same row — the tiebreaker for rows sharing a timestamp. */
  id: number
}

export interface FeedFilters {
  /** Inclusive lower bound on updated_at (ISO 8601). */
  updatedSince?: string
  /** One or more Confessor show keys. */
  showKeys?: string[]
  /** FCC issue category (issue_category). */
  category?: string
  /** Inclusive air_date bounds, YYYY-MM-DD. */
  airDateFrom?: string
  airDateTo?: string
  /** Narrow within the published set; defaults to all of PUBLISHED_STATUSES. */
  statuses: PublishedStatus[]
}

export interface CursorRequest {
  mode: 'cursor'
  limit: number
  cursor: FeedCursor | null
  filters: FeedFilters
}

export interface LegacyRequest {
  mode: 'legacy'
  limit: number
  page: number
  offset: number
  sort: string
  order: 'asc' | 'desc'
  filters: FeedFilters
}

export type FeedRequest = CursorRequest | LegacyRequest

export interface FeedRequestError {
  error: string
}

export type ParseResult = { request: FeedRequest; error?: undefined } | { request?: undefined; error: FeedRequestError }

// --- cursor codec ----------------------------------------------------------

/**
 * Encode a keyset position as an opaque base64url token. Opaque by intent: the
 * contents are ours to change (a future sort key, a version tag) without the
 * consumer having built anything on top of the shape.
 */
export function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify([cursor.updated_at, cursor.id]), 'utf8').toString('base64url')
}

/** Decode a cursor token. Returns null for anything malformed — never throws. */
export function decodeCursor(token: string): FeedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [updatedAt, id] = parsed
    if (typeof updatedAt !== 'string' || !isIsoTimestamp(updatedAt)) return null
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return null
    return { updated_at: updatedAt, id }
  } catch {
    return null
  }
}

// --- validation helpers ----------------------------------------------------

function isIsoTimestamp(value: string): boolean {
  return !isNaN(Date.parse(value))
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isPublishedStatus(value: string): value is PublishedStatus {
  return (PUBLISHED_STATUSES as readonly string[]).includes(value)
}

// --- request parsing -------------------------------------------------------

/**
 * Parse and validate the query string into a FeedRequest, or return the 400 the
 * route should send back. Unknown parameters are ignored (they can't widen the
 * result set — every filter here narrows), but a parameter that IS recognised
 * and malformed fails loudly rather than being silently dropped: a syncer that
 * typo'd its ?updated_since should find out on request one, not by quietly
 * refetching the whole catalog forever.
 */
export function parseFeedRequest(sp: URLSearchParams): ParseResult {
  // --- shared filters ---
  const statusParam = sp.get('status')
  let statuses: PublishedStatus[] = [...PUBLISHED_STATUSES]
  if (statusParam) {
    const requested = splitList(statusParam)
    const invalid = requested.filter((s) => !isPublishedStatus(s))
    if (invalid.length) {
      return {
        error: {
          error:
            `Unsupported status ${JSON.stringify(invalid)}. This endpoint serves published episodes only; ` +
            `valid values are ${PUBLISHED_STATUSES.join(', ')}.`,
        },
      }
    }
    statuses = requested.filter(isPublishedStatus)
  }

  const updatedSince = sp.get('updated_since') ?? sp.get('since') ?? undefined
  if (updatedSince && !isIsoTimestamp(updatedSince)) {
    return { error: { error: `Invalid updated_since '${updatedSince}' — expected an ISO 8601 timestamp.` } }
  }

  const airDateFrom = sp.get('air_date_from') ?? undefined
  const airDateTo = sp.get('air_date_to') ?? undefined
  for (const [name, value] of [
    ['air_date_from', airDateFrom],
    ['air_date_to', airDateTo],
  ] as const) {
    if (value && !DATE_RE.test(value)) {
      return { error: { error: `Invalid ${name} '${value}' — expected YYYY-MM-DD.` } }
    }
  }

  const showKeysParam = sp.get('show_key')
  const showKeys = showKeysParam ? splitList(showKeysParam) : undefined
  if (showKeys && showKeys.length === 0) {
    return { error: { error: "Invalid show_key — expected one key or a comma-separated list." } }
  }

  const filters: FeedFilters = {
    updatedSince,
    showKeys,
    category: sp.get('category') ?? undefined,
    airDateFrom,
    airDateTo,
    statuses,
  }

  const limitParam = sp.get('limit')
  if (limitParam !== null && !/^\d+$/.test(limitParam)) {
    return { error: { error: `Invalid limit '${limitParam}' — expected a positive integer.` } }
  }
  // limitParam is digits-only by the check above, so `?limit=0` means 0 (floored
  // to 1) rather than falling through to the default.
  const limit = limitParam === null ? DEFAULT_LIMIT : Math.min(Math.max(parseInt(limitParam, 10), 1), MAX_LIMIT)

  // --- legacy offset mode, engaged only by a legacy parameter ---
  if (LEGACY_PARAMS.some((p) => sp.get(p) !== null)) {
    const page = Math.max(1, parseInt(sp.get('page') ?? '1') || 1)
    const sort = sp.get('sort') ?? 'updated_at'
    const order = sp.get('order') === 'asc' ? 'asc' : 'desc'
    return { request: { mode: 'legacy', limit, page, offset: (page - 1) * limit, sort, order, filters } }
  }

  // --- cursor mode (the default) ---
  const cursorParam = sp.get('cursor')
  let cursor: FeedCursor | null = null
  if (cursorParam) {
    cursor = decodeCursor(cursorParam)
    if (!cursor) return { error: { error: 'Invalid cursor — pass back the next_cursor from the previous page verbatim.' } }
  }

  return { request: { mode: 'cursor', limit, cursor, filters } }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// --- keyset predicate ------------------------------------------------------

/**
 * The PostgREST `or=` filter expressing `(updated_at, id) > (cursor)` — the
 * row-value comparison PostgREST can't express directly. Written as
 * `updated_at > T OR (updated_at = T AND id > N)` so rows sharing a timestamp
 * (a batch the worker committed together) are walked in id order without
 * dropping any.
 */
export function keysetFilter(cursor: FeedCursor): string {
  return `updated_at.gt.${cursor.updated_at},and(updated_at.eq.${cursor.updated_at},id.gt.${cursor.id})`
}

// --- response envelope -----------------------------------------------------

export interface FeedRow {
  id: number
  public_id: string
  updated_at: string
  [key: string]: unknown
}

export interface CursorEnvelope {
  data: unknown[]
  next_cursor: string | null
  has_more: boolean
  count: number
  limit: number
}

/**
 * Build the cursor-mode envelope from `limit + 1` rows fetched by the route.
 * The extra row is how we know whether there is more without a second COUNT
 * query: if it came back, drop it and hand out a cursor.
 *
 * next_cursor is null exactly when the consumer has caught up. That's the
 * signal to stop for this pass — and on the next pass they send back the last
 * cursor they held (or ?updated_since with the last updated_at they saw) rather
 * than starting over.
 */
export function buildCursorEnvelope(rows: FeedRow[], limit: number): CursorEnvelope {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  return {
    data: page,
    next_cursor: hasMore && last ? encodeCursor({ updated_at: last.updated_at, id: last.id }) : null,
    has_more: hasMore,
    count: page.length,
    limit,
  }
}

/**
 * Build the legacy offset envelope. Carries the original keys verbatim plus
 * `data` as an alias, so an existing poller keeps working while anything new
 * can read the same field name in both modes.
 */
export function buildLegacyEnvelope(rows: unknown[], total: number, page: number, limit: number) {
  return { data: rows, episodes: rows, total, page, limit }
}

// --- identifier resolution -------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve the `{id}` path segment on the per-episode routes. The canonical
 * public identifier is the opaque `public_id` uuid; the legacy integer row id
 * is still accepted so links already in the wild keep resolving.
 */
export function resolveEpisodeRef(raw: string): { column: 'public_id' | 'id'; value: string | number } | null {
  if (UUID_RE.test(raw)) return { column: 'public_id', value: raw }
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10)
    if (Number.isSafeInteger(n)) return { column: 'id', value: n }
  }
  return null
}
