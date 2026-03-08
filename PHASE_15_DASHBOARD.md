# Phase 15: Dashboard Redesign + UI Polish

## Overview Page Redesign

Redesign `/dashboard` overview page. This is the page that'll be open on a monitor at the station. It should tell everything at a glance without clicking into subpages.

### Visual Direction
- White/cream background, clean but not sterile. Warm, not corporate.
- KPFK branding colors as accents — black, red (#C41E3A), warm amber/gold for highlights.
- Editorial typography — like a broadcast log or newspaper layout. Clean with character.
- No gratuitous animations. Purposeful motion only — gentle pulse when something is actively processing, a number ticking up when episodes arrive.
- Should feel like a tool built BY a radio station FOR a radio station. Not a generic SaaS admin panel with a KPFK logo slapped on.

### Dashboard Sections (top to bottom)

**1. "On Air" status strip**
Full width across the top. Shows what's currently processing:
- "Transcribing: Beneath The Surface - Mar 5" with subtle progress indicator
- Multiple active jobs show stacked
- When idle: "All caught up" in calm, muted style
- **Next auto-run countdown:** "Next ingest in 23 min" — so the user knows whether to wait or hit the manual button
- Think the ON AIR light in a studio — present but not screaming

**2. Quarter scoreboard**
Big, readable numbers you can see from across a room:
- "Q1 2026: 342 episodes / 280 transcribed / 195 summarized"
- Simple progress bar for overall pipeline completion
- **Each status count is clickable** — links to `/dashboard/episodes?status=pending&quarter=2026-Q1` etc.
- "QIR: Draft in progress" or "QIR: Not yet generated"

**3. QIR readiness indicator**
Shows whether you can generate a decent QIR right now:
- "QIR ready: 6 of 8 categories covered"
- Lists missing categories: "Missing: Immigration, Health"
- Based on counting distinct `issue_category` values among `summarized` episodes in the current quarter
- Green when 5+ categories covered (FCC minimum), amber when 3-4, red when <3

**4. Time estimates**
Calculated from historical averages in `usage_log`:
- Per stage: "~45 min to finish transcription (15 episodes × 3 min avg)"
- Per stage: "~2 min to finish summarization (8 episodes × 15s avg)"
- Overall: "Pipeline clear in ~47 min at current pace"
- If nothing pending: "All caught up"
- SQL: `SELECT AVG(duration_seconds) FROM usage_log WHERE operation = 'transcribe' AND created_at > now() - interval '7 days'`
- Update on each poll cycle

**5. Recent activity as a broadcast log**
Formatted like an actual radio station program log:
- Timestamps in left column, show names, what happened
- Scrollable, last 20 events
- "10:02 AM — Ingested 3 new episodes"
- "10:04 AM — ✓ Transcribed: Democracy Now Mar 5 (2m 34s)"
- "10:05 AM — ✓ Summarized: Beneath The Surface Mar 4"
- Auto-refreshes every 10-15 seconds

**6. Attention needed**
Two sub-sections:

*Failed episodes* — formatted like a producer's pull sheet:
- "Background Briefing Mar 3 — MP3 not found"
- "Democracy Now Mar 5 — transcription failed (retry)"
- Inline retry buttons. Count badge.

*Episode quality flags:*
- Episodes with very short transcripts (<500 chars for a 30+ min show)
- Episodes where AI summary says "little or no substantive discussion"
- Episodes with discrepancies flagged by the summarizer
- Each links to the episode detail page

**7. Show coverage gaps**
Which active shows have ZERO summarized episodes this quarter:
- "No coverage this quarter: American Indian Airwaves, Arts In Review, Bike Talk Podcast"
- Helps ensure QIR has variety across shows (FCC cares about this)
- Only shows non-Music, non-Español active shows

**8. Cost this month**
Understated, single line: "March spend: $4.82 (Groq $2.10 / OpenAI $2.72) — avg $0.03/episode"
- Optional tiny sparkline of daily spend over last 30 days
- No speedometers, no gauges

**9. System health footer**
Thin strip at very bottom:
- "Workers: running · Last ingest: 12 min ago · Last transcription: 34 min ago"
- Green when healthy, amber when stale (>2 hours), red when broken
- Subtle, not alarming

### Component Decomposition
Build these as separate components before assembling the page:
- `components/dashboard/on-air-strip.tsx`
- `components/dashboard/quarter-scoreboard.tsx`
- `components/dashboard/qir-readiness.tsx`
- `components/dashboard/time-estimates.tsx`
- `components/dashboard/activity-log.tsx`
- `components/dashboard/attention-needed.tsx`
- `components/dashboard/coverage-gaps.tsx`
- `components/dashboard/cost-summary.tsx`
- `components/dashboard/health-footer.tsx`

### Technical
- Poll `/api/dashboard`, `/api/usage`, `/api/jobs` every 10-15 seconds
- Calculate time estimates client-side from usage averages
- Use recharts only for the cost sparkline if included
- Coverage gaps: query `show_keys` LEFT JOIN `episode_log` for the current quarter

---

## Global UI Polish (all pages)

These apply across the entire app, not just the overview:

### 1. Consistent page transitions / loading states
- Use skeleton loaders (already have `components/skeleton.tsx`) on every page
- Consistent fade-in when data loads
- No jarring content shifts — reserve layout space for data before it arrives

### 2. Breadcrumb navigation
- Show on all pages below the page title
- Format: Dashboard > Episodes > Democracy Now - Mar 5
- Clickable at each level
- Component: `components/breadcrumbs.tsx`

### 3. Confirmation dialogs on destructive actions
- Required for: Finalize QIR, Bulk retry, Re-transcribe, Re-summarize, Delete draft
- Use a consistent modal component, not browser `confirm()`
- Show what will happen: "Re-transcribe 1 episode? This will overwrite the existing transcript."
- Component: `components/confirm-dialog.tsx`

### 4. Keyboard shortcut for search
- `/` focuses the search/filter box on any page that has one (episodes, settings corrections)
- `Escape` blurs it
- Small hint text near the search box: "Press / to search"

### 5. Mobile-friendly sidebar
- Collapsible on mobile — hamburger menu
- Stays open on desktop
- Current page highlighted in nav
- Smooth slide transition

### 6. Clickable status badges everywhere
- Any status badge (summarized, pending, failed, etc.) anywhere in the app should link to the episodes page filtered to that status
- This applies to: overview page counts, episode table badges, activity feed items

---

## Compliance Flagging System

A compliance checking step that runs automatically after summarization. Flags potential FCC issues in transcripts so programming staff can review. Mix of free rule-based checks and cheap AI-assisted checks (~$0.002/episode).

### New Pipeline Step

After summarization completes, run a compliance scan. This is a separate worker — not baked into the summarizer — so compliance rules can be updated and re-run independently.

**Episode status flow update:**
```
pending → transcribed → summarized → compliance_checked
```

The `compliance_checked` status replaces `summarized` as the "fully processed" state. Episodes are eligible for QIR selection once they reach `compliance_checked`. The compliance step should NOT block QIR generation — if compliance checking fails, the episode stays `summarized` and is still usable, just without compliance data.

### Check Types

**Rule-based checks (run on every transcript, $0 cost):**

1. **Profanity/vulgarity** (`profanity`)
   - Word list scan against transcript text
   - Log each hit with the word, timestamp (from VTT), and surrounding context (±50 chars)
   - Only flag episodes airing 6am-10pm Pacific (FCC safe harbor is 10pm-6am — profanity during safe harbor is legal)
   - Severity: `warning` during safe harbor hours, `critical` during restricted hours
   - Word list managed from Settings page (same CRUD pattern as transcript corrections)

2. **Station ID check** (`station_id_missing`)
   - Scan VTT timestamps for mentions of "KPFK" or "90.7" near top-of-hour marks (±5 minutes of :00)
   - FCC requires legal station ID (call letters + city of license) at the top of each hour
   - Flag if no station ID detected near any hour boundary within the episode
   - Severity: `warning`

3. **Technical issues** (`technical`)
   - Flag episodes where transcript length is <500 chars for a 30+ min show (possible dead air, bad audio)
   - Flag episodes where large chunks of transcript are repeated text (looped audio)
   - Flag episodes where transcript contains indicators like "technical difficulties" or "dead air"
   - Severity: `info`

**AI-assisted checks (GPT-4o-mini, ~$0.002/episode):**

4. **Payola/plugola** (`payola_plugola`)
   - Send transcript to GPT-4o-mini with a focused prompt asking it to identify:
     - Undisclosed commercial promotion of products, services, businesses
     - Hosts promoting something they may have a financial interest in without disclosure
     - Content that sounds like paid advertising without sponsorship identification
   - Do NOT flag: pledge drive segments, promoting KPFK events, discussing books/films in a journalistic context
   - Severity: `warning`

5. **Sponsor identification** (`sponsor_id`)
   - Flag segments that sound like sponsored content without required FCC disclosure language
   - FCC requires: "This program is sponsored by..." or equivalent
   - Severity: `warning`

**AI compliance prompt (editable in Settings):**
```
You are an FCC compliance reviewer for KPFK, a noncommercial community radio station.

Review the following transcript for potential compliance issues. Look for:

1. PAYOLA/PLUGOLA: Undisclosed commercial promotion. Flag if a host promotes a product, service, or business without disclosure. Do NOT flag: pledge drive fundraising, promoting KPFK station events, journalistic discussion of books/films/music, or interviews where guests mention their own work in context.

2. SPONSOR IDENTIFICATION: Segments that sound like sponsored or paid content without proper FCC disclosure (e.g. "This program is brought to you by..." or "Sponsored by...").

Return ONLY valid JSON. If no issues found, return empty flags array.
{
  "flags": [
    {
      "type": "payola_plugola" | "sponsor_id",
      "excerpt": "relevant quote from transcript (under 200 chars)",
      "details": "brief explanation of the concern",
      "severity": "warning"
    }
  ]
}
```

### Database

```sql
create table public.compliance_flags (
  id serial primary key,
  episode_id integer not null references episode_log(id) on delete cascade,
  flag_type text not null,           -- profanity | station_id_missing | technical | payola_plugola | sponsor_id
  severity text default 'warning',   -- info | warning | critical
  excerpt text,                      -- relevant text from transcript
  timestamp_seconds integer,         -- where in episode (from VTT)
  details text,                      -- explanation
  resolved boolean default false,
  resolved_by text,                  -- who reviewed it
  resolved_notes text,               -- "Reviewed — legitimate book discussion, not plugola"
  created_at timestamptz default now()
);
create index idx_compliance_episode on compliance_flags(episode_id);
create index idx_compliance_unresolved on compliance_flags(resolved) where resolved = false;

create table public.compliance_wordlist (
  id serial primary key,
  word text not null,
  severity text default 'critical',  -- warning (mild) | critical (FCC-actionable)
  active boolean default true,
  created_at timestamptz default now()
);
```

### Dashboard Integration

**Section 6.5 on the overview page — "Compliance" (between Attention Needed and Show Coverage Gaps):**
- Count of unresolved flags by type: "3 profanity · 1 payola/plugola · 2 missing station ID"
- Each count is clickable — links to episodes page filtered to that flag type
- Color coded: red badge for critical, amber for warning, gray for info
- When zero unresolved flags: "No compliance issues" in green

### Episode Detail Page Integration

- Compliance flags shown in a dedicated section below the transcript viewer
- Each flag shows: type badge, excerpt (highlighted), timestamp, details, severity
- Clicking a flag with a timestamp seeks the audio player and highlights the excerpt in the transcript viewer
- Resolve button on each flag → opens a small form: resolved_by (auto-filled), resolved_notes (text input)
- Resolved flags shown dimmed with strikethrough, collapsible
- "Run Compliance Check" button to re-run on this episode

### Settings Page Integration

**Compliance section on settings page:**
- Profanity word list CRUD (same pattern as transcript corrections table)
  - Columns: word, severity (dropdown: warning/critical), active toggle
  - Bulk import from CSV
  - Common seed words suggested on first setup
- AI compliance prompt (editable textarea)
- Toggle to enable/disable each check type individually
- Toggle to make compliance step blocking vs non-blocking for QIR eligibility

### Worker

**`workers/compliance.ts`:**
1. Get episodes where `status = 'summarized'`
2. Load transcript from `transcripts` table
3. Run rule-based checks (profanity scan, station ID check, technical check)
4. Run AI-assisted checks (single GPT-4o-mini call for payola + sponsor ID)
5. Insert any flags into `compliance_flags`
6. Update `episode_log.status = 'compliance_checked'`
7. Log usage to `usage_log`

**BullMQ chaining:** summarize completion → triggers compliance check (same pattern as other stage transitions)

### Component Decomposition

- `components/dashboard/compliance-summary.tsx` — overview page section
- `components/episodes/compliance-flags.tsx` — episode detail flags list
- `components/episodes/flag-resolve-form.tsx` — resolve dialog
- `components/settings/compliance-wordlist.tsx` — word list CRUD
- `components/settings/compliance-settings.tsx` — toggles and prompt editor
