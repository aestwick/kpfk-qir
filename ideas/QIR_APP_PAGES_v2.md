# QIR.KPFK.ORG — Page-by-Page UX Specification

*Every page, every flow, every interaction. The complete map.*

*Reconciled from DASHBOARD_DESIGN.md, PHASE_15_DASHBOARD.md, and ARCHITECTURE.md.*

---

## Navigation Structure

**Sidebar (9 items):**

1. Overview — `/dashboard`
2. Episodes — `/dashboard/episodes`
3. Compliance — `/dashboard/compliance` *(new)*
4. Jobs — `/dashboard/jobs`
5. Activity — `/dashboard/activity`
6. Usage — `/dashboard/usage`
7. Generate QIR — `/dashboard/generate`
8. Downloads — `/dashboard/downloads`
9. Settings — `/dashboard/settings`

**Public pages (no auth):**

- `/login` — authentication
- `/[year]/q[quarter]` — published QIR report

**Global elements on every authenticated page:**

- Dark sidebar (`bg-gray-900`) with "QIR / KPFK" branding at top
- Active nav item highlighted (`bg-gray-700 text-white font-medium`)
- Hover on inactive items (`hover:bg-gray-800 hover:text-white`)
- User email + Sign Out at sidebar bottom
- Mobile: hamburger toggle, sidebar slides in from left, backdrop click or route change closes it
- Skeleton loading states (animate-pulse) on all data-driven content
- Toast notifications (bottom-right, success green / error red, auto-dismiss 5s, manually dismissible)
- Breadcrumb navigation on all subpages
- Clickable status badges everywhere — any status badge in the app links to the episodes page filtered to that status

---

## Page 1: Overview (Dashboard)

**Route:** `/dashboard`

**Purpose:** At-a-glance station operations monitor. This page will often be open on a monitor at the station. It needs to tell the whole story at a glance. A producer should be able to scan this from across the room and know if everything's OK.

**Philosophy:** Primarily read-only situational awareness. The only interactive elements are the manual trigger buttons in the On Air strip and the retry/mark-unavailable buttons in Attention Needed. Everything else is informational with clickthrough links to the appropriate detail pages.

**Polls:** `/api/dashboard` every 15 seconds for live updates. Use SWR or react-query with `refreshInterval: 15000`. New activity entries appear smoothly (fade in or slide down), not causing the whole page to jump.

### Visual Direction

This is not a Silicon Valley SaaS dashboard. This is a working tool for a community radio station — warm, functional, slightly analog in feel. Like looking at the ops board in a broadcast control room, or a well-organized producer's desk.

- White/cream background. Clean but not sterile. Slightly warm white, not blue-white.
- KPFK red (#C41E3A) for emphasis and active states. Warm amber/gold for highlights and processing indicators. Neutral warm-toned grays for secondary text and borders.
- Green for healthy/complete — muted sage, not neon. Amber for attention. Red only for actual failures — used sparingly.
- Editorial typography — like a broadcast log or newspaper layout. Clear hierarchy: large readable numbers for stats, medium weight for labels, monospace or tabular figures for timestamps and costs.
- No gratuitous animations. Purposeful motion only — gentle pulse when processing, a number ticking up when episodes arrive.
- No pie charts. No speedometers. No gauges. Data should be readable, not decorated.
- Dense but not cluttered.

### Section 1: On Air Status Strip

Full-width horizontal bar across the top of the content area. First thing your eye hits.

**When processing:**
- Left: amber dot (pulsing) + operation label in small caps ("TRANSCRIBING")
- Center: show name and date being processed ("Beneath The Surface — Mar 5, 2026")
- Right: progress bar + time estimate ("████████░░ 62% ~1m 20s remaining")
- Multiple active jobs stack vertically
- Right-aligned: manual trigger buttons (Ingest, Transcribe, Summarize, Compliance)
- "Next ingest in 23 min" countdown — so the user knows whether to wait or hit the manual button

**When idle:**
- Green dot, "All caught up — last activity 12 minutes ago"
- Manual trigger buttons still visible
- Next auto-run countdown still visible
- No urgency, no empty-state drama

**Color semantics for the dot:** Amber = actively processing. Green = idle/healthy. Red = failure/down. This is NOT an alarm — think the ON AIR light in a studio control room.

**Implementation:** Poll `/api/jobs` every 10–15 seconds. Check for active/waiting jobs. If active, show current job details. If none, show idle state with timestamp of last completed job.

### Section 2: Quarter Scoreboard

Big, readable numbers you can see from across a room.

- Quarter label: "Q1 2026" top left
- QIR status badge top right: "QIR: Not generated" / "QIR: Draft v2" / "QIR: Finalized Jan 8" — clickable, links to Generate QIR page
- 6-cell grid: Pending | Transcribed | Summarized | Checked | Failed | Unavailable
- Numbers are large (32–40px), labels are small below them
- Each cell is clickable → links to `/dashboard/episodes?status=X&quarter=2026-Q1`
- The "Failed" cell has a red tint when count > 0
- Subtle color fills behind each number: light amber for pending, light blue for transcribed, light green for summarized/checked, light red for failed, light gray for unavailable
- Progress bar below, full width: "Pipeline completion: 87% (280/322)"
- Below the progress bar, small text: "Last filed: Q4 2025 on Jan 8, 2026" with link to public QIR page

**Implementation:** `/api/dashboard` returns counts by status for the current quarter.

### Section 3: QIR Readiness + Time Estimates

These sit side-by-side when time estimates are visible. When the pipeline is clear (nothing pending), QIR Readiness goes full-width and time estimates don't render at all.

**QIR Readiness (left or full-width):**
- "8 of 8 categories covered" — color coded: green card when 5+ categories (FCC practical minimum), amber when 3–4, red when <3
- Lists missing categories as pills: "Missing: Immigration, Health"
- Based on counting distinct `issue_category` values among `summarized` + `compliance_checked` episodes in the current quarter
- When fully covered: solid green card, clean checkmark
- "View QIR Builder →" link to Generate QIR page

**Time Estimates (right, conditional):**
Only renders when there's a meaningful backlog. Hidden entirely when all stages have zero pending.

When visible:
- Per stage, only stages with remaining work:
  - "Transcription: ~45 min remaining (15 episodes × 3.0 min avg)"
  - "Summarization: ~2 min remaining (8 episodes × 14s avg)"
  - "Compliance: ~1 min remaining (8 episodes × 8s avg)"
- Overall: "Pipeline clear in ~48 min at current pace"
- Averages calculated client-side from `usage_log` over last 7 days
- SQL: `SELECT AVG(duration_seconds) FROM usage_log WHERE operation = 'transcribe' AND created_at > now() - interval '7 days'`

### Section 4: Broadcast Log

The heartbeat of the page. Formatted like an actual radio station program log — timestamps, show names, what happened. This is where the dashboard gets its editorial character.

- Left-aligned timestamps in monospace or tabular font
- Status icons: ✓ (green, complete), → (amber, in progress), ↓ (blue, ingested), ✗ (red, failed)
- Operation type as a label
- Show name + date
- **Right column varies by event type:** duration for transcriptions, cost for summarizations, episode count for ingests
- Grouped by day with subtle dividers: "TODAY", "YESTERDAY"
- Scrollable, max height ~400px, shows last 50 events
- Each row clickable → links to episode detail page
- Auto-refreshes with the dashboard poll cycle, new entries slide in at top smoothly

**Examples:**
```
 TODAY
 10:14 AM   ✓  Transcribed     Democracy Now — Mar 5, 2026          2m 34s
 10:12 AM   ✓  Summarized      Beneath The Surface — Mar 4, 2026    $0.02
 10:02 AM   ↓  Ingested        3 new episodes found
  9:47 AM   ✗  Failed          Background Briefing — Mar 3 — MP3 not found

 YESTERDAY
  6:02 PM   ✓  Summarized      The Ralph Nader Hour — Mar 3, 2026   $0.03
```

**Implementation:** Combined activity feed from `episode_log` recently updated rows, ordered by `updated_at DESC`. Duration from `usage_log` for that episode's most recent operation. Limit to last 50 entries.

### Section 5: Attention Needed

Two sub-sections side by side. **Hides entirely when both sub-sections are empty** — don't show empty states here. The absence of this section IS the signal that everything's fine.

**Failed Episodes (left):**
- Formatted like a producer's pull sheet — matter-of-fact, not alarming
- Each row: show name, date, error message (from `error_message`), retry count
- Action buttons per row: "Retry" (resets status to previous stage), "Mark Unavailable" (for 404s)
- Count badge in the section header
- Amber left border, not screaming red

**Episode Quality Flags (right):**
- Episodes with very short transcripts (<500 chars for a 30+ min show)
- Episodes where AI summary says "little or no substantive discussion"
- Episodes with discrepancies flagged by the summarizer
- Each links to the episode detail page
- These catch silent failures — episodes where the pipeline "succeeded" but produced garbage

**Implementation:** Failed episodes from `episode_log WHERE status = 'failed'`. Quality flags derived from transcript length checks and summary content analysis during the `/api/dashboard` aggregation.

### Section 6: Compliance Alerts

Separate from Attention Needed — compliance is about station operations and FCC risk, not pipeline failures.

- Count of unresolved flags by type: "3 profanity · 1 payola/plugola · 2 station ID"
- Each count clickable → links to `/dashboard/compliance?type=profanity`
- Color coded: red badge for critical, amber for warning, gray for info
- "No compliance issues" in green when empty (this section always shows, unlike Attention Needed, because "no compliance issues" is meaningful positive information)

### Section 7: Show Coverage Gaps

Which active shows have ZERO summarized episodes this quarter.

- Pill/tag cloud of show names
- Only non-Music, non-Español active shows (these categories are excluded from QIR)
- Each pill clickable → links to episodes page filtered to that show
- Section header shows count: "87 active shows with no coverage"
- Collapsible — starts expanded but can be toggled closed if the list is long
- Helps ensure QIR has variety across shows (FCC cares about this)

### Section 8: Issue Categories + Recent Episodes

Side by side at the bottom of the main content.

**Issue Categories (left):**
- Horizontal bar chart of FCC categories with episode counts
- Categories sorted by count descending
- Each bar clickable → filters episodes list by that category
- Color: KPFK red for bars
- Useful context for QIR readiness — shows distribution, not just coverage

**Recent Episodes (right):**
- Last 5–8 episodes with status badge, show name, date
- Each row clickable → episode detail
- "View all →" link to episodes page

### Section 9: Cost Strip

Single understated line, full width.

- "March 2026: $4.82 spent (Groq $2.10 · OpenAI $2.72) — avg $0.03/episode — projected $8.40 this month"
- Projection = (current spend / days elapsed in month) × days in month
- "Details →" link to Usage page
- Optional tiny sparkline (30-day daily spend, max 60px tall) — only if it adds value, not decoration
- No gauges, no speedometers

### Section 10: System Health Footer

Thin strip at the very bottom of the page. Not visually prominent — you only look here when something seems wrong.

- "Workers: running · Redis: connected · Last ingest: 12 min ago · Last transcription: 34 min ago · Last summarization: 1h ago"
- Inline text with colored dots: green (<2h), amber (2–8h), red (>8h or down)
- Small text, muted color. Footer-level visual priority.

**Implementation:** `/api/jobs` returns worker status. Staleness calculated from most recent `updated_at` in `episode_log` per operation.

### Dashboard Responsive Behavior

- Desktop/monitor: full layout as described
- Tablet: stack scoreboard numbers 2×3 instead of 6 across; QIR Readiness and Time Estimates stack vertically
- Mobile: single column stack, broadcast log hides duration/cost column, scoreboard numbers stack vertically

### User Flows from Overview

| Action | Destination |
|--------|-------------|
| Click status count cell | Episodes list, pre-filtered by status + quarter |
| Click compliance count | Compliance page, filtered by flag type |
| Click broadcast log row | Episode detail page |
| Click coverage gap pill | Episodes list, filtered by show name |
| Click issue category bar | Episodes list, filtered by category |
| Click recent episode row | Episode detail page |
| Click "Details →" on cost | Usage page |
| Click QIR status badge | Generate QIR page |
| Click "Last filed" link | Public QIR page (new tab) |
| Click manual trigger button | Triggers job via POST `/api/jobs`, updates On Air strip |
| Click "Retry" on failed episode | Resets episode status, triggers re-processing |
| Click "Mark Unavailable" | Sets episode to `unavailable` status |
| Click quality flag row | Episode detail page |

### Dashboard Data Sources

| Section | API Endpoint | Key Fields |
|---------|-------------|------------|
| On Air strip | `GET /api/jobs` | Active jobs, last completed |
| Quarter scoreboard | `GET /api/dashboard` | Counts by status, QIR draft status |
| QIR Readiness | `GET /api/dashboard` | Distinct categories in summarized episodes |
| Time estimates | `GET /api/dashboard` + `GET /api/usage` | Pending counts × AVG duration |
| Broadcast log | `GET /api/dashboard` | Recent status changes (last 50) |
| Attention needed | `GET /api/dashboard` | Failed episodes, quality flags |
| Compliance alerts | `GET /api/dashboard` | Unresolved flag counts by type |
| Coverage gaps | `GET /api/dashboard` | Shows with no summarized episodes |
| Issue categories | `GET /api/dashboard` | Category counts |
| Recent episodes | `GET /api/dashboard` | Latest episodes |
| Monthly cost | `GET /api/usage?start={month_start}` | Cost totals |
| System health | `GET /api/jobs` | Worker status, last activity timestamps |

---

## Page 2: Episodes List

**Route:** `/dashboard/episodes`

**Purpose:** The workhorse table. Find, filter, sort, and act on episodes. This is where most day-to-day review work starts.

### Filters (top bar)

- Status dropdown: All / Pending / Transcribed / Summarized / Checked / Failed / Unavailable
- Quarter dropdown: All / Q1 2026 / Q4 2025 / Q3 2025 / ...
- Show name text search: type-ahead, searches `show_keys.name`. "Press / to search" hint.
- Category dropdown: All / Government & Politics / Civil Rights / ... (all FCC categories)
- All filters persist in URL query params — shareable, bookmarkable
- Changing any filter resets to page 1
- Example URL: `/dashboard/episodes?status=failed&quarter=2026-Q1&show=democracy`

### Table Columns

| Column | Sortable | Notes |
|--------|----------|-------|
| Show | Yes | Show name, with sort direction indicator |
| Air Date | Yes | YYYY-MM-DD |
| Duration | No | "60m", "30m" |
| Status | Yes | Color-coded badge — clickable, re-filters this page to that status |
| Headline | No | Truncated AI-generated headline |
| Category | No | **Inline editable** — see below |

**Category inline editing:** The category cell displays the current category as text. On click, it becomes a dropdown. Selecting a new value auto-saves immediately with a brief checkmark flash. This is the fast-tagging flow — scan down the list and fix categories without opening each episode. Click anywhere ELSE in the row to navigate to episode detail.

### Bulk Actions (top right)

- "Retry Failed" button (red) — only enabled when failed episodes exist in current filter. Requires confirmation dialog: "Retry N failed episodes?"
- "Export CSV" button — exports currently filtered episodes as a browser download

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate rows up/down (selected row highlighted with blue ring focus indicator) |
| `Enter` | Open selected episode detail page |
| `/` | Focus the show name search input |
| `Escape` | Blur search, deselect row |
| `r` | Trigger "Retry Failed" (with confirmation) |

### Pagination

- 50 episodes per page
- Previous / Next controls
- "Showing 1–50 of 342" count
- Page number persists in URL

### Row Interaction

- Hover: cream background (`kpfk-cream`)
- Click anywhere in row: navigates to episode detail
- Exception: clicking the category cell triggers inline edit, not navigation

### User Flows from Episodes

| Action | Destination |
|--------|-------------|
| Click episode row | Episode detail page |
| Click status badge | Re-filters this page by that status |
| Change category inline | Auto-saves via PATCH, stays on page, checkmark flash |
| Click "Retry Failed" | Confirmation → POST `/api/jobs` → toast notification |
| Click "Export CSV" | Browser downloads CSV of current filtered set |
| Press `/` | Focuses show name search input |
| Press `j`/`k` → `Enter` | Keyboard navigation to episode detail |

---

## Page 3: Episode Detail

**Route:** `/dashboard/episodes/[id]`

**Purpose:** Full view of a single episode. Review AI output, edit metadata, listen to audio, read transcript, resolve compliance flags. This is where detailed editorial work happens.

**Supports URL param:** `?seek=N` (seconds) — when arriving from the Compliance page or any timestamped link, the audio player auto-seeks to this position and the transcript viewer scrolls to the corresponding text.

### Breadcrumb

`Dashboard / Episodes / Car Show, The`

Back arrow "← Episodes" preserves the previous filter state (returns to the episodes list with the same filters/sort/page active).

### Header

- Episode title (show name) + status badge (clickable → episodes filtered by that status)
- If failed: red error banner with error message, retry count, and inline "Retry" button
- If compliance discrepancies: amber banner with summary of unresolved flags

### Metadata Grid (8 cells, 2 rows of 4)

| Air Date | Time | Duration | Show Key |
|----------|------|----------|----------|
| Category | Host | Guest | Created |

- Category, Host, and Guest cells are directly editable in the grid (click to edit, blur/enter to save)
- Other cells are read-only display

### Action Buttons

Two groups, visually separated:

**Editorial actions:**
- Save Changes (green, primary) — only visible when edits are dirty. Amber border on dirty fields.

**Pipeline actions (secondary row, grouped):**
- Re-Transcribe (destructive — confirmation dialog: "Re-transcribe 1 episode? This will overwrite the existing transcript.")
- Re-Summarize (destructive — confirmation dialog: "Re-summarize 1 episode? This will overwrite the existing summary.")
- Run Compliance Check (non-destructive, adds/refreshes flags)
- Download MP3 | Download Transcript | Download VTT (client-side blob downloads)

### Summary & Category Editor

This is the primary work area on the page. Positioned prominently, above the audio player.

- Headline: AI-generated, displayed as editable text input
- Summary: full textarea, always visible, no collapse needed
- Category: dropdown selector
- Save Changes button
- Dirty state indicator — amber border or dot when unsaved changes exist
- All three fields save together on a single Save action

### Compliance Flags Section

Shows flags found during compliance checking. Positioned between the summary editor and the audio player.

Each flag is a card:
- Type badge (profanity / station_id_missing / technical / payola_plugola / sponsor_id) with severity color (red critical / amber warning / gray info)
- Excerpt — the flagged text, shown in context
- Timestamp — when in the episode (MM:SS format)
- Details — explanation of the concern
- **"Jump to" button** — seeks audio player to timestamp, scrolls caption viewer and transcript viewer to the excerpt, highlights the flagged text
- **Resolve button** → expands inline form: resolved_by (auto-filled from auth), resolved_notes (textarea), Save. On save, flag dims with strikethrough.
- **"Not a real word — add correction"** shortcut — for flags triggered by transcription errors. Opens the transcript correction inline form pre-filled with the flagged excerpt. On save, offers to auto-resolve the compliance flag.
- Resolved flags: dimmed with strikethrough, hidden behind a collapsible "Show N resolved flags" toggle

### Audio Player with Captions

Lazy-loaded via `next/dynamic` with skeleton fallback. Standard audio controls: play/pause, scrub bar, volume, playback speed.

- VTT captions displayed below the player in a scrolling caption track
- Current caption highlighted (blue background)
- Clicking any caption line seeks the audio to that timestamp
- **Compliance flag highlights on captions:** Caption lines containing flagged content are marked with a colored left border (red for critical, amber for warning) and a small severity icon. Hovering shows a tooltip with the flag type and details. Clicking jumps to the flag card in the Compliance Flags section above.
- **`?seek=N` support:** On page load, if the URL contains a seek parameter, the player auto-seeks to that position and the corresponding caption is highlighted.

### Transcript Viewer

Lazy-loaded via `next/dynamic` with skeleton fallback. Full transcript text with search.

- "Search transcript..." input at top right of the section
- Search highlights matches in the transcript text (yellow highlight)
- **Compliance flag highlights on transcript:** Flagged excerpts are highlighted with background color matching severity (light red for critical, light amber for warning). Hovering shows a tooltip with flag type, details, and "Jump to audio" link. Clicking the highlight seeks the audio player to that timestamp.
- **"Add correction" on text selection:** Select any text in the transcript → a small floating toolbar appears with "Add Transcript Correction" button. Clicking opens a compact inline form:
  - Pattern: pre-filled with selected text
  - Replacement: empty text input
  - Is Regex: toggle (default off)
  - Scope: "This episode only" / "All episodes (add to global corrections)"
  - Save button
  - On save, toast: "Correction saved. Re-transcribe to apply?" with action button
  - This lets you fix transcription errors on the spot without navigating to Settings

### User Flows from Episode Detail

| Action | Result |
|--------|--------|
| Edit summary/category/headline → Save | PATCH `/api/episodes/[id]`, toast "Saved" |
| Edit Host/Guest in metadata grid | Inline edit, saves on blur/enter |
| Click compliance flag "Jump to" | Audio seeks to timestamp, captions scroll, transcript scrolls + highlights |
| Resolve compliance flag | Inline form → PATCH `/api/compliance/[id]`, flag dims |
| "Not a real word — add correction" | Correction form → POST `/api/corrections`, optional auto-resolve flag |
| Select transcript text → "Add correction" | Floating form → POST `/api/corrections`, toast with re-transcribe option |
| Re-Transcribe | Confirmation → POST `/api/jobs` → status reverts to `pending` |
| Re-Summarize | Confirmation → POST `/api/jobs` → status reverts to `transcribed` |
| Run Compliance Check | POST `/api/jobs` → triggers compliance worker for this episode |
| Download MP3/Transcript/VTT | Client-side blob download |
| Click ← Episodes | Returns to episodes list with preserved filter/sort/page state |
| Click status badge | Episodes list filtered to that status |

---

## Page 4: Compliance

**Route:** `/dashboard/compliance`

**Purpose:** Station-wide compliance oversight. See all flags across all episodes, resolve them, manage compliance rules. This is the page you open when someone at Pacifica asks "are we clean?" It is NOT about QIR generation — it's about ongoing operational compliance and FCC risk management.

**Supports URL params:** `?type=profanity&severity=critical&quarter=2026-Q1` for pre-filtered views from dashboard clickthrough.

### Summary Stats Strip (top of page)

Compact horizontal strip above the filters:
- "47 unresolved flags: 12 critical · 28 warning · 7 info"
- Trend vs. last quarter: "↓ 3 from Q4 2025" (or ↑)
- By-type breakdown as small horizontal bars (profanity, station_id, payola, technical, sponsor_id)

### Filters (below stats strip)

- Flag type dropdown: All / Profanity / Station ID Missing / Technical / Payola/Plugola / Sponsor ID
- Severity dropdown: All / Critical / Warning / Info
- Resolution status: Unresolved (default) / Resolved / All
- Quarter dropdown: current quarter default
- Show name text search
- All filters persist in URL params

### Compliance Flags Table

| Column | Notes |
|--------|-------|
| Episode | Show name + air date, clickable → episode detail |
| Type | Badge with color: profanity, station_id, payola, etc. |
| Severity | Critical (red) / Warning (amber) / Info (gray) |
| Excerpt | Flagged text, truncated with tooltip for full text on hover |
| Timestamp | MM:SS in episode — **clickable → episode detail with `?seek=N`** |
| Status | Unresolved / Resolved indicator |
| Actions | Resolve / View Episode |

Rows are selectable via checkbox for bulk operations.

### Resolve Flow

**Single flag:** Click "Resolve" → inline form expands below the row:
- Resolved by: auto-filled from authenticated user
- Notes: textarea ("Reviewed — legitimate book discussion, not plugola")
- Save button
- On save, row dims and moves to bottom (if filtering by unresolved) or gets strikethrough styling

**Bulk resolve:** Select multiple flags via checkboxes → "Resolve Selected" button appears above table → shared notes field → saves all selected with same notes

### Compliance Rules Management

Below the flags table, organized as a tabbed section:

**Tab: Profanity Word List**
- CRUD table: Word | Severity (dropdown: warning / critical) | Active (toggle) | Actions (edit / delete)
- Add new word form (inline, above table)
- Bulk import from CSV button
- Search/filter the list
- Common seed words suggested on first setup

**Tab: AI Compliance Prompt**
- Editable textarea with the current prompt text
- Explicit Save button (same pattern as Settings prompts — this is the only free-form field on the Compliance page)
- **Required, cannot be empty.** Validation prevents saving blank.
- "Reset to default" button restores the shipped compliance prompt
- Amber border when dirty, warning if navigating away unsaved
- Brief description above the textarea explaining what this prompt does

**Tab: Check Settings**
- Enable/disable each check type independently: profanity, station ID, technical, payola, sponsor ID — each with a toggle
- Toggle for whether the compliance step is blocking vs. non-blocking for QIR eligibility
- Brief explanation of each check type

### User Flows from Compliance

| Action | Result |
|--------|--------|
| Click episode name in table | Navigate to episode detail |
| Click timestamp in table | Navigate to episode detail with `?seek=N` (audio pre-seeked) |
| Resolve a single flag | Inline form → PATCH, row dims |
| Bulk resolve flags | Select multiple → shared form → PATCH all |
| Add profanity word | POST to `compliance_wordlist`, available immediately |
| Edit AI prompt | Save to `qir_settings` |
| Toggle check type | Save to `qir_settings` |
| Change filters | Reloads table, URL updates |

---

## Page 5: Jobs

**Route:** `/dashboard/jobs`

**Purpose:** Pipeline operations monitor. What's running, what's queued, what failed. This is the ops/debugging page for when you need to understand the pipeline's internal state.

### Queue Cards (4 columns)

One card per pipeline stage: **Ingest | Transcribe | Summarize | Compliance**

Each card shows:
- Stage name header
- "Run Now" button (top right of card)
- 4 count cells in a 2×2 grid: Active (green bg) | Waiting (yellow bg) | Completed (blue bg) | Failed (red bg)
- Counts are large and readable

### Pipeline Mode Toggle

Below the queue cards:
- Current mode indicator: "Mode: Steady" or "Mode: Catch-up"
- Toggle button to switch between modes
- Description: "Steady: 1 transcribe / 5 summarize concurrent. Catch-up: 3 transcribe / 10 summarize concurrent."

### Cron Schedule Reference

Static informational section:
- "Ingest runs at minute :02 of every hour."
- "Transcription triggers automatically after ingest finds new episodes."
- "Summarization triggers after transcription completes."
- "Compliance triggers after summarization completes."
- "Auto-retry runs every 4 hours for failed episodes (≤3 retries)."

### Failed Jobs Detail (collapsible)

Only renders when any queue has failed jobs.
- List of failed job IDs, linked episode names, error messages, failure timestamps
- "Clear Failed" button per queue (removes from BullMQ queue — doesn't change episode status)
- "Retry All Failed" button (per queue)

### User Flows from Jobs

| Action | Result |
|--------|--------|
| Click "Run Now" on any stage | POST `/api/jobs` with action, triggers immediately |
| Toggle pipeline mode | Saves to `qir_settings`, workers pick up on next 30s poll |
| Click failed job episode link | Navigate to episode detail |
| "Clear Failed" | Removes failed jobs from BullMQ queue |
| "Retry All Failed" | Requeues failed jobs |

---

## Page 6: Activity Log

**Route:** `/dashboard/activity`

**Purpose:** Full audit trail. Everything that happened, when, and to what. This is the expanded version of the dashboard broadcast log — same editorial typography, same visual language, more depth and filtering.

### Time Range Selector (top right)

Toggle button group: **24 hours | 3 days | 7 days (default) | 30 days**

### Filters (optional, above feed)

- Event type: All / Ingested / Transcribed / Summarized / Compliance Checked / Failed
- Show name text search

### Activity Feed

Grouped by day: "YESTERDAY — 8 EVENTS", "MARCH 6 — 12 EVENTS"

Each row:
- Timestamp in left column (monospace or tabular figures)
- Status badge (Summarized, Transcribed, Ingested, Failed, etc.)
- Show name (or system event description for ingests)
- Summary snippet (truncated, muted gray)
- **Right column varies by event type:** duration for transcriptions, cost for summarizations, count for ingests (consistent with dashboard broadcast log)

Each row clickable → navigates to episode detail.

### User Flows from Activity

| Action | Result |
|--------|--------|
| Click any row | Navigate to episode detail |
| Change time range | Reloads feed for selected range |
| Filter by event type | Filters the feed, URL updates |
| Filter by show name | Filters the feed |

---

## Page 7: Usage & Costs

**Route:** `/dashboard/usage`

**Purpose:** Track API spending. Know what this thing costs to run and whether costs are trending.

### Date Range Picker (top)

"From" and "To" date inputs. Defaults to current month.

### Summary Cards (top row, 5 cells)

| Total Cost | Groq (Transcription) | OpenAI (Summarization) | Episodes Processed | API Calls |
|------------|---------------------|----------------------|-------------------|-----------|
| $2.98 | $2.93 | $0.05 | 29 | 58 |

### Cost by Operation

Horizontal bar chart: Transcribe vs. Summarize vs. Compliance
- Dollar amounts right-aligned
- Bars proportional to spend

### Daily Spend Table

| Date | Groq | OpenAI | Total | Calls |
|------|------|--------|-------|-------|
| 2026-03-07 | $0.88 | $0.01 | $0.90 | 16 |

Optionally, clicking a row could expand to show per-episode cost breakdown for that day (nice-to-have).

### Quarter-over-Quarter Comparison

- "Q1 2026 so far: $2.98 (67 days remaining)"
- "Q4 2025: $8.42 total"
- "Projected Q1 total: ~$12.50 at current pace"
- Projection = (current spend / days elapsed in quarter) × days in quarter
- Simple text comparison, not a complex chart

### User Flows from Usage

| Action | Result |
|--------|--------|
| Change date range | Reloads all data for selected range |
| Click daily spend row | Expands per-episode breakdown (nice-to-have) |

---

## Page 8: Generate QIR (QIR Builder)

**Route:** `/dashboard/generate`

**Purpose:** Assemble and finalize the quarterly report for FCC filing. This is where the regulatory artifact gets built, reviewed, edited, and locked for filing.

### Quarter Selector (top right)

Dropdown: Q1 2026, Q4 2025, etc.

### Generate Report Button (top right, next to quarter selector)

Triggers AI curation of summarized + compliance_checked episodes into QIR entries. Shows loading state ("Generating...") during processing. Creates a new draft version.

### Pre-Finalization Checklist

6 automated validation checks, each with pass (green ✓) / warn (amber !) / fail (red ✗):

1. **Entry count** — "18 entries (20+ recommended)" — warn if <20, fail if <10
2. **Category coverage** — "Missing: Immigration" — warn if <8 categories, fail if <5
3. **Show variety** — "14 different shows" — warn if <8, fail if <5
4. **Date distribution** — "Spans 62 days across the quarter" — warn if <60 days, fail if <30
5. **Complete entries** — "All entries have summary, host, and headline" — fail if any incomplete
6. **Compliance** — "No unresolved compliance flags" — warn if unresolved warnings, fail if unresolved critical

Overall status badge top right of checklist: "Ready" (green) / "Needs attention" (amber) / "Not ready" (red)

### Issue Categories Overview

Horizontal bar chart of FCC categories with episode counts — same visualization as on the dashboard, but here it serves a filing-decision purpose. Shows distribution and gaps before you generate. Positioned above or beside the checklist.

### Draft History

List of generated versions:
- "Version 1 — 3/8/2026 — 18 entries" with status badge (draft / final)
- "Finalize" button on draft versions — requires confirmation dialog: "Finalize this QIR? This will lock the report and publish it to the public page."
- "Unfinalize" on finalized versions — also requires confirmation
- Click version row to view that draft's content below

### Report View

Tab bar: **Curated | Full Report**
Export buttons: **Export CSV | Export Text**

**Curated View:**
The report as it will be filed, grouped by FCC issue category.

Each category section:
- Category header: "GOVERNMENT / POLITICS (6 ENTRIES)"
- Each entry shows:
  - Show name — Host name
  - Air date | Time | Duration | Guest(s)
  - Headline (bold)
  - Summary paragraph
  - "Edit" link → inline editing (headline + summary become inputs/textareas, category becomes dropdown)
  - "Remove" link → confirmation → removes from curated list

**Full Report View:**
Same content formatted as a continuous document, closer to the actual filing format. Read-only preview.

### Inline Entry Editing

Clicking "Edit" on a curated entry:
- Headline becomes a text input
- Summary becomes a textarea
- Category becomes a dropdown (to recategorize — entry moves to new category section on save)
- "Save" / "Cancel" buttons appear
- Changes saved to `qir_drafts.curated_entries` JSON

### User Flows from Generate QIR

| Action | Result |
|--------|--------|
| Click "Generate Report" | POST `/api/qir/generate` → AI processes episodes → new draft version |
| Click version in Draft History | Loads that version's curated entries below |
| Edit an entry | Inline editing → PATCH draft JSON |
| Remove an entry | Confirmation → removes from curated list |
| Click "Finalize" | Confirmation → locks draft, publishes to `/[year]/q[quarter]` |
| Click "Unfinalize" | Confirmation → unlocks draft |
| Export CSV / Export Text | Browser downloads the report |
| Click "Full Report" tab | Shows continuous formatted view |

---

## Page 9: Downloads

**Route:** `/dashboard/downloads`

**Purpose:** Batch export hub. Get files out of the system in bulk.

### Quarter Selector (top right)

Dropdown matching the current quarter.

### Batch Downloads Section

Card with three download rows:
- **Transcripts** — "All transcripts for the selected quarter as a combined text file" → Download button
- **VTT Captions** — "All VTT caption files for the selected quarter" → Download button (zip)
- **Episode Data (CSV)** — "Full episode metadata for the selected quarter" → Download button

### QIR Report Exports Section

Card with redirect rows (QIR exports live on the Generate page):
- QIR Report (CSV) → "Go to QIR Builder" button
- QIR Report (Text) → "Go to QIR Builder" button

### Public QIR Page Section

Card:
- "Finalized QIR reports are published at:"
- Links to each published quarter: `/2026/q1`, `/2025/q4`, etc.
- Only shows quarters that have a finalized draft

### User Flows from Downloads

| Action | Result |
|--------|--------|
| Click "Download" on any batch item | Browser downloads the file |
| Click "Go to QIR Builder" | Navigates to Generate QIR page |
| Click published QIR link | Opens public QIR page in new tab |

---

## Page 10: Settings

**Route:** `/dashboard/settings`

**Purpose:** App configuration. Everything that controls how the system behaves, except compliance rules (which live on the Compliance page).

### Structure: Tabbed Sub-Navigation

Horizontal tabs within the settings page. Active tab persists in URL: `/dashboard/settings?tab=pipeline`

**Tab 1: General**
- Station ID (text input — auto-saves on blur)
- Max Entries Per Category (number stepper — auto-saves on change)
- Issue Categories (tag/pill editor with add/remove — each add/remove auto-saves immediately)
- Excluded Categories (same tag/pill editor — each add/remove auto-saves immediately)

**Tab 2: Pipeline**
- Pipeline Mode: Steady / Catch-up toggle (auto-saves on toggle)
- Transcription Model (dropdown — auto-saves on selection)
- Summarization Model (dropdown — auto-saves on selection)
- Transcribe Batch Size (number stepper — auto-saves on change)
- Summarize Batch Size (number stepper — auto-saves on change)
- Summarization Prompt (tall textarea + explicit Save button) — **required, cannot be empty.** "Reset to default" button restores the shipped prompt. Dirty state: amber border when modified, warning if navigating away unsaved.
- Curation Prompt (tall textarea + explicit Save button) — **required, cannot be empty.** Same "Reset to default" and dirty state behavior.

**Tab 3: Transcript Corrections**
- CRUD table: Pattern | Replacement | Is Regex (toggle) | Actions (edit / delete)
- Add new correction form (inline, above or below table)
- Bulk import from CSV button
- Search/filter
- Note below table: "Corrections can also be added directly from the transcript viewer on any episode detail page."

**Tab 4: Shows**
- CRUD table of all shows from `show_keys`
- Columns: Key | Name | Default Category (inline dropdown) | Active (toggle) | Episode Count (read-only)
- Search/filter
- Inline editing for Name and Default Category
- Activate/deactivate shows via toggle
- Episode Count links to episodes page filtered to that show

### Save Behavior

- **Constrained inputs** (toggles, dropdowns, number steppers, tag add/remove): **auto-save on interaction.** Every possible state is valid the moment you interact. Brief inline "Saved ✓" flash next to the field.
- **Prompts** (summarization, curation): **explicit Save button.** These are the only free-form fields on Settings. You may be mid-edit with incomplete content, so auto-save would be dangerous. Non-empty validation — cannot save blank. "Reset to default" restores the shipped prompt. Amber border when dirty, browser warning if navigating away with unsaved changes.
- **CRUD table rows** (transcript corrections, shows, profanity wordlist): **row-level save.** Click edit on a row → fields become editable → row-level Save/Cancel buttons. Add forms have their own Submit. Deletes require confirmation.

### User Flows from Settings

| Action | Result |
|--------|--------|
| Switch tabs | Shows different settings section, URL updates (`?tab=X`) |
| Change toggle/dropdown/stepper | Auto-saves to `qir_settings`, inline "Saved ✓" flash |
| Add/remove category tag | Auto-saves to `qir_settings`, pill appears/disappears |
| Edit prompt → Save | Validates non-empty → saves to `qir_settings`, toast confirmation |
| Edit prompt → "Reset to default" | Restores shipped prompt text, requires Save to persist |
| Add transcript correction | Row-level submit → POST to `transcript_corrections` |
| Edit transcript correction | Row-level save → PATCH `transcript_corrections` |
| Toggle show active status | Auto-saves → PATCH `show_keys`, affects coverage gap calculation |
| Edit show default category | Inline dropdown → auto-saves on selection |
| Click show episode count | Navigate to episodes filtered by that show |

---

## Page 11: Login

**Route:** `/login`

**Purpose:** Authentication gate.

### Layout

- Centered card on a clean warm background
- KPFK branding: logo + "QIR / KPFK" text
- Email input
- Password input
- "Sign In" button
- Error message display for failed authentication attempts (red text below button)

### Behavior

- On successful auth: redirect to `/dashboard`
- Session checked on all `/dashboard/*` route layouts — redirect to `/login` if unauthenticated or expired
- Auth state listener handles sign-out across browser tabs
- Supabase email/password authentication

---

## Page 12: Public QIR Report

**Route:** `/[year]/q[quarter]` (e.g., `/2026/q1`)

**Purpose:** The actual FCC filing document, publicly accessible. This goes in the station's local public file. No authentication required.

### Design

This should look like a proper public document, not a dashboard page. No sidebar, no nav, no auth UI.

- KPFK logo/branding at top
- Station identification: "KPFK 90.7FM, Los Angeles, CA"
- Report title: "Quarterly Issues Report"
- Quarter date range: "January 1, 2026 through March 31, 2026"
- Server-rendered (SSR, no client-side loading states)
- Clean, professional typography — readable, formal but not stuffy
- "Note: This list is by no means exhaustive." (matching the station's existing QIR convention)

### Content Structure

Entries grouped by FCC issue category:

**GOVERNMENT / POLITICS (6 entries)**

For each entry:
- Show title — Host name
- Air date | Time slot | Duration
- Guest(s)
- Headline (bold)
- Summary paragraph

Repeat for each category with entries.

### Print Stylesheet

Essential — this literally needs to print well for the physical public file.
- No background colors that waste ink
- Proper page breaks (don't split an entry across pages, use `break-inside: avoid`)
- Station name + quarter in header on each printed page
- Reasonable print margins
- Hide any interactive elements

### Footer

- "Note: This list is by no means exhaustive."
- Station contact information
- Report generation date

---

## Cross-Page Interaction Patterns

### Compliance Flag → Audio Seek Flow

Works from three entry points, all converging on the same behavior:

**Entry point 1: Compliance page → Episode detail**
1. User sees a flag in the compliance table with a timestamp (e.g., "14:32")
2. Clicks the timestamp link
3. Navigates to episode detail: `/dashboard/episodes/[id]?seek=872`
4. Episode detail page loads with:
   - Audio player auto-seeks to 14:32 (872 seconds)
   - Caption viewer scrolls to the corresponding line, highlighted
   - Transcript viewer scrolls to the flagged excerpt, highlighted with severity color
   - The compliance flag card in the flags section is scrolled into view and visually highlighted

**Entry point 2: Episode detail compliance flags → Audio player**
1. User is on the episode detail page and sees a compliance flag card
2. Clicks "Jump to" on the flag
3. Audio player seeks to the timestamp
4. Caption viewer scrolls and highlights the relevant line
5. Transcript viewer scrolls and highlights the flagged excerpt
6. Smooth scroll brings the audio player into view if it's off-screen

**Entry point 3: Transcript viewer highlights → Audio player**
1. User is reading the transcript and notices a colored highlight (compliance flag)
2. Hovers: tooltip shows flag type, severity, details
3. Clicks the highlight: audio player seeks to that point, caption viewer scrolls
4. The compliance flags section scrolls to show that flag's card

### Transcript Correction Flow

Three entry points, converging to the same result:

**Entry point 1: Episode detail — text selection**
1. User selects text in the transcript viewer
2. Floating toolbar appears: "Add Transcript Correction"
3. Click opens inline form: pattern (pre-filled), replacement, is_regex, scope (this episode / global)
4. Save → POST `/api/corrections`
5. Toast: "Correction saved. Re-transcribe to apply?" with action button

**Entry point 2: Episode detail — compliance flag**
1. User sees a compliance flag triggered by a bad transcription (e.g., a word that sounds like profanity but isn't)
2. Clicks "Not a real word — add correction" on the flag
3. Same inline form, pattern pre-filled with the flagged excerpt
4. Save → POST `/api/corrections` + option to auto-resolve the compliance flag

**Entry point 3: Settings → Transcript Corrections tab**
1. Traditional CRUD table
2. Add, edit, delete corrections
3. Bulk import from CSV
4. Note: no episode context here, so corrections apply globally

### Category Tagging Flows

Two speeds for different contexts:

**Fast tagging (Episodes list page):**
1. User scans the episodes table
2. Clicks a category cell → it becomes a dropdown
3. Selects new category → auto-saves immediately (PATCH)
4. Brief checkmark flash
5. No page navigation — stay in the list, move to next episode

**Detailed tagging (Episode detail page):**
1. User opens an episode to review
2. Reads the full summary
3. Changes category in the dropdown
4. Optionally edits the summary or headline
5. Clicks "Save Changes"

### Dashboard → Detail Drill-Down Patterns

All dashboard clickthrough links follow a consistent pattern:

| Dashboard element | Link target | URL pattern |
|-------------------|-------------|-------------|
| Status count cell | Episodes list | `/dashboard/episodes?status=X&quarter=Y` |
| Compliance alert count | Compliance page | `/dashboard/compliance?type=X` |
| Broadcast log row | Episode detail | `/dashboard/episodes/[id]` |
| Coverage gap pill | Episodes list | `/dashboard/episodes?show=X&quarter=Y` |
| Issue category bar | Episodes list | `/dashboard/episodes?category=X&quarter=Y` |
| Recent episode row | Episode detail | `/dashboard/episodes/[id]` |
| QIR status badge | Generate QIR | `/dashboard/generate` |
| Cost "Details →" | Usage page | `/dashboard/usage` |
| "Last filed" link | Public QIR | `/[year]/q[quarter]` (new tab) |
| Quality flag row | Episode detail | `/dashboard/episodes/[id]` |

---

## Visual Design Principles (All Pages)

### Typography
- Editorial character — like a broadcast log or newspaper layout. Clean with personality.
- Clear hierarchy: large readable numbers for stats (32–40px), medium weight for labels, monospace/tabular figures for timestamps and costs.
- Section headings: `text-xs font-semibold text-gray-400 uppercase tracking-wide`
- Body: system font stack, 14px base
- Don't over-style. Let the data breathe.

### Color Usage
- `kpfk-red` (#C41E3A): primary accent, progress bars, links, On Air indicator
- `kpfk-black` (#1a1a1a): headings, primary text, primary buttons
- `kpfk-gold` (#D4A843): processing state borders, highlights
- `kpfk-cream` (#FAF8F5): hover states, subtle backgrounds, processing state backgrounds
- Status badges: pending (amber-100/800), transcribed (blue-100/800), summarized (emerald-100/800), compliance_checked (emerald-100/800), failed (red-100/800), unavailable (gray-100/600)
- Compliance severity: red (critical), amber (warning), gray (info)
- Health indicators: green (<2h / healthy), amber (2–8h / stale), red (>8h / down)
- Green for healthy/complete: muted sage, not neon. Red only for actual failures — used sparingly.

### Motion & Loading
- No gratuitous animations
- Amber pulse on the On Air indicator dot when actively processing
- Skeleton loading states (animate-pulse) on all data-driven content throughout the app
- Consistent fade-in when data loads — no jarring content shifts
- Smooth scroll when seeking/jumping within a page
- Brief checkmark flash on inline saves
- New activity feed entries slide in smoothly, not causing page jumps
- Buttons show spinners and disable during async actions ("Retrying...", "Generating...", "Saving...")
- While one action is in progress, other action buttons disable to prevent conflicts

### Cards & Containers
- Dashboard widgets: `bg-white rounded-xl shadow-sm border`
- No nested cards (cards within cards)
- Consistent padding (`p-6`) and spacing
- Tables: `bg-white rounded-lg shadow overflow-x-auto`, gray header row, divide-y rows

### Component Patterns
- Badges/pills: `text-xs px-2 py-0.5 rounded-full` with semantic colors
- Buttons (primary): `bg-kpfk-black text-white hover:bg-gray-700`
- Buttons (destructive): `bg-red-600 text-white hover:bg-red-700`
- Buttons (secondary): `bg-gray-200 text-gray-700 hover:bg-gray-300`
- Inputs/selects: `border rounded px-2 py-1.5 text-sm`
- Confirmation dialogs: consistent modal component (not browser `confirm()`), always showing what will happen

### Responsiveness
- Desktop-first (this is primarily a workstation tool)
- Sidebar collapses to hamburger on mobile, slides in from left with backdrop overlay
- Tables scroll horizontally on small screens
- Dashboard sections stack vertically on narrow viewports
- Scoreboard: 6-across → 2×3 on tablet → vertical stack on mobile
- Broadcast log: hide right column (duration/cost) on mobile

### Accessibility
- All interactive elements keyboard-reachable
- Color is never the only indicator — always paired with text labels or icons
- Focus rings on keyboard navigation
- ARIA labels on icon-only buttons
- Status badges include text, not just color
- Compliance highlights include tooltip text, not just background color
