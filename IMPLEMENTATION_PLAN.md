# QIR v2 Implementation Plan

**Source spec:** `ideas/QIR_APP_PAGES_v2.md`
**Baseline:** Current codebase as of 2026-03-08

---

## Gap Analysis: What Exists vs. What the Spec Requires

### Already Implemented (minor tweaks only)
- Dashboard Overview (`/dashboard`) — 90% complete, has all 10 sections
- Episodes List (`/dashboard/episodes`) — 80% complete, has filters/sort/pagination
- Episode Detail (`/dashboard/episodes/[id]`) — 75% complete, has audio player/transcript/summary
- Jobs (`/dashboard/jobs`) — 50% complete, basic queue cards exist
- Activity (`/dashboard/activity`) — 60% complete, basic timeline exists
- Usage (`/dashboard/usage`) — 70% complete, has date range + summary
- Generate QIR (`/dashboard/generate`) — 80% complete, has draft history/curated view
- Downloads (`/dashboard/downloads`) — 85% complete
- Settings (`/dashboard/settings`) — 75% complete, has tabs for pipeline/corrections
- Login (`/login`) — complete
- Public QIR (`/[year]/q[quarter]`) — complete
- Layout/Sidebar — complete, missing Compliance nav item
- API routes — all exist, need some extensions
- Database — 5 migrations, compliance tables exist
- Workers — all 6 workers exist
- Tailwind theme — KPFK colors configured

### Not Implemented (new work)
- **Compliance page** (`/dashboard/compliance`) — entirely new
- Dashboard: Broadcast log day-grouping ("TODAY", "YESTERDAY"), duration/cost right column
- Dashboard: Episode Quality Flags in Attention Needed
- Dashboard: Coverage gaps clickable pills → episodes, collapsible toggle
- Dashboard: Category bars clickable → episodes filtered by category
- Dashboard: "Next ingest in X min" countdown
- Episodes: Inline category editing (click cell → dropdown → auto-save)
- Episodes: Keyboard shortcuts (j/k/Enter/`/`/Escape/r)
- Episode Detail: `?seek=N` URL param support for audio/transcript
- Episode Detail: Compliance flags section with "Jump to" audio seek
- Episode Detail: Transcript text-selection → "Add correction" floating toolbar
- Episode Detail: "Not a real word — add correction" on compliance flags
- Episode Detail: Host/Guest inline editing in metadata grid
- Jobs: Pipeline mode toggle, cron schedule reference, failed jobs detail
- Settings: Shows tab (CRUD for `show_keys`)
- Settings: Bulk import CSV for corrections
- Various: Confirm dialog usage (currently uses browser `confirm()`)
- Various: Breadcrumb navigation on subpages

---

## Implementation Phases

### Phase 1: Database & API Foundation

All migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ ... END $$` blocks, `CREATE INDEX IF NOT EXISTS`).

#### Migration 006: Episode Quality Flags + Show Defaults

```sql
-- Add default_category to show_keys (if not exists)
-- Add episode_title to episode_log (if not exists, may already be there from 005)
-- Create index for quality flag detection queries
```

**File:** `supabase/migrations/006_show_defaults_quality.sql`

Changes:
- `ALTER TABLE show_keys ADD COLUMN IF NOT EXISTS default_category TEXT`
- `CREATE INDEX IF NOT EXISTS idx_episode_log_show_key ON episode_log(show_key)`
- `CREATE INDEX IF NOT EXISTS idx_episode_log_air_date_status ON episode_log(air_date, status)`
- `CREATE INDEX IF NOT EXISTS idx_compliance_flags_resolved ON compliance_flags(resolved) WHERE resolved = false`

#### API Extensions (parallel-optimized)

**`app/api/dashboard/route.ts`** — Extend the existing `Promise.all` block:
- Add quality flags query (episodes with transcript < 500 chars but duration > 30 min)
- Add "last filed QIR" query for the footer link
- Add `last_completed_job` timestamp per queue type
- All new queries run inside the existing `Promise.all` — zero additional round-trips

**`app/api/compliance/route.ts`** — Extend existing:
- Add `GET` support for paginated flag listing with filters (type, severity, resolution, quarter, show)
- Add bulk resolve `PATCH` (array of flag IDs + shared notes)
- Use single batched query with filters, not N+1

**`app/api/episodes/[id]/route.ts`** — Extend existing:
- Return compliance flags for the episode in the `GET` response (joined query, not separate fetch)
- Support `host` and `guest` fields in `PATCH`

**`app/api/settings/route.ts`** — Extend existing:
- Support `show_keys` CRUD operations (GET all shows, PATCH show, toggle active)

**`app/api/corrections/route.ts`** — Extend existing:
- Support `scope` parameter (episode-specific vs global)
- Support bulk CSV import via POST with `content-type: text/csv`

---

### Phase 2: Compliance Page (New)

**Priority: High** — This is the only entirely new page.

#### Files to create:
- `app/dashboard/compliance/page.tsx`

#### Files to modify:
- `app/dashboard/layout.tsx` — Add "Compliance" nav item (position 3, between Episodes and Jobs)

#### Compliance Page Sections:

1. **Summary Stats Strip** — Compact horizontal bar with unresolved counts by type/severity
2. **Filters** — Type, severity, resolution status, quarter, show name (all URL-persisted)
3. **Flags Table** — Sortable, selectable rows with episode link, type badge, severity, excerpt, timestamp (clickable → episode detail with `?seek=N`), resolve action
4. **Single Resolve Flow** — Inline form below row (resolved_by auto-filled, notes textarea)
5. **Bulk Resolve** — Checkbox selection → shared notes → batch PATCH
6. **Compliance Rules (tabbed)**:
   - Profanity Word List — CRUD table
   - AI Compliance Prompt — Textarea with explicit Save, "Reset to default"
   - Check Settings — Toggle per check type, blocking toggle

#### API calls (parallel):
```
// On page load, fire these in parallel:
Promise.all([
  fetch('/api/compliance?...filters'),           // flags list
  fetch('/api/compliance/wordlist'),              // profanity words
  fetch('/api/settings'),                         // compliance prompt + check toggles
])
```

---

### Phase 3: Dashboard Overview Enhancements

Incremental improvements to the existing `app/dashboard/page.tsx`.

#### 3a. Broadcast Log Enhancements
- Group entries by day ("TODAY", "YESTERDAY", date headers)
- Add right column: duration for transcriptions (from `usage_log`), cost for summarizations, episode count for ingests
- Increase to last 50 entries (currently 20)
- Smooth scroll container, max-height ~400px

#### 3b. Attention Needed Improvements
- Add "Retry" and "Mark Unavailable" inline action buttons on failed episodes
- Add Episode Quality Flags sub-section (right side): short transcripts, "no substantive discussion" summaries
- Hide entire section when both subsections empty

#### 3c. Compliance Alerts → Link to Compliance Page
- Change compliance flag links from `/dashboard/episodes?compliance_flag=X` to `/dashboard/compliance?type=X`

#### 3d. Coverage Gaps Improvements
- Make pills clickable → `/dashboard/episodes?show=X&quarter=Y`
- Add collapsible toggle
- Show count in header

#### 3e. Category Bars Clickable
- Each bar links to `/dashboard/episodes?category=X&quarter=Y`

#### 3f. On Air Strip Improvements
- Add "Next ingest in X min" countdown (calculate from cron schedule: minute :02 of every hour)

#### 3g. Cost Strip Enhancement
- Add monthly projection: `(current spend / days elapsed) × days in month`

---

### Phase 4: Episodes List Enhancements

Modify `app/dashboard/episodes/page.tsx`.

#### 4a. Inline Category Editing
- Click category cell → render `<select>` dropdown in-place
- On change → `PATCH /api/episodes/[id]` with new category
- Brief checkmark flash animation
- Click anywhere else in row → navigate to detail (event delegation with `e.target` check)

#### 4b. Keyboard Shortcuts
- `j`/`k` — navigate rows (track selected index in state, add blue ring focus style)
- `Enter` — navigate to selected episode
- `/` — focus show name search
- `Escape` — blur search, deselect
- `r` — trigger retry failed (with confirm dialog)
- Use `useEffect` with `keydown` listener, guard against input focus

#### 4c. Category Filter
- Add category dropdown to filter bar
- Persist in URL params alongside existing filters

---

### Phase 5: Episode Detail Enhancements

Modify `app/dashboard/episodes/[id]/page.tsx`.

#### 5a. `?seek=N` URL Param Support
- Read `searchParams.seek` on mount
- Pass to audio player component as initial seek position
- Scroll caption viewer and transcript to matching timestamp
- Highlight the corresponding line

#### 5b. Compliance Flags Section
- Fetch flags with episode data (single joined query from API)
- Render flag cards between summary editor and audio player
- Each card: type badge, severity color, excerpt, timestamp, "Jump to" button, "Resolve" button
- "Jump to" → seek audio, scroll captions, scroll transcript, highlight text
- "Not a real word — add correction" shortcut → pre-filled correction form
- Resolved flags hidden behind "Show N resolved" toggle

#### 5c. Host/Guest Inline Editing
- Make Host and Guest cells in metadata grid click-to-edit
- Blur/Enter → auto-save via PATCH

#### 5d. Transcript Text Selection → Add Correction
- On `mouseup` in transcript viewer, check `window.getSelection()`
- Show floating toolbar positioned near selection with "Add Transcript Correction" button
- Click opens compact inline form: pattern (pre-filled), replacement, is_regex toggle, scope radio
- Save → POST `/api/corrections`, toast with "Re-transcribe to apply?" action

#### 5e. Breadcrumb
- Add `<Breadcrumbs>` component: `Dashboard / Episodes / {show_name}`
- Back arrow "← Episodes" preserves filter state (use `sessionStorage` or URL referer)

---

### Phase 6: Jobs Page Rebuild

The current jobs page is minimal (98 lines). Rebuild to match spec.

Modify `app/dashboard/jobs/page.tsx`.

#### Changes:
- **Queue Cards (4 columns)**: Ingest, Transcribe, Summarize, Compliance — each with "Run Now" button and 2×2 count grid (active/waiting/completed/failed)
- **Pipeline Mode Toggle**: Read/write `pipeline_mode` from `qir_settings`
- **Cron Schedule Reference**: Static info section
- **Failed Jobs Detail**: Collapsible section listing failed job IDs, episode links, errors. "Clear Failed" and "Retry All Failed" buttons per queue

API calls (parallel on load):
```
Promise.all([
  fetch('/api/jobs'),       // queue counts + failed jobs
  fetch('/api/settings'),   // pipeline mode
])
```

---

### Phase 7: Activity Log Enhancements

Modify `app/dashboard/activity/page.tsx`.

#### Changes:
- Add event type filter (All / Ingested / Transcribed / Summarized / Checked / Failed)
- Add show name text search
- Day grouping with headers ("TODAY — 8 EVENTS", "YESTERDAY — 12 EVENTS")
- Right column: duration for transcriptions, cost for summarizations, count for ingests
- Persist filters in URL params
- Clickable rows → episode detail

---

### Phase 8: Settings Enhancements

Modify `app/dashboard/settings/page.tsx`.

#### 8a. Shows Tab (New)
- CRUD table for `show_keys`: Key, Name, Default Category (inline dropdown), Active (toggle), Episode Count
- Search/filter
- Episode Count links to `/dashboard/episodes?show=X`
- Inline editing for Name and Default Category
- Toggle active/inactive

#### 8b. Save Behavior Standardization
- Constrained inputs (toggles, dropdowns, steppers): auto-save with inline "Saved ✓" flash
- Prompts: explicit Save button with amber dirty border, "Reset to default", non-empty validation, unsaved-changes warning (`beforeunload`)
- CRUD rows: row-level Save/Cancel

#### 8c. Bulk CSV Import for Corrections
- "Import CSV" button → file input
- Parse CSV client-side, POST batch to `/api/corrections`

---

### Phase 9: Shared Component Improvements

#### 9a. Confirm Dialog Usage
- Replace all `window.confirm()` calls with `<ConfirmDialog>` component (already exists at `app/components/confirm-dialog.tsx`)
- Audit all pages for `confirm()` usage

#### 9b. Breadcrumbs
- Already exists at `app/components/breadcrumbs.tsx`
- Add to: Episode Detail, Compliance, Activity, Usage, Generate, Downloads, Settings
- Each with contextual path

#### 9c. Clickable Status Badges
- Extract to shared `<StatusBadge>` component
- All status badges link to `/dashboard/episodes?status=X`
- Consistent styling across all pages

---

### Phase 10: Visual Polish & Responsiveness

#### 10a. Responsive Improvements
- Dashboard scoreboard: 6 → 2×3 on tablet → vertical on mobile
- Broadcast log: hide duration/cost column on mobile
- Tables: horizontal scroll on small screens
- Compliance page: responsive table layout

#### 10b. Typography & Color Consistency
- Ensure all section headings use `text-xs font-semibold text-gray-400 uppercase tracking-wide`
- Ensure all cards use `bg-white rounded-xl shadow-sm border`
- Ensure all buttons follow the primary/secondary/destructive pattern from spec
- Status badge colors consistent everywhere

#### 10c. Loading & Motion
- Ensure skeleton states on all data-driven pages
- Button spinners during async actions
- Disable other action buttons while one action is in progress

---

## Implementation Order & Dependencies

```
Phase 1 (DB + API)     ← Foundation, no UI dependencies
  ↓
Phase 2 (Compliance)   ← New page, depends on Phase 1 API extensions
Phase 3 (Dashboard)    ← Parallel with Phase 2, depends on Phase 1
Phase 4 (Episodes)     ← Parallel with Phase 2-3
Phase 5 (Episode Detail) ← After Phase 2 (compliance flags section)
  ↓
Phase 6 (Jobs)         ← Independent, can run parallel with 4-5
Phase 7 (Activity)     ← Independent, can run parallel with 4-6
Phase 8 (Settings)     ← Independent, can run parallel with 4-7
  ↓
Phase 9 (Components)   ← After all pages updated (audit pass)
Phase 10 (Polish)      ← Final pass after all features
```

**Parallelizable groups:**
- Group A: Phase 1 (must go first)
- Group B: Phases 2, 3, 4, 6, 7, 8 (all independent after Phase 1)
- Group C: Phase 5 (after Phase 2 for compliance flag integration)
- Group D: Phases 9, 10 (after all feature work)

---

## API Optimization Principles

1. **Parallel fetches on page load**: Every page that needs multiple data sources uses `Promise.all` to fire all fetches concurrently. Never chain sequential fetches unless there's a true dependency.

2. **Server-side parallel queries**: The `/api/dashboard` endpoint already runs 17 queries in a single `Promise.all`. All new data requirements are added to this same parallel block — not as additional API calls from the client.

3. **Single endpoint per page where possible**: Dashboard uses one `/api/dashboard` call. Episode detail should return the episode + compliance flags + transcript metadata in one response. Avoid N+1 patterns.

4. **Inline mutations**: Category editing, flag resolution, and toggle saves use targeted PATCH calls that return the updated record. No full-page refetch after a single-field mutation — update local state optimistically.

5. **Conditional rendering eliminates dead fetches**: Time estimates section doesn't render when nothing is pending. Attention Needed hides when empty. Coverage gaps hide when none. This isn't just UI — the server can skip expensive queries when counts are zero.

---

## Migration Idempotency Pattern

All migrations follow this pattern:

```sql
-- Migration NNN: Description
-- Idempotent: safe to re-run

-- Add columns
ALTER TABLE table_name ADD COLUMN IF NOT EXISTS col_name TYPE DEFAULT value;

-- Create tables
CREATE TABLE IF NOT EXISTS table_name (...);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_name ON table_name(col_name);

-- Insert default data (upsert)
INSERT INTO table_name (key, value)
VALUES ('key', 'value')
ON CONFLICT (key) DO NOTHING;

-- Complex conditional DDL
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'x' AND column_name = 'y') THEN
    ALTER TABLE x ADD COLUMN y TYPE;
  END IF;
END $$;
```

---

## Files Changed Summary

### New Files
| File | Purpose |
|------|---------|
| `app/dashboard/compliance/page.tsx` | Compliance page (Phase 2) |
| `supabase/migrations/006_show_defaults_quality.sql` | DB schema extensions (Phase 1) |

### Modified Files (by phase)
| File | Phases | Changes |
|------|--------|---------|
| `app/api/dashboard/route.ts` | 1, 3 | Quality flags query, last filed QIR, broadcast log enhancements |
| `app/api/compliance/route.ts` | 1, 2 | Paginated listing, bulk resolve |
| `app/api/episodes/[id]/route.ts` | 1, 5 | Return compliance flags, host/guest PATCH |
| `app/api/settings/route.ts` | 1, 8 | Show CRUD operations |
| `app/api/corrections/route.ts` | 1, 8 | Scope param, CSV import |
| `app/dashboard/layout.tsx` | 2 | Add Compliance nav item |
| `app/dashboard/page.tsx` | 3 | Broadcast log grouping, quality flags, coverage gaps, countdown |
| `app/dashboard/episodes/page.tsx` | 4 | Inline category edit, keyboard shortcuts, category filter |
| `app/dashboard/episodes/[id]/page.tsx` | 5 | ?seek=N, compliance flags, host/guest edit, transcript corrections |
| `app/dashboard/jobs/page.tsx` | 6 | Full rebuild: queue cards, pipeline mode, cron info, failed jobs |
| `app/dashboard/activity/page.tsx` | 7 | Filters, day grouping, right column data |
| `app/dashboard/settings/page.tsx` | 8 | Shows tab, save behavior, CSV import |
| `app/components/confirm-dialog.tsx` | 9 | Ensure used everywhere |
| `app/components/breadcrumbs.tsx` | 9 | Add to all subpages |
| `lib/types.ts` | 1 | Any new type definitions needed |
