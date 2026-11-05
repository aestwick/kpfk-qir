# Dashboard navigation proposal

_Status: built on branch `claude/qir-navigation`. Owner: Ace (KPFK GM). Reviewed by an independent critique pass before building; its changes are folded in below._

## The problem in one paragraph

The sidebar is a flat list of 15 links in the order the pages were built, not the
order people work. The most important job of the quarter (building the FCC
report) is item 12, below the fold on a phone. Four links use words nobody
outside the code would use: "Jobs", "Master Control", "Activity" and "Show
Audit" (which has nothing to do with the "Audit Log"). Several common questions
have no home at all: what aired on a given day, when a guest was last on, a
list of our shows, and when the FCC report is due. Everyone sees nearly the same
menu, so producers and the compliance reviewer get 11 links, about half of which
they will never use. The menu's labels were written out three times in the code:
the sidebar, the breadcrumbs, and the "← back to" links.

## How we audited

- **Inventory:** every route under `app/dashboard`, the public pages, who can see
  each page versus who can actually use it, inbound links, URL parameters, the
  station switcher, and phone layout.
- **Four walkthroughs:** each persona's top tasks were walked through the running
  app (login mocked, real page code), counting clicks and dead ends. There were
  screenshots for every step. The people: the GM, the program director and
  producers, the compliance reviewer, and ops/super-admin.

### What the walkthroughs found (headline items)

| Who | Task | Today | Problem |
|---|---|---|---|
| GM | Is everything healthy? | 1–3 clicks across Overview, Jobs, Master Control | Three pages sound like "health". |
| GM | File the QIR | 7–8 clicks | No deadline anywhere. The picker defaults to the quarter still in progress. Item 12 in the menu. |
| GM / producer | What aired yesterday afternoon? | 3–4 clicks plus scrolling | No home. "Activity" and the "Broadcast Log" card look right but are processing logs. |
| GM / producer | When was guest X on? | No real path | Searching transcripts finds mentions, not guest appearances. |
| Producer | Everything my show aired | 3 clicks plus typing | No "Shows" in the menu. The show page is reachable only by clicking a show name in a table. |
| Producer | What my show covered | About 7 clicks | The answer is hidden in "Show Audit", whose name suggests policing. |
| Compliance | What's waiting for me? | 1–2 clicks, guessing | No count on the landing page or in the menu. |
| Compliance | Flags by time slot | 2–3 clicks | The grid is not in the menu, only a small "Grid" button. |
| Ops | Who changed X? | 3–4 clicks | Users click "Activity" first, but it has no "who". |
| Ops | Add a member (station admin) | Hidden | It lives in the Settings → Members tab, which has no link and no URL. |
| All | Phone | Drawer of 15 items | Generate QIR, Downloads, API Keys and Settings are below the fold. |

The walkthroughs also turned up bugs outside navigation: Downloads buttons fail
with 401, the public-report links always open KPFK, an editor's Pause button
pauses every station, two paid actions have no role check, and compliance
blocking is invisible on Generate. These were filed as separate tasks so this
change stays about structure.

## The new menu (as built)

Plain-language names, grouped by job, and each person sees only what they can use.

```
Home                                   (everyone)
[ Q3 2026 FCC report · due Oct 10 ]    ← filing-deadline chip

PROGRAMMING
  Episodes                             (everyone)
  Shows                    NEW page    (everyone)  list of our shows → each show's page
  Broadcast day            reserved    (everyone)  hidden until the search session ships it
  Show coverage            reserved    (everyone)        "
  Guests & people          reserved    (everyone)        "
  Search transcripts                   (everyone)
  Show check-up            was "Show Audit"    (everyone)
  Downloads                            (everyone)

FCC REPORT
  Quarterly report         was "Generate QIR"  (everyone)

COMPLIANCE
  Review flags       (69)  was "Compliance"; badge = this quarter's unreviewed serious flags
  Flags by time slot       was a hidden "Grid" button

STATION SETTINGS
  Settings                             (editor+)
  Station members          was a hidden Settings tab  (station admin+)
  API keys                             (station admin+)

BEHIND THE SCENES  ▸ collapsed unless you're on one of these pages
  Processing queue         was "Jobs"          (editor+)
  Processing log           was "Activity"      (editor+)
  All stations             was "Master Control" (super-admin) · all stations
  AI costs                 was "Usage"          (super-admin)
  All users                was "Users"          (super-admin) · all stations
  Change history           was "Audit Log"      (super-admin) · all stations
```

### What each person sees

| Person | Before | After |
|---|---|---|
| Viewer (e.g. a board member) | 11 flat links | 9 links in 4 groups |
| Producer / editor | 11 flat links | 12 links, with Settings and "Behind the scenes" kept apart |
| Station admin | 11 flat links; Members hidden in a tab | Same as editor, plus Station members and API keys |
| Super-admin (Ace, ops) | 15 flat links | Everything, with ops pages tucked into a collapsed group |

Hiding a link is a convenience, not security. Every page and API still checks
permissions on the server, exactly as before. Some pages can still be read by
roles that don't see their link: a viewer can still open `/dashboard/jobs`
directly.

### Decisions and why

- **Groups follow the work, not the database.**
  - Programming answers "what did we air".
  - FCC report is the quarterly filing.
  - Compliance is the reviewer's inbox.
  - Settings and "Behind the scenes" are for the people who run the system.
- **"Behind the scenes" starts collapsed.** Ace, producers and the reviewer
  rarely need it. Ops opens it once and it stays open (the browser remembers).
  It also opens by itself on any of its pages, including when Home links you
  there.
- **Pages were renamed, not moved.** Every existing URL still works, so bookmarks,
  filed FCC links and other sessions' work are safe, and no redirects are needed.
  Three small additions:
  - a new `/dashboard/shows` list page;
  - Settings tabs can be opened by URL (`/dashboard/settings?tab=members`), so a
    reload or station switch keeps your tab;
  - the report builder accepts `?quarter=2026-Q3`.

  Page headings were renamed to match the menu ("Jobs" became "Processing queue",
  "QIR Builder" became "Quarterly report", and so on). The exceptions are
  Search, Episodes and Compliance, which other sessions own.
- **Filing-deadline chip.**
  - **The rule:** the FCC quarterly issues/programs list is due in the public
    file by the 10th of the month after the quarter ends (Jan 10, Apr 10, Jul 10,
    Oct 10). It's calculated in the *station's* time zone.
  - **What it shows** is always about the quarter that just ended:
    - **"Q3 2026 FCC report · Due Oct 10 · not finalized yet"** (amber) until the
      report is finalized.
    - **"Not finalized here — was due Oct 10"** (red) once the 10th has passed.
    - **"✓ Q3 2026 report finalized · Next: Q4 due Jan 10"** once it is
      finalized, plus a link to the public page that goes in the file.
  - **Why it says "finalized", not "filed":** finalizing happens in this app.
    Uploading to the FCC's online public file is still done by hand.
  - **The link:** clicking the chip opens the report builder on the right
    quarter. Before, the builder opened on the quarter still in progress.
  - **As of today (Nov 4, 2026), KPFK's Q3 2026 report has three drafts and no
    finalized version**, so the chip shows red for KPFK. If Q3 was filed some
    other way, finalizing the draft in the app clears it.
- **Compliance badge.** The count on "Review flags" is **serious (critical) flags
  from this quarter that nobody has reviewed yet**: 69 at KPFK today. Those are
  the flags that can hold episodes out of the report. The all-time backlog of
  every severity is 2,084 at KPFK, so a badge counting that would just read
  "99+" forever and be ignored.
- **The highlighted menu item follows where you came from.** Open an episode from
  a flag and "Review flags" stays highlighted, not "Episodes". The same goes for
  Shows, Search and Processing log.
- **One definition.** The menu, the breadcrumbs ("Home / Review flags / Flags by
  time slot"), the "← back to …" links on episode pages and the phone header all
  read from `lib/nav.ts`. Before, there were three hand-kept copies.
- **The station is always named.** People with one station now see its name;
  before, it only appeared for people with two or more. Network-wide pages are
  tagged "all stations". Switching station while on an episode now lands you on
  Episodes, because that episode belongs to the old station and would show "not
  found".
- **Phone.**
  - The drawer is grouped and shorter.
  - Escape or a tap on the backdrop closes it, and the page behind no longer
    scrolls.
  - The top bar shows the current page and station, not just "QIR".

### Reserved slots for the search session

The search session (`claude/qir-search-views`) is building Broadcast Day, Show
Coverage, Guests/People and better search. Their menu entries already exist in
`lib/nav.ts`, marked `reserved: true`, and stay hidden. **Follow-up for that
PR:** delete `reserved: true` on each slot whose page ships, and fix its `href`
if the route differs from the placeholder below. That's a one-line change per
slot, with no other edits.

An earlier draft hid each slot until a quick "does this page exist yet?" check
in the browser passed. A reviewer pointed out that check would be fragile and
would add a request on every visit, so it was dropped.

| Slot | Placeholder route |
|---|---|
| Broadcast day | `/dashboard/broadcast-day` |
| Show coverage | `/dashboard/coverage` |
| Guests & people | `/dashboard/people` |

### Before → after, task by task

| Who | Task | Before | After |
|---|---|---|---|
| GM | Is everything healthy? | Overview → maybe Jobs → maybe Master Control | Home. Ops detail sits under "Behind the scenes". |
| GM | File the QIR | Find item 12 → change quarter → generate → finalize (7–8 clicks) | Deadline chip (right quarter preselected) → generate → finalize (4–5 clicks) |
| GM | Latest finalized report | Hunt for the Overview footer link | Chip says "✓ finalized" with a link to the public page |
| GM / PD | What aired yesterday? | No home | Programming → Broadcast day (once shipped). Until then, Episodes sorted by air date. |
| PD | Everything my show aired | Episodes → type → click name | Programming → Shows → the show (2 clicks) |
| PD | What my show covered | Find "Show Audit" (about 7 clicks) | Programming → Show coverage (once shipped). Show check-up in the meantime, now visible to every role. |
| PD | Guest last on | No home | Programming → Guests & people (once shipped) |
| PD | Activate a show | Settings → find the Shows tab | Shows → "Manage tracked shows" (links to `settings?tab=shows`) |
| Compliance | What's waiting? | Guess Compliance | Badge on "Review flags", visible from every page |
| Compliance | Flags by time slot | Find the "Grid" button | Compliance → Flags by time slot (1 click) |
| Compliance | Back from an episode | Menu highlights "Episodes" | Menu keeps "Review flags" highlighted, and the back link is unchanged |
| Ops | Who changed X? | Activity (wrong) → Audit Log | Behind the scenes → Change history. "Processing log" no longer sounds like an audit. |
| Admin | Add a member | Settings → spot the Members tab | Station settings → Station members (1 click) |
| Ops | Spend this month | Usage | Behind the scenes → AI costs |
| Anyone (phone) | Reach the report | Scroll the drawer | In the first screen of the drawer |

## Known limits

- The Shows list groups a show that airs on several feeds into one row (by
  `show_group`). Its link opens the existing show page, which still lists one
  feed. The search session's Show coverage view is the better destination once
  it ships.
- The chip and badge are per active station. Master Control doesn't yet have a
  per-station "report finalized?" column.

## Not in this change (deliberately)

- Page internals owned by other sessions: Search, the Episodes list, Compliance
  and transcription.
- Bugs the walkthroughs found, each filed as its own task:
  - Downloads buttons fail with 401, and the public-report links ignore the
    selected station.
  - Any editor's Pause button pauses every station.
  - Two paid actions (Show check-up processing, translate) have no role check.
  - Compliance blocking is invisible on the report page.
- Merging the duplicate pages (Jobs + Master Control, the Settings → Compliance
  tab + the Compliance page's rules panel, Users + Station members). Each is a
  real merge with behaviour changes. They sit next to each other in the new menu
  so a later merge is a small step.
- A different landing page per role. Everyone still lands on Home. Once the
  search session's pages ship, producers may be better served by Broadcast day.
  Revisit after.
