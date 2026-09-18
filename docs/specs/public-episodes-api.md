# Public episode feed — `GET /api/v1/episodes`

The contract for an external consumer syncing KPFK's published episodes. Hand
this document to the consumer along with their key.

Base URL: `https://qir.kpfk.org`

## Auth

Bearer token in the `Authorization` header. One key per consumer, so any single
key can be revoked without touching the others.

```
Authorization: Bearer qir_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are minted by a station admin at **Dashboard → API Keys**. The raw secret
is displayed exactly once at creation; only its SHA-256 hash is stored, so a
lost key is replaced, not recovered. Keys are **station-scoped** and carry
**scopes** — this endpoint needs `episodes`; captions additionally need
`transcripts`, which is opt-in and not granted by default.

The key is never accepted in the query string. Query strings end up in access
logs, browser history and referrer headers; headers do not.

| Response | Meaning |
| --- | --- |
| `401` | Missing, unknown or revoked key |
| `403` | Key is valid but lacks the required scope |
| `429` | Rate limit exceeded — see below |

## Rate limiting

Per key, sliding 60-second window. The default is generous; the limit is
per-key and adjustable. Every response carries:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 57
X-RateLimit-Reset: 42          # seconds until a slot frees up
```

A `429` also carries `Retry-After`. Honour it — a runaway polling loop should
be a throttled nuisance, not an outage.

## The contract

Only **published** episodes are reachable: an episode appears once the pipeline
has produced its summary (`status` of `summarized` or `compliance_checked`).
Everything earlier or failed — `pending`, `transcribing`, `transcribed`,
`summarizing`, `failed`, `unavailable`, `dead`, `transcript_missing` — is
internal pipeline state and is not served here at all. Asking for one is a
`400`, not an empty list, so a consumer finds out immediately rather than
concluding the catalog is empty.

Fields are an explicit allowlist. Adding a column to the database does not
widen this response.

| Field | Notes |
| --- | --- |
| `public_id` | **The stable identifier.** Opaque UUID, assigned once, never changes. Key your records on this. |
| `id` | Legacy integer row id. Still returned and still accepted in paths; prefer `public_id`. |
| `show_key` | The Confessor show key — the same key the archive uses. |
| `show_name`, `category` | Program name and program category (e.g. `Music`, `Español`). |
| `issue_category` | The FCC issue this airing was filed under. |
| `title`, `headline`, `summary` | Episode title, one-line headline, and the summary. |
| `host`, `guest` | Resolved host/guest (human-entered wins over AI unless overridden). |
| `air_date`, `air_start`, `air_end` | Broadcast date and window, station-local. |
| `date`, `start_time`, `end_time`, `duration` | Legacy scheduling fields; `duration` is seconds. |
| `status` | One of `summarized`, `compliance_checked`. |
| `mp3_url` | Archive audio location. |
| `created_at`, `updated_at` | ISO 8601. `updated_at` drives incremental sync. |

## Parameters

| Parameter | Meaning |
| --- | --- |
| `updated_since` | ISO 8601. Only episodes changed at or after this instant. |
| `cursor` | Opaque token from the previous page's `next_cursor`. Pass it back verbatim. |
| `limit` | Page size, default 50, max 200. |
| `show_key` | One Confessor show key, or a comma-separated list. |
| `category` | FCC issue category. |
| `air_date_from`, `air_date_to` | Inclusive `YYYY-MM-DD` bounds on `air_date`. |
| `status` | Narrow within the published set. Anything else is a `400`. |

Unrecognised parameters are ignored — every supported filter narrows the
result set, so an unknown one can never widen it. A *recognised* parameter that
is malformed is a `400` rather than a silent no-op: a typo'd `updated_since`
should surface on request one, not by quietly refetching the catalog forever.

## Envelope

```json
{
  "data": [ { "public_id": "…", "show_key": "sojourner", "…": "…" } ],
  "next_cursor": "WyIyMDI2LTA1LTA1VDEyOjAwOjAwWiIsNzdd",
  "has_more": true,
  "count": 50,
  "limit": 50
}
```

An object, not a bare array, so metadata can be added later without breaking a
parser. `next_cursor` is `null` exactly when the consumer has caught up.

## Sync pattern

**Backfill** — walk the whole catalog once:

```
GET /api/v1/episodes?limit=200
GET /api/v1/episodes?limit=200&cursor=<next_cursor>
…until next_cursor is null
```

**Incremental** — from then on, ask only for changes. Keep the highest
`updated_at` you have seen (or the last cursor you held) and resume from it:

```
GET /api/v1/episodes?updated_since=2026-09-18T04:00:00Z&limit=200
…follow next_cursor until null
```

Pagination is **keyset** on `(updated_at, id)` ascending, not offset. That
matters: workers write to these rows continuously, and under offset pagination
a row updated mid-walk shifts every later page, so rows get skipped or
repeated. Keyset pagination is stable under concurrent writes.

Re-syncs are idempotent because `public_id` never changes — upsert on it rather
than inserting, and replaying a window produces no duplicates.

## Caching

Responses carry a strong `ETag`. Sending `If-None-Match` on a repeat poll gets
a `304` with no body, which costs the consumer almost nothing and costs us a
Redis lookup. `Cache-Control` is `private` — these responses are key-scoped and
must not be shared by an intermediary.

## Related endpoints

| Endpoint | Scope | Purpose |
| --- | --- | --- |
| `GET /api/v1/episodes/{public_id}` | `episodes` | One episode. `?include=transcript` embeds captions when the key also holds `transcripts`. |
| `GET /api/v1/episodes/{public_id}/transcript` | `transcripts` | Captions. `?format=vtt` returns raw WebVTT for a `<track>`; `?lang=en` prefers the English translation. |
| `GET /api/v1/shows` | `shows` | The program list, with the same `show_key` values used by the feed. |
| `GET /api/v1/qir` | `qir` | Finalized quarterly reports. |

## Not built yet

A webhook firing on publish, so new episodes arrive without waiting for the
next poll. The pull feed above stays the source of truth for backfill and
reconciliation either way — the webhook is a latency optimisation to add when
polling latency starts to annoy someone, not a replacement for it.

## Retired: offset pagination

An earlier revision of this route served `{ episodes, total, page, limit }` with
offset pagination whenever a request carried `page`, `sort`, `order` or `since`.

That is gone. Those four parameters now return a `400` pointing at the cursor
contract, and `since` is no longer an alias for `updated_since`.

Offset pagination over this table **skips and repeats rows**: our workers
rewrite `updated_at` continuously as episodes move through the pipeline, so a
row updated mid-walk shifts every later page. No consumer was on it, so rather
than keep a broken mode alive it was removed outright. Use `cursor` and
`updated_since`, as above.
