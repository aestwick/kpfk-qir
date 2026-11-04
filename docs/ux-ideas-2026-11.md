# QIR UX ideas: November 2026

_Research date: Nov 4, 2026. Sources: walkthroughs of the running app as the GM, a producer or program director, and the compliance reviewer (real pages with fixtures from live data, desktop and iPhone 13); read-only queries of the live QIR database; a sweep of `ideas/`, `docs/`, the planning docs and the code. Docs only; no production code changed._

**Clickable mockups:** private claude.ai artifact at https://claude.ai/artifact/Wwww7LZJRN1FuJ6qi8Cqev (Ace can share it from its Share menu), and the same page in the repo at [`docs/ux-mockups/index.html`](ux-mockups/index.html), which opens in any browser. It has five views: Station desk, Flag triage, Filing record, Episode fix-up and Coverage story. Each has a Phone toggle. Screenshots of today's app are in [`docs/ux-mockups/screens/`](ux-mockups/screens/).

---

## For Ace: the short version

QIR does the hard part well. Every KPFK episode since Oct 1 has been transcribed, summarized and checked: 783 of 783. The trouble is the last step. The app doesn't tell anyone what needs a person, and it doesn't remember what people decided.

What the live data shows:

1. **The app can't say what's in the public file for Q3.** It was due Oct 10. Three drafts exist and none is marked final. Version 3 was exported twice on Oct 5, so it was probably uploaded by hand, but nothing records that. Only one report has ever been finalized in QIR (Q2, on Jul 4). **Please check the FCC public file for Q1 and Q3 today.** If Q3 isn't there, upload version 3 now; that needs no code.
2. **Almost no compliance review has happened.** Of 2,464 profanity and sponsor flags, people have decided 19. Most flags are noise. About 1 in 8 profanity flags is something that matters: a high-risk word aired between 6am and 10pm, outside the FCC's "safe harbor" hours. The app doesn't show which ones those are, and the overview says "2 active" because it only counts flags someone has already opened.
3. **Indecency isn't being checked at all.** The AI check only looks for sponsor and payola problems, so it has never raised an indecency flag. That's the bigger FCC exposure, and it's a small fix.
4. **Effectively one person uses QIR.** Almost every recorded action since June comes from the super-admin account, and nobody has signed in for weeks. Producers, the PD and a compliance reviewer don't have logins. That's why the deadline reminder ranks high: a screen nobody opens can't warn anyone.

**Engineering should fix these this week.** They're bugs, not design ideas, so this docs-only change doesn't fix them:
- **The compliance report page needs no login.** Anyone with the link `/compliance-report?station=kpfk` can see flags marked "investigating" or "violation". A small change to the link shows every flag (`app/compliance-report/page.tsx:51-79`).
- **Some screens stop counting at 1,000 rows.** That cut the Q3 v1 and v2 drafts down to July only. It also probably understates cost totals and compliance counts; October has 2,512 cost rows. Totals should be added up in the database. Confirm the database's row limit first.
- **Transcription has been paying full price.** The cheaper model has been the saved setting since March, but the workers ignored it until a code change today. October's ~865 hours of audio cost ~$96; at the cheaper rate they'd have cost ~$35. Check next week's transcripts to confirm the change took effect.
- **The sponsor and payola checks still run even though they were turned off on May 31.** They've made 868 flags since then.
- **Paused stations keep downloading new episodes.** WPFW, KPFT and KPFA have queued 1,493 since Jun 10.
- **"Public report" links for other stations open KPFK's report** (`downloads/page.tsx:135`, `page.tsx:821`).
- **The Download buttons fail** with "Missing bearer token" (`downloads/page.tsx:84`).
- **A test login was created in production today** (an `@example.com` viewer on KPFK, at 10:23 UTC). It didn't come from this research; it's probably from another session. Remove it once that session is done.

**What I'd build first:** a filing record that also checks the report before it's marked filed, indecency checking, a compliance inbox that opens on the flags that matter, and deadline emails.

**Decisions for you (no code):**
1. Which Q3 version was filed, and when? Check the FCC public file.
2. Who reviews compliance flags, and how often? Weekly, on the urgent tier only, is about 10 minutes.
3. Should the other Pacifica stations be processed this year? If not, stop their downloads.
4. Should producers get logins?
5. Should Spanish profanity count as urgent? The FCC rules apply in any language; the mockup counts English words only.

---

## How this was ranked

**Value** means hours saved, legal risk reduced, or trust gained. It's weighted toward work only a person can do: filing, compliance decisions, and catching wrong data. With one active user, **getting the data right comes before workflow polish.**

**Effort** assumes agent-assisted development:
- **S:** under a day.
- **M:** 1–3 days.
- **L:** a week or more.

An independent reviewer challenged the first draft. The changes it led to are listed under "Ranking review" at the end.

**Lanes:** other sessions own search and the new views (Broadcast Day, show coverage, guest/people, search → audio moment), the sidebar and page structure, names and vocabulary, and a bug sweep. Where an idea touches those lanes, it's written as a requirement for that session, not a redesign.

| Rank | Idea | Who benefits | Effort | Mockup |
|---|---|---|---|---|
| 1 | Filing record, with a readiness check and deadline awareness | GM, auditors, the public | M | 3 · Filing record |
| 2 | Indecency checking, with an honest "not checked" state | GM, compliance reviewer | S | 2 · Flag triage (banner) |
| 3 | Tiered compliance inbox, with the noise retired by rule | Compliance reviewer, GM | M | 2 · Flag triage |
| 4 | Deadline emails, then a weekly digest | GM, reviewer | S–M | — |
| 5 | Fast decisions: in-place listen, keys, reasons, real reviewer, sign-off | Compliance reviewer | M | 2 · Flag triage |
| 6 | Trustworthy numbers, and a pause that actually pauses | GM | M | 1 · Station desk |
| 7 | Station desk: "needs you" plus an all-station board | GM, super-admin | M | 1 · Station desk |
| 8 | Episode fix-up: one form, human and AI side by side | Producers, PD | M | 4 · Episode fix-up |
| 9 | "Is this in the report?" on episodes and shows | Producers, PD | S–M | 4 · Episode fix-up |
| 10 | Coverage story for board, donors and grants | GM, development | M | 5 · Coverage story |
| 11 | Grouping rebroadcasts, and rules for repeat lyrics | Compliance reviewer | M | 2 · Flag triage |
| 12 | Spelling corrections that fix stored transcripts | Producers | M | — |
| 13 | PD coverage matrix and quiet feeds | PD | M | — |
| 14 | Settings a non-coder can run | Station admins | M | — |
| 15 | Phone layouts for the four pages that matter | Everyone | L | all views (Phone toggle) |
| 16 | Role-aware screens and invitations | Producers, viewers | M | — |

---

## 1. Filing record, with a readiness check and deadline awareness (M)

**Problem**

| Evidence | Where |
|---|---|
| Q3 2026 has 3 drafts (29, 40 and 27 entries) and none is final | `qir_drafts` |
| Q1 2026 has 5 drafts and none is final | `qir_drafts` |
| There is no `filed`, `submitted` or `finalized_at/by` field anywhere | schema |
| Only one report has ever been finalized: KPFK Q2 v2, Jul 4. A Q2 v5 was generated on Aug 13, after the finalize | `qir_drafts` |
| "Last QIR filed: Q2 2026" sits in small print in the overview footer; nothing says Q3 has no filing on record | `screens/overview-today.jpg` |
| Generate opens on the empty current quarter, not the one that is due | `generate/page.tsx:285` |
| Each of the three Q3 drafts shows its own green Finalize button | `screens/generate-q3-today.jpg` |
| Finalizing a second version quietly demotes the first (one unique final per quarter), and the dialog doesn't say so | unique index on final drafts |
| Un-finalize has no confirmation and takes the public page down | Generate page |
| Entries stay editable through the API after a draft is final | `app/api/qir` |

**Proposal**
- **Add a "filed" state** after final, recording the version, the date it was placed in the file, where (the FCC Online Public Inspection File or the station's paper file), who recorded it, and a frozen copy (PDF or text and a hash).
- **Filing locks the version.** Later changes go into a new version labelled "amendment".
- **Show each quarter's state:** filed, final but not filed, drafts only, or in progress.
- **Let staff record a past filing** made outside the app, and never backdate it. Store "recorded Nov 4 by Ace; stated as placed in the file Oct 8" with a link to the public-file document, which has its own upload timestamp. This closes the gap for Q3, and for Q1 if it was filed.
- **Add a deadline banner** on the overview and Generate: "Q3 2026: no filing recorded; it was due Oct 10". After a quarter is filed, it switches to "Q4 due Jan 10 · 67 days".
- **Open Generate on the quarter that is due.**
- **Show draft history as a decision list.** List versions with a one-line difference from the previous one (entries, month spread, blank guests) and a "likely filed" hint when a version was exported. Show one Finalize button, on the selected version. The confirmation names the version and the public URL.
- **Add a per-station index of filed reports** on the public side (the spec existed; not built).

**Who benefits:** the GM (one screen answers "what did we file?"), a future auditor or FCC inquiry, and the public page, which then matches the file.

**The readiness check (merged in from a separate idea).** Today nothing stops or warns when finalizing a report built from part of the quarter or with unreviewed critical flags.
- Q2 was finalized at 69% processed.
- Its 48 entries are 32 from April, 14 from May and 2 from June.
- It has 10 blank guests, 6 blank hosts and a duplicate entry.
- Q3 v1 and v2 contain only July (the probable 1,000-row cap).

**Proposal:** a checklist on the version being finalized or filed. It shows:
- the month spread;
- processed share;
- failed episodes never retried (Q3 has 58, from Jul 21 to Aug 11, audio conversion);
- unreviewed Tier A and B flags;
- the entry count against the curation target;
- blank hosts and guests;
- duplicates.

Warnings, not blocks. "Retry" and "Catch up this quarter" buttons start the existing windowed backfill.

## 2. Indecency checking, with an honest "not checked" state (S)

**Problem.**
- **No indecency flag has ever been produced, and no AI profanity flag either.** The global `compliance_prompt` asks the model only for sponsor and payola problems.
- **The word list can't do this job.** Indecency depends on context (sexual or excretory descriptions, innuendo), not on single words.
- **It's the bigger FCC exposure.** Indecency is what the FCC has historically fined broadcasters for.
- **Zero flags looks like a clean result.** Today, "0 indecency" looks the same as "never checked".

**Proposal.**
- Add indecency and AI profanity to the compliance prompt. It's a global setting, edited by the super-admin, no deploy needed.
- Run it on the current quarter.
- Until it runs, show "Indecency: not checked" on the triage page and the station desk.
- Show on each episode which checks ran: word list, and AI with its model and date.

**Who benefits:** the GM, whose real legal risk is currently invisible.

## 3. Tiered compliance inbox, with the noise retired by rule (M)

**Problem.** These are KPFK numbers; no other station has flags.
- **Volume:** Q3 had 1,303 flags.
  - 792 profanity.
  - 480 sponsor/payola, from checks turned off on May 31. They're still about 40% of the inbox and are mostly correct underwriting credits ("Support for KPFK comes from…").
  - 31 technical.
- **Nothing is prioritized:** sort is hard-coded to newest first (`compliance/page.tsx:233`), though the API supports severity.
- **The term isn't shown:** the flagged word is never a column, and excerpts often don't contain it.
- **The time column is misleading:** "Time" is the offset into the file, not when it aired.
- **Severity mixes two things:** how bad the word is, and whether it aired in safe harbor. "Slut Walk", a news item, and a salsa singer named Kike both come up critical.
- **Stats only count triaged flags:** the stat cards and Show Health show "Profanity 2 active", so the dashboard reads as all clear while 148 critical Q3 flags sit untouched.
- **Screens:** `screens/compliance-inbox-today.jpg`, `screens/compliance-grid-today.jpg`.

**Proposal.** Four tiers, computed from what aired when, and kept separate from the station's word severity.

| Tier | Rule | Q3 | Q4 so far |
|---|---|---|---|
| **A · Listen now** | Restricted hours (6am–10pm) and an high-risk word (the f- and s-word families and a short list drawn from FCC enforcement history) | 100 (83 episodes, 35 shows) | 43 |
| **B · Glance** | Restricted hours, any other listed word (slurs, Spanish, the n-word variants) | 97 | 43 |
| **C · Safe harbor** | Aired 10pm–6am; acknowledged in bulk and kept in the log | 469 | 187 |
| **D · Retire** | Flags from checks that are off, already-fixed word-boundary errors, technical | 637 | 276 |

- **Land on Tier A** for the current quarter. The overview's compliance number becomes "open Tier A".
- **Store** the term, the local air clock and safe-harbor status as columns. Show the term as a chip and centre the excerpt on it.
- **Retire Tier D in one click** (sponsor and payola flags from checks that are off: 703 now), and acknowledge Tier C automatically as "safe harbor, logged".
- **Wording matters.** The FCC publishes no list of banned words, and context decides: news coverage and fleeting use are treated differently. So the app should say "high-risk word", never "FCC-profane", and a person makes the call.
- **Spanish:** the FCC rules apply in any language, so daytime Spanish high-risk words (e.g. *puta*, *verga*) probably belong in Tier A, not B. That's the reviewer's decision; the counts here use English only.
- **Safe harbor (10pm–6am) protects indecent and profane speech, not obscene speech.** Tier C is low-risk, not no-risk.
- **Music is not the safe bucket:** 57 of the 100 Tier A flags in Q3 are unedited lyrics in daytime and evening music shows (East Side Story Radio, Fri 8pm, alone has 18). Lyrics are only low-risk in safe harbor, which is where most of Tier C lives. So "this is a music show" mustn't automatically clear a flag.

**Who benefits:** the reviewer gets an achievable queue: about 45 minutes for Q4's Tier A to date. The GM gets a true answer to "could we be fined for anything?".

## 4. Deadline emails, then a weekly digest (S–M)

**Problem:** nothing reaches anyone outside the app.
- Email was chosen, then deferred.
- The "station has gone dark" alert is an in-page banner on Master Control.

**Proposal:**
- **Deadline emails** on the last day of the quarter, then 5 days and 2 days before the deadline.
- **A Monday digest:** the "Needs you" list from idea 7, by email.

This ranks high because the Q3 problem was nobody looking: the super-admin's last sign-in was Aug 7. A banner can't reach someone who never opens the app. Deadline emails alone are S; the digest adds a bit more.

## 5. Fast decisions with a record that would hold up (M)

**Problem**
- **About 60 seconds and 5 clicks per flag.** It's a full page load, and the player sits below the flags. Clearing Q3's open profanity flags would take about 11 hours; Tier A alone, about 1.7 hours, even with today's screens.
- **"Listen" lands on the wrong moment about 12% of the time.** The timestamp lookup matches substrings (`workers/compliance.ts:178-181`); one "bitch" jump lands on a different song 5 minutes away.
- **Every decision is recorded as reviewer `'dashboard'`** (5 places). No review date is kept, and reasons are optional.
- **There's no quarter sign-off.**
- **The "investigating" status has never been used.**

**Proposal**
- **Play in place:** a player opens on the row and plays from 15 seconds before the word.
- **Keyboard flow:** J/K to move, 1–4 to decide (not what aired, newsworthy or quoted, fine in context, violation).
- **Required reason codes, the signed-in reviewer, and a review date.** Record whether the audio was played.
- **A quarterly sign-off** once Tiers A and B are empty: who, when and counts per tier. It's attached to the filing record (idea 1) and shown on the compliance report.
- **Fix the timestamp matcher** to use the boundary-aware word pattern already in `lib/compliance-match.ts`.

**Target:** 15–20 seconds per flag, and about one hour per quarter.

## 6. Trustworthy numbers, and a pause that actually pauses (M)

**Problem.** The overview shows signals that are wrong (`screens/overview-today.jpg`):

| Signal | Why it's wrong | Where |
|---|---|---|
| "11 of 8 categories covered" | counts `SKIP` and off-list labels | `app/api/dashboard/route.ts:355` |
| "Show coverage gaps" lists 114 shows, including Democracy Now!, which aired today | matches on feed key instead of `show_group` | `route.ts:350` |
| Footer reads "Workers: idle" in red and "Last ingest: never" during normal operation | | `page.tsx:794-816` |
| The quality-flag check never fires | compares duration in minutes to 1800 | `route.ts:219` |
| The Usage page leaves out Deepgram and AssemblyAI | | Usage page |
| Cost totals are likely capped at 1,000 rows | see "Engineering should fix these this week" | |
| A station's own users see "running" when only that station is paused | the pause indicator reads only the global flag | overview |
| Cost is visible only to super-admins | | Usage page |

**Proposal**
- Fix each of the signals above.
- Aggregate costs in SQL.
- Add a GM cost line: "Last month $97.81 (Sep $112.89, −13%) · ≈$0.13 per episode".
- Add This month / Last month / This quarter presets and a 6-month bar.
- Split cost into "transcription" vs "AI writing" instead of vendor names.
- Let a station admin see their own station's cost.
- Also update `CLAUDE.md`: "a few dollars per quarter" is now about $100 a month.
- **Paused stations stop downloading new episodes,** or are shown honestly as "downloading only" (an S fix on its own).

## 7. Station desk (M)

_Build this after idea 6. Its main inputs are the numbers idea 6 fixes._

**Problem.** The GM's "is everything OK?" takes two screens and still misses:
- **Q3 overdue:** shown only in the footer.
- **Stranded Q1 and Q2:** 1,302 KPFK episodes that aired before July are stuck behind the current-quarter gate. Q1 is 36% processed and Q2 69%. Q2 was finalized at 69%.
- **Paused stations piling up:** WPFW, KPFT and KPFA, paused since Jun 10, kept ingesting 784, 437 and 272 episodes.
- **Spend anomalies:** nothing surfaces them.

The overview leads with operator buttons (Pause, Ingest, Transcribe…), and Pause stops every station with no confirmation. Master Control puts about 1,300 px of spend-cap inputs before any station on a phone.

**Proposal**
- **A "Needs you" list** at the top, of at most 5 items, each with one action. It's built from:
  - filing status;
  - open Tier A flags;
  - paused stations with growing backlogs;
  - stranded earlier quarters;
  - spend anomalies.
- **One row per station:** running or paused (and for how long), what's waiting (and how much arrived since the pause), this quarter's progress, last filing, Tier A count, and month's spend against its cap.
- **Operator controls move into a collapsed panel,** and Pause asks for confirmation.
- The pause fix itself is in idea 6.

## 8. Episode fix-up: one form, human and AI side by side (M)

**Problem.** On BradCast, Oct 30, 2026 (`screens/episode-detail-today.jpg`):
- **The producer's Confessor summary goes into the report as-is,** including "Original airdate 10-20-2026" and promo copy.
- **Only the active copy is shown;** the other is hidden in a tooltip (`episodes/[id]/page.tsx:282`).
- **Two save models on one page:** host and guest save on blur, while summary and category need a button. Both fail silently (`:143-162`, `:493-502`).
- **The headline can't be edited anywhere,** even when it misspells a guest.
- **Issue categories are hard-coded here** (`:90-99`) but come from settings on the list page.
- **The discrepancy banner reads "listed as Oct 20 … indicates Oct 20".**
- **Every English episode offers a paid Translate toggle,** because the code checks for `"en"` and the data says `"English"` (`:693`).

**Proposal**
- **One "What goes in the report" form** with one Save, a dirty state and error messages.
- **The producer's and the AI's version side by side,** with a "use this" choice per field and "type my own". A choice holds through re-processing (the existing pin), and the pin is shown.
- **An editable headline.**
- **Lint the human summary** for rerun notes, HTML entities and repeated boilerplate.
- **Replace the discrepancy banner** with "Rerun of Oct 20".
- **Hide edit controls from viewers.**

Name spelling itself belongs to the names session; this form is where the fix shows.

## 9. "Is this in the report?" (S–M)

**Problem:** a producer can't tell whether their segment made the QIR without opening Generate and scanning entries.

**Proposal:** a chip on the episode and the show page, such as "In Q4 draft v2 under Civil Rights". When an episode is left out, it says why:
- not chosen by curation;
- held by an unreviewed critical flag (the hold is recorded nowhere today);
- duplicate airing;
- tagged "skip".

## 10. Coverage story for board, donors and grants (M)

**Problem:** "How many hours did we air on immigration, housing or health?" can't be answered anywhere in the app. Q3 from the database:

| Issue | Hours |
|---|---|
| Government / Politics | 571 |
| Arts & Culture | 524 |
| Civil Rights | 386 |
| International | 230 |
| Economy / Labor | 83 |
| Health | 76 |
| Environment | 70 |
| Immigration | 49 (about 2% of the quarter, in Los Angeles) |

Housing isn't a category; a keyword search finds about 55 hours. Some AI tags would embarrass a board deck: a DNA episode tagged Health, and a football segment tagged Immigration.

**Proposal**
- **A per-quarter "What we covered" page:** hours, episodes and shows per issue.
- **A topic box** (e.g. "housing") that totals hours by keyword.
- **Three example segments per issue**, with a link to listen.
- **A ready-made paragraph**, and a Copy button and CSV.
- **It reads processed episodes,** so it works mid-quarter.
- **A reviewer pass on tags** before anything goes to a funder. Ship the page only with that pass in place.

This is also KPFK's clearest internal signal of thin coverage areas for programming decisions.

## 11. Grouping rebroadcasts, and rules for repeat lyrics (M)

_Retiring the noise by rule is now part of idea 3. This idea covers the rest._

**Problem**
- The same lyric re-flags every airing.
- Bulk select covers one page of 50.
- The same news segment flagged on Democracy Now! at 7am and again on its 5pm rebroadcast needs two decisions.

**Proposal**
- **Rules:** "Dismiss all *term* on *show* [in safe harbor] [this quarter or always]", with a reason. A rule applies to existing matches on the server and auto-closes future ones, each linking back to its rule.
- **Group repeats:** flags with the same excerpt within a few days are grouped as "aired twice", and one decision covers both.
- **"Select all N matching"** instead of one page of 50.

## 12. Spelling corrections that fix what people see (M)

**Problem:**
- Saving a correction says "Re-transcribe to apply" (`:1085`), which is paid, overwrites the transcript, and never touches guest, host or headline.
- The form is built around regex.
- Producers send fixes out-of-band, and they get entered by script.
- One frequent guest appears under 4 spellings: 6 of 19 mentions are right.

**Proposal:**
- An "Apply to existing transcripts" action, run over stored text at no API cost, with a preview ("37 matches in 12 episodes").
- A "spelling variants" input instead of regex.
- A scope column: this episode, this show, or the station.
- Coordinate with the names session, which owns the transcription side.

## 13. PD coverage matrix and quiet feeds (M)

**Problem:**
- 118 of 225 active shows have zero episodes this quarter, mostly duplicate feeds imported active.
- BradCast exists as 3 feeds under 3 names.
- Show Audit presets are months, not quarters (`shows/audit/page.tsx:416`).
- "Issues covered" totals across shows instead of comparing them.

**Proposal:**
- Show groups × issue categories, with episode counts and a "no public-affairs issue" column.
- A "Quiet feeds" list with Deactivate and Merge into group.
- Quarter presets.

The show-coverage view is another session's lane. This is the requirement list for it.

## 14. Settings a non-coder can run (M)

**Problem:**
- 6 tabs, about 40 station-level controls, and a show grid of about 2,000 cells.
- Four ways to turn a show off: Active, Exclude, Archive, and a JSON "Excluded show keys" field on another tab.
- Three fields are raw JSON (`settings/page.tsx:74-76`).
- Nothing shows whether a value is the station's own or inherited from the network default.
- The tab isn't kept in the URL, and there's no search.
- Compliance rules are edited in two places.
- Four settings have no UI at all (e.g. `verify_prompt`).

**Proposal:**
- One per-show state: Processing, Paused or Archived.
- Chip lists instead of JSON.
- Task-ordered tabs: Shows · Names & spellings · Issue categories · Compliance · Advanced.
- An "inherited from network default" marker with "override" and "reset".
- A settings search.

Page placement belongs to the navigation session.

## 15. Phone layouts (L)

**Problem.** Only the sidebar is responsive. Nine pages, including Episodes, scroll sideways:
- the Overview is about 7 screens long;
- Generate's buttons are cut off;
- the compliance table hides its actions off-screen and is about 3,600 px tall;
- text selection for corrections is mouse-only (`episode-media.tsx:191`).

See `screens/phone-*.jpg`.

**Proposal:** card layouts on these four pages, in order:
1. Station desk.
2. Flag triage, where swipe to dismiss turns Tier B and C into a commute task.
3. Filing record.
4. Episode.

Every mockup view has a Phone toggle showing the intended layout.

## 16. Role-aware screens and invitations (M)

**Problem:**
- 2 accounts exist; 1 has ever acted.
- Viewers see edit controls whose saves fail.
- Cost is super-admin only.

**Proposal:**
- Hide or disable edits by role.
- Add a simple "invite a producer to their show" flow.

Depends on Ace's decision about who gets logins. It's M, not S, because invitations need email, which doesn't exist yet.

---

## Also worth fixing (small, found along the way)

| Problem | Where |
|---|---|
| Jobs page labels the compliance stage "Generate QIR" | `jobs/page.tsx:48` |
| Pressing `r` on the episode list opens "retry all failed" | episode list |
| 40 Q4 episodes are tagged `SKIP`, and the UI shows and filters on it as if it were an issue | episode list |
| Off-list categories ("Education") leak in | episode list |
| Discovery imports many duplicate feeds as active | discovery |
| The `archived` status covers 1,946 rows under a `pra` key that isn't in `show_keys` | `episode_log` |
| The documented `failed` status doesn't occur in the data; real end states are `dead`, `unavailable`, `transcript_missing` and `archived` | `episode_log` |
| `app/components/dashboard-charts.tsx`, including a spend sparkline, is built but never imported | — |
| Several spec status lines are wrong: the compliance grid and audit log specs say "not built" but shipped | specs |

## Requirements for other sessions' views

These are notes for the other sessions' views, not redesigns.
- **Search → audio moment:** use caption timestamps. A hit seeks the player, and "Copy link at 12:31" uses the existing `?seek=` parameter.
- **Broadcast Day:** show compliance tier chips and the "in report?" chip inline.
- **Guest and people views:** show every spelling a name has appeared under, and let a fix flow into the corrections from idea 12.

## Ranking review

An independent reviewer read the first draft, checked the evidence, and spot-checked the numbers against the live database.

**Numbers confirmed:**
- 1,303 Q3 flags
- 19 human decisions
- 1,302 stranded pending episodes
- 1,493 pending since the pause
- Q3 drafts of 29, 40 and 27 entries
- October's $97.81

**Corrections made in this version:**
- Sponsor and payola flags created since the checks were turned off: 868, not 811.
- Q2's entry spread includes May (32 · 14 · 2).
- "8% of flags" is restated as about 1 in 8 *profanity* flags. Sponsor noise inflated the total.
- "20 hours → 1 hour" now compares like with like: open profanity takes 11 h today, Tier A 1.7 h, and about 1 h with the fixes.
- "Late" is replaced with "no filing recorded" until someone checks the public file.
- The transcription overspend is restated: ~$96 actual vs ~$35 at the cheaper rate.
- A test login created today means "one person" is now "effectively one person".

**Ranking changes:**
- Indecency checking went from a footnote to #2: it's the bigger legal exposure, and the fix is small.
- Deadline emails rose from #15 to #4.
- The readiness check was merged into the filing record.
- Retiring flags by rule was merged into the inbox.
- The station desk dropped below "trustworthy numbers", because it would display those numbers.
- The 1,000-row cap and the public compliance page went to the top of the fix-now list.

**Effort changes:**
- Filing record: S–M → M.
- Fast decisions: S–M → M.
- Trustworthy numbers: S–M → M.
- Invitations: S → M (no email yet).
- Phone layouts: M → L.

**Wording changes for FCC accuracy:**
- "High-risk word" instead of "FCC-profane".
- Safe harbor doesn't cover obscenity.
- Spanish profanity counts.
- Past filings are recorded with the date they were recorded, never backdated.
