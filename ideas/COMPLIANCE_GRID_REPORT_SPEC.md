# Compliance Grid Report — Spec

A visual, schedule-style report that maps FCC compliance offenses onto KPFK's
broadcast week. Borrows the grid geometry from the CMS schedule builder but
renders **read-only** offense density, not editable slots.

Status: **spec / not yet built — finalized.** All decisions below are locked.
The `compliance_report` shape (formerly the one blocking unknown) is resolved
in §6.1.

---

## 1. Goal

Today compliance offenses live in a flat, filterable list (`/dashboard/compliance`)
and a print report (`/compliance-report`). Neither answers the question staff
actually ask: *"When in the week are we getting flagged, and which shows are
the repeat offenders?"*

This report answers that two ways:

- **Weekly heatmap** — a 7-day × time-of-day grid (same shape as the on-air
  schedule) where each cell's color intensity = offense density for that
  day/time across the selected window.
- **Show × period matrix** — rows are shows, columns are sub-periods (weeks or
  months) of the selected window; each cell = that show's offense count. This is
  the month-to-month / quarter-to-quarter trend view.

Both are toggleable in one page; both share one data fetch.

---

## 2. Locked decisions

| Area | Decision |
|---|---|
| Views | Both, toggleable: weekly day×time **heatmap** + **show×period matrix** |
| Data source | QIR's own data (`episode_log.air_start` + `air_date` + `show_keys`), **not** the CMS schedule |
| Cell metric | Toggle: **total** offenses vs **avg/week** |
| Duration | Presets (1 / 4 / 12 / 24 wk) **+** custom date range |
| Comparison | Side-by-side grids **and** a delta view (Period A · Period B · Δ) |
| Offense scope | `compliance_flags` (6 types) **+** summary discrepancies from `episode_log.compliance_report`; **unresolved-only** by default, with a "include resolved" toggle |
| Placement | Interactive dashboard page `/dashboard/compliance/grid`, linked from `/dashboard/compliance` |
| Constraints | Modular — **no god file, every file < 500 LOC** |

---

## 3. Grounding facts (verified against the codebase)

### `compliance_flags` — `supabase/migrations/004_compliance.sql`
- `id`, `episode_id` (FK → `episode_log.id`), `flag_type`, `severity`,
  `excerpt`, `timestamp_seconds`, `details`, `resolved` (bool, default false),
  `resolved_by`, `resolved_notes`, `created_at`.
- **`flag_type` values (exact):** `profanity`, `station_id_missing`,
  `technical`, `payola_plugola`, `sponsor_id`, `indecency`.
- **`severity` values (exact):** `info`, `warning`, `critical`.
- **No `station_id` column.** Scope is enforced through the
  `episode_id → episode_log` join (RLS in migration 014). The grid API **must**
  filter `episode_log.station_id`, exactly like `app/api/compliance/route.ts`.

### `episode_log` — columns we read (`lib/types.ts`)
- `id`, `station_id`, `show_key`, `show_name`.
- `air_date` — `YYYY-MM-DD` (Pacific). **Day-of-week comes from this.**
- `air_start` — `HH:MM:SS` 24-hour Pacific, populated in `workers/ingest.ts`.
  **Confirmed clean at `:00` / `:30`** → maps directly onto 30-min rows.
- `air_end`, `duration`, `status`.
- `compliance_report` — `string | null`. **Resolved (see §6.1):** it is **plain
  text, not JSON** — the summarizer's `discrepancy` field
  (`workers/summarize.ts:186`), a single human-readable note about a *metadata*
  conflict, or `null`/`""` when none. Read verbatim, never parsed.

### `show_keys` — `lib/types.ts`
- `key`, `show_name`, `category`, `default_category`, `active`, `station_id`.
- Unique per `(station_id, key)`.

### API / auth conventions
- `getStationContext(request)` → `{ context: { supabase, stationId, role, … } }`
  or `{ error }`. Use `stationErrorResponse(error)` and `requireRole(context, …)`.
- `supabase` from the context is the **request-scoped RLS client** — all queries
  go through it plus an explicit `.eq('station_id', …)`.
- Client pages fetch via `authedFetch` from `lib/api-client.ts` (attaches Bearer
  token; `qir_station` cookie rides along).
- Model route: `app/api/compliance/route.ts` already does the flag→episode join
  + `?stats=true` / `?by_show=true` aggregations. **Reuse its join pattern.**

### Palette — `tailwind.config.ts` (NOT the CMS charcoal/off-white)
- Brand: `kpfk.red #C41E3A` (+ `-light`/`-dark`), `kpfk.gold #D4A843`.
- Neutrals: warm `warm.50…950`; dark-mode surfaces `surface.DEFAULT/raised/overlay/subtle`.
- **The CMS `CATEGORY_COLORS` map and `charcoal`/`off-white` classes are
  translated to this palette, not copied.**

---

## 4. What we borrow from the CMS (and what we don't)

Three CMS files were reviewed. We take **geometry and pure helpers only.**

| CMS source | Take | Leave |
|---|---|---|
| `schedule-editor.tsx` (~1,200 LOC) | `ROW_HEIGHT`, `TOTAL_ROWS=48`, `timeToRow`/`rowToTime`/`endTimeToRow`, `formatTime12`, `DAY_NAMES_SHORT`, the sticky day-header + time-gutter layout | **everything else** — drag/resize, ghost preview, modal, Confessor import, ImagePicker. This file is the example of the god file we are *not* writing. |
| `schedule/page.tsx` (~150 LOC) | The read-only render skeleton — this is the base shape of our grid page | CMS-specific links (`/on-air/...`), override "Special" badges |
| `schedule-resolver.ts` (~180 LOC) | `timeToMinutes`, `dayOfWeekForIso`, `addDays`, `weekStartFor` — clean UTC date math for walking week/quarter ranges | recurring/override resolution (we have no recurring model; each episode is one concrete airing) |

> **Geometry note.** The CMS grid is 48 rows of 30 min. Offenses are sparse, so
> the heatmap **collapses to 24 one-hour rows by default** for readability, with
> a toggle to the full 48-row half-hour view. `air_start` being clean at `:00`/
> `:30` makes both exact.

---

## 5. Data model & aggregation

### 5.1 The unit
One **airing** = one `episode_log` row with an `air_date` + `air_start`.
Its **offense count** = (unresolved `compliance_flags` for that episode) +
(0 or 1 for a `summary_discrepancy` — see §6.1), subject to the filters in §6.

### 5.2 Bucketing an airing into the heatmap
```
dayCol  = dayOfWeekForIso(air_date)        // 0=Sun … 6=Sat
rowHour = timeToRow(air_start)             // hour*2 + floor(min/30); /2 for hourly
cell[dayCol][rowHour] += offenseCount(episode)
```

### 5.3 The two cell metrics (toggle)
- **Total** — raw sum of offenses in the cell across the whole window.
- **Avg/week** — `total / weeksInWindow`, where
  `weeksInWindow = max(1, round(rangeDays / 7))`. (Presets already align: 1/4/12/24.)

### 5.4 Show × period matrix
- **Rows:** distinct `show_key` (label `show_name`), sorted by total offenses desc.
- **Columns:** sub-periods of the window — **weeks** when window ≤ 24 wk,
  **months** when longer. Column boundaries walked via `addDays`/`weekStartFor`.
- **Cell:** offense count (total or avg-per-week-in-column) for that show in that
  sub-period. Drives the trend read.

### 5.5 Comparison (Period A vs B)
- Caller supplies two windows (e.g. Q1 and Q2). The API returns both grids.
- **Side-by-side:** two heatmaps / matrices rendered adjacent.
- **Delta:** one grid where `cell = B − A`, color-coded
  (green = fewer offenses, red = more), centered at 0.

### 5.6 Color scale
Single-hue intensity ramp on `kpfk.red` (light tint → full `#C41E3A`) keyed to
cell value, bucketed (e.g. 0 / 1 / 2–3 / 4–6 / 7+). Delta view uses a diverging
green↔red scale. Empty cells use a `warm` neutral. No per-category colors (unlike
the CMS) — intensity encodes offense density, not genre.

---

## 6. Offense scope & filters

- **Default:** unresolved flags only (matches the existing compliance report).
- **Toggle:** *Include resolved* → counts resolved flags too.
- **Optional facets (multi-select, all default to "all"):**
  - by `flag_type` (the 6 types + `summary_discrepancy`)
  - by `severity` (`info` / `warning` / `critical`) — applies to
    `compliance_flags` only; `summary_discrepancy` has no severity.
- A cell click drills through to `/dashboard/compliance` pre-filtered to that
  day/time (or show) and window — reuse the existing list page's query params.

### 6.1 `summary_discrepancy` (resolved)

`episode_log.compliance_report` is **plain text, not JSON.** It holds the
summarizer's `discrepancy` output (`workers/summarize.ts:186`,
`DEFAULT_SUMMARIZATION_PROMPT` in `lib/settings.ts`) — a single note when
provided metadata (host/guest/show name) contradicts the transcript, otherwise
`null` or `""`. The dashboard renders it verbatim
(`app/dashboard/episodes/[id]/page.tsx:649`, simple truthiness check).

Therefore, per episode:

```
summaryDiscrepancyCount(ep) = (ep.compliance_report?.trim() ? 1 : 0)
```

No parsing, no schema dependency — a binary contribution to the offense count.

> **Semantic caveat (by design).** A `summary_discrepancy` is a **metadata-quality
> issue**, *not* an FCC violation like the `compliance_flags` rows. It's included
> per the product decision, but kept as its **own toggleable type** and **visually
> distinguished** (it carries no severity and is excluded when the severity facet
> is narrowed). Default view can show it; users filtering to FCC offenses only can
> deselect it. The heatmap/matrix should make clear via the type legend that these
> two sources differ in kind.

---

## 7. Placement & UX

- **Route:** `app/dashboard/compliance/grid/page.tsx` (`'use client'`,
  `authedFetch`, station from `qir_station` cookie — same as other dashboard pages).
- **Link in:** a "Grid report" tab/button on `/dashboard/compliance`.
- **Controls bar:** view toggle (Heatmap | Matrix) · metric toggle (Total |
  Avg/wk) · duration (preset chips `1w 4w 12w 24w` + custom range pickers) ·
  comparison toggle (Off | A vs B) · resolved toggle · type/severity facets.
- **Print:** the page should print cleanly (the heatmap is the filing-friendly
  artifact). A dedicated public print route is **out of scope for v1** (we chose
  the dashboard placement); revisit if staff want to attach it to FCC filings.

---

## 8. File breakdown (every file < 500 LOC)

| File | Role | Est. LOC |
|---|---|---|
| `lib/compliance-grid.ts` | Pure helpers: borrowed date/time math (`timeToRow`, `dayOfWeekForIso`, `addDays`, `weekStartFor`), `bucketEpisodes`, `aggregateCell`, `computeDelta`, `weeksInWindow`. No I/O. | ~180 |
| `app/api/compliance/grid/route.ts` | `GET`: `getStationContext` → join `compliance_flags` ↔ `episode_log` filtered by `station_id` + window(s); returns `{ heatmap, matrix, meta }` (and `{ a, b }` when comparing). Mirrors `api/compliance/route.ts`. | ~160 |
| `app/dashboard/compliance/grid/page.tsx` | Page shell: controls bar, state, `authedFetch`, view/metric/duration/comparison toggles. Delegates rendering. | ~220 |
| `app/dashboard/compliance/grid/heatmap.tsx` | The 7×24(/48) day×time grid render (borrowed geometry + intensity scale). | ~200 |
| `app/dashboard/compliance/grid/matrix.tsx` | The show×period table render + delta coloring. | ~160 |

`lib/types.ts` gains a few interfaces (`GridCell`, `HeatmapData`, `MatrixRow`,
`GridResponse`). The two render components share a tiny `intensityClass(value)`
helper (kept in `lib/compliance-grid.ts` so both views and tests can use it).

---

## 9. Open questions

*(Resolved: `compliance_report` shape — see §6.1. No longer a blocker.)*

The remaining items are UX defaults, not blockers — each has a proposed answer
the build can adopt unless overridden:

1. **Heatmap default granularity** — proposed: hourly (24 rows) default, full
   48-row half-hour view as a toggle.
2. **Matrix column unit at the boundary** — proposed: weeks up to 24 wk, months
   beyond; custom ranges auto-pick by span.
3. **Comparison window picker** — proposed: A = current preset window, B = the
   immediately preceding equal-length window (one click), with custom override.
4. **Public/print route** — deferred; stays out of v1 (dashboard placement only).

---

## 10. Build order

1. `lib/compliance-grid.ts` (pure, unit-testable) + types.
2. `app/api/compliance/grid/route.ts` — flags + `summary_discrepancy` together
   (the discrepancy contribution is a trivial truthiness check per §6.1, no
   longer a follow-up).
3. `heatmap.tsx`, then `matrix.tsx`.
4. `page.tsx` controls wiring + link from `/dashboard/compliance`.
5. Delta/comparison layer once single-window views are solid.
