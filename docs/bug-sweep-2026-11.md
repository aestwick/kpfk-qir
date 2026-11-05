# QIR bug sweep: November 2026

**Swept:** 2026-11-04, against `main` at `2149704` (just after PR #166).
**Method:** six parallel hunters, one per area. An independent verifier then tried to refute each finding against the code and the live database (Supabase `czjhwhfqohpmwprhasve`, read-only SELECTs). Everything below survived verification; where a verifier corrected a detail, the corrected version is the one written here.
**Live API spend for this sweep:** $0. No Groq or OpenAI calls were made.

This file covers the bugs that were **not fixed** in the PR, because the fix would change stored data, permissions/RLS/station isolation, or compliance or report logic. Each one needs a decision. The fixed items are listed at the end.

They are ranked by who gets hurt: the FCC public file and the GM first, then the compliance reviewer, then producers.

---

## 1. CRITICAL: parts of the database are writable by anyone holding the public key

> **Status (2026-11-05): fix written: migration `053_lockdown_public_exposure.sql`. Not yet applied; it applies at the next deploy.** A dependency check against live query stats found two legitimate public-key readers on the public website: the episode player (`aestwick/cms` `snippets/886_episode-player.html`, ~41k calls) and the show-tag chips (`snippets/891_show-tags`). Both are kept working. The player now sees only *published* episodes and only the 6 columns it asks for. The ownership note below is corrected: `contacts`, `tags` and the rest belong to neither QIR nor the current CMS code; the public site's snippets are their only users.

**What's wrong.** The site ships a public "anon" Supabase key to every browser, which is normal; Supabase relies on row-level security (RLS) to make that safe. Live, the following are unsafe:

- **`qir_settings` has RLS turned off**, and the anon role has full INSERT/UPDATE/DELETE/TRUNCATE. This table holds every station's default prompts (summarization, curation, compliance), `compliance_blocking`, `pipeline_paused`, and the spend ceilings. Anyone who copies the key out of the site's JavaScript could:
  - rewrite what goes into the FCC report,
  - turn off compliance blocking,
  - stop the pipeline,
  - or wipe the table.
- **`schema_migrations`** (QIR's own migration tracker) has the same problem. Deleting a row makes the next deploy re-run that migration.
- **`episode_log` has a stray policy, "Public read access", `USING (true)`.** It is not in any repo migration, so someone added it by hand. Because policies are OR'd together, it cancels the per-station rule: anyone with the anon key, and every signed-in user of every station, can read every station's episodes. That includes unreviewed AI summaries, compliance results and error text.
- The old zero-argument `get_episode_counts_by_show()` RPC is still live and granted to anon. Combined with the policy above, it returns cross-station counts. The station-aware version (migration 016) is the only one the app calls.
- **Not QIR's tables, same database:** `contacts` (26 rows of names, emails and phones), `show_contacts`, `tags`, `show_tags` and `show_page_generations` also have RLS off with anon write. They look like the CMS's tables; their owner should know.

**Evidence.**
- `pg_class.relrowsecurity = false` on those tables.
- `information_schema.role_table_grants` shows anon with full write grants.
- `pg_policies` shows `episode_log."Public read access"` qual `true`.

**Dependencies checked.** Nothing in this repo reads `qir_settings` or `episode_log` through the browser client; every access goes through the service role or the request-scoped client. The browser client only touches `super_admins`, `stations` and `station_users`. The sibling CMS and podcast apps share this database and were **not** checked.

**Proposed fix: one small migration.**
1. `alter table qir_settings enable row level security` plus a super-admin read policy. Workers use the service role, so they are unaffected.
2. The same for `schema_migrations`, with no policies at all (service role only).
3. `drop policy "Public read access" on episode_log`.
4. `drop function get_episode_counts_by_show()` (the no-argument overload).

Before step 3, confirm that no CMS or podcast code reads `episode_log` with the anon key. **Effort:** about an hour plus that check. **Recommend applying this week.**

## 2. HIGH: role checks exist only in the app; the database lets any member write

> **Status (2026-11-05): fix written.**
> - Migration `054_role_aware_write_policies.sql` requires editor to write; spend caps are super-admin only and the station pause flag can't be written directly (station editors pause/resume their own station from the Jobs page, per #171); `usage_log` is service-role only.
> - App guards: the Jobs-page and route fixes landed in #171 (station-scoped pause, a super-admin pause-all, station-scoped clear/retry and job list, editor on translate and audit-reprocess); this PR adds the settings 403 for pause and cap keys.

**What's wrong.** The app enforces viewer/editor/admin in `lib/auth.ts#requireRole`. The RLS write policies only check *membership*: `episode_log_write`, `qir_drafts_write`, `compliance_flags_write`, `transcripts_write`, `station_settings_write`, `usage_log_write`, `wordlist_write_station` and `show_keys_write`. A **viewer** (there are 2 live) can call PostgREST directly with their own login token and:
- set a draft to `status='final'` or rewrite its entries. It then shows on the public FCC page through `qir_drafts_public_final`.
- dismiss critical compliance flags.
- change their station's spend cap or un-pause it.
- delete `usage_log` cost rows.

**The app layer has gaps of its own:**
- **`PUT /api/settings`** (`app/api/settings/route.ts:94,131`) lets any **editor** write *any* key for their station. That includes `pipeline_paused` (all four parked stations are paused this way) and `spend_limit_monthly` / `spend_limit_quarterly` (the $2 caps a super-admin set). Only the three compliance keys are protected.
- **`POST /api/jobs`** (`app/api/jobs/route.ts:15-69`) is editor-gated, but:
  - `pause_pipeline`, `resume_pipeline` and `set_pipeline_mode` flip the **global** flag, so a WPFW editor can pause KPFK.
  - `clear_failed` and `retry_failed` act on every station's failed jobs.
- **`GET /api/jobs`** returns every station's job payloads and error text to any member.

**Proposed fix.**
- Add a role check (`>= editor`, or admin for settings) to the write policies, or revoke direct table writes from `authenticated`, since every legitimate write goes through an API route.
- Settings: a key allowlist with tiers; `pipeline_paused` and `spend_limit_*` become super-admin only.
- Jobs: global pause and mode become super-admin only; station users get the per-station pause; clear/retry/GET filter on `job.data.stationId`.

**Effort:** M (migration plus route changes plus testing).

## 3. HIGH (FCC): KPFT's HD3 shows are logged two hours early

**What's wrong.** Ingest converts every station's times to **Pacific** (`toPacificDate` / `computeEnd` hard-code `America/Los_Angeles` in `workers/ingest.ts:20-64`). `stations.timezone` is never read. Correct times only come from the MP3 filename override, and that regex (`lib/parse-mp3-url.ts:15`) fails in two cases:
- the file prefix is a variant: KPFT HD3 files are `kpfthd3_…` but the prefix is `kpft`;
- the show key has digits or underscores (`ragradio2`, `bts_friday`, `gv_derek`). The pattern is `[a-zA-Z]+`.

**Evidence.**
- **All 139 of 139** KPFT `kpfthd3_` episodes have `air_start` exactly 2 hours before the time in the filename. 25 are already published. Example: id 5976, `kpfthd3_260627_160000quantum.mp3`, is stored as 14:00.
- No KPFT draft exists yet, so nothing wrong has been filed.
- KPFK is unaffected today: it uses Confessor `def_time`, and on RSS fallback Pacific is correct for KPFK (0 of 108 differ).
- WPFW is only safe because its filenames happen to parse.

**Other callers of the same parser:**
- "Fix dates" (`app/api/episodes/[id]/route.ts`; the bulk version in `app/api/episodes/route.ts`, search lane) returns 400 on those files.
- `scripts/backfill-quarter.ts` rejects them.

**Proposed fix.**
- Pass the station's timezone into `toPacificDate` / `computeEnd`.
- Widen the regex to `${prefix}[a-z0-9]*_(\d{6})_(\d{6})([A-Za-z0-9_]+)\.mp3`.
- Then repair the 139 KPFT rows, either by re-deriving them from the filename (a data change, needs a go-ahead) or with the existing "Fix dates" action once the parser accepts them.

**Effort:** S for code, plus the data repair.

## 4. HIGH (FCC): a filed report can be edited, and finalize can leave none filed

- **No guard on edits.** `PATCH /api/qir {action:'update-entries'}` (`app/api/qir/route.ts:138-155`) has no `status <> 'final'` guard and doesn't validate the entries. Any editor's request can rewrite a filed public-file report: dates, durations, descriptions. The UI hides the button; the API doesn't. Only the audit trigger would record it.
- **Finalize isn't atomic.** It is three separate statements, and the demote's error is ignored (`:100-114`). If the promote fails after the demote succeeds, the quarter has **no** final and the public page goes blank. (A unique index already prevents two finals.)
- **No compliance recheck at finalize.** The blocking gate runs only at generation. Episodes with open critical flags are in 11 drafts, including the Q2 final (2 episodes) and Q3 v3 (2 episodes). Blocking is off globally, so this is policy, but it should be a conscious choice.

**Proposed fix.**
- `.neq('status','final')` (or a 409 response) on update-entries, plus entry shape validation.
- Do finalize in one RPC or transaction.
- Optionally recheck flags at finalize when blocking is on.

**Effort:** S.

## 5. HIGH (FCC content): filed descriptions are written from the first 200 characters of each summary

**What's wrong.** `workers/generate-qir.ts:192` sends `summary.slice(0, 200)` to the curation model, and `:270-273` stores the model's rewrite in place of the summary. The filed description therefore covers only the opening of the show. Later guests and segments, and sometimes the host, are dropped.

**Evidence.** Draft 21 (Q3 2026 v3), episode 6162: the source summary is 713 characters and the filed one is 234. The host (Ian Masters) and the second guest are gone from it. Episode 6240 loses its Food Not Bombs segment.

**Proposed fix.** Use the model for *selection and headline only* and keep the full DB summary as the filed description, or send the whole summary. **Effort:** S. This changes report logic, so it's your call.

> **Status (2026-11-05): fixed** (`lib/qir-curation.ts`, `workers/generate-qir.ts`). Selection still uses short snippets, but each selected entry is now rewritten **on its own**, from its full summary plus host, under the same curation prompt. A rewrite is accepted only under that entry's own id; otherwise the full stored summary is filed.
>
> **Found while fixing: some descriptions were attached to the wrong episode.** Writing ~100 descriptions from ~60 snippets per category, the model sometimes put one episode's description on another.
> - **v3 (latest), 2 entries:**
>   - Ep 9142 (Alex Cranor on banking) was filed as "a federal judge blocked Trump's ban on CNN… Maria Ressa".
>   - Ep 9150 (Nancy Lieberman) was filed as "Kamone Felix… Let the Poets Govern".
> - **v2, 5 entries:** 6364, 6754, 6769, 6844, 6879.
> - **v1, 2 entries:** 6842, 6888.
> - **Q2 final (draft 13):** clean.
>
> Checked on live data: the new pass rewrote 9142 correctly, and 6162 now names all three guests. It costs about 2¢ per report. **If the Q3 report filed outside the app used these drafts' text, check those entries.**

## 6. HIGH (compliance): word-list flags can be timed at the wrong moment, which can also flip safe harbor

**What's wrong.** PR #166 made word *matching* accent-safe, but the *timestamp* still comes from a plain substring search (`findTimestampForText`, `workers/compliance.ts:103,181`, `cue.text.includes(word)`). As of #166, that timestamp also decides safe harbor.
- **Wrong cue.** "fuck" gets timed at the first cue containing "motherfucking"; "culo" at "vehículo".
- **Live example.** Episode 10163: the "fucking" flag's excerpt is at 01:13:21, but its stored time (and the "Listen" jump) is 01:13:06, the "I'm a motherfucking bully" line. Both are in restricted hours there, so severity happens to be unaffected.
- **Only the first occurrence is flagged** (`:116-117`), and AI flags for a listed word are dropped (`listCovers`, `:514-517`). For a show straddling 6am or 10pm (`wayoutwest` 05:00–07:00; `golpe` and `perspectiva` 21:30–22:30), a first hit in safe harbor becomes a *warning*, and **a repeat in restricted hours is never flagged critical by either path.** No live case has been found yet.

**Proposed fix.**
- Time each match by running the same `wordPattern` over the cues.
- Keep the first occurrence *per regime* (one in safe harbor, one restricted).
- Only drop an AI flag when the list already has a same-regime flag.

**Effort:** S, about 25 lines plus tests.

## 7. HIGH (compliance, deploy): with the old prompt, the new AI pass costs money and catches no profanity

This is a deploy hazard rather than a code bug, and it matters for the planned prompt swap:
- The live `compliance_prompt` row exists, so `DEFAULT_COMPLIANCE_PROMPT` is never used (`lib/settings.ts:213`).
- The old prompt asks for payola, sponsor ID and indecency, but **not profanity**. Payola and sponsor are now switched off, so after deploy the AI pass runs (and is billed, at gpt-4.1-mini rates, about 3.4 windows per episode) but returns only indecency flags. **Its main purpose, catching lyric profanity, does nothing until the new prompt is in place.**
- Nothing in the repo writes the new prompt, and the compliance prompt card has no "Reset to default" button (summarization and curation do).

**Action:** make the prompt swap part of the deploy, either by pasting it in or by deleting the row so the code default applies. Consider adding a reset button.

**Smaller compliance issues** (each is a few lines; all change compliance logic, so they are listed for a decision):
- **Unknown AI flag types are silently dropped** (`:355-357`). They map to `payola_plugola`, which is now disabled, despite the comment saying "nothing … is silently dropped". Map them to `indecency`, or keep them as `info`.
- **AI failures look like a clean check** (`:343-352`). A model refusal, empty content or bad JSON skips the window silently, and the episode is still marked `compliance_checked` with no record that a window wasn't reviewed. Write the count of failed windows to `error_message`, or add an "AI review incomplete" info flag.
- **Re-runs can delete reviewer decisions** (`:23-33`, `:544-548`). A flag's identity is `type + excerpt`; when the excerpt text changes (re-transcription, a new correction, or the model wording an AI excerpt differently), an `investigating` or `violation` flag is deleted and replaced with a fresh `suggested` one. The 2 live `violation` flags are safe for now. Never delete triaged rows; mark them stale instead.
- **No cross-window de-duplication of AI flags**, so a repeated chorus yields one flag per occurrence.
- **AI severity isn't normalized**, and blocking needs exactly `'critical'` (`generate-qir.ts:104`). "Critical" or "high" would never block. It's latent, since the new prompt constrains the values.
- **The `compliance_checks_enabled` station override replaces the global object wholesale.** The worker reads a missing key as "off" for word-list checks and as "on" for AI checks. It's latent: KPFK's override lists all six keys.

## 8. MEDIUM-HIGH: the Re-summarize / Re-transcribe buttons strand episodes from earlier quarters

**What's wrong.** `app/api/episodes/[id]/route.ts` resets the row's status and enqueues `{episodeId}`, but neither worker reads `episodeId`; they select by current quarter or `priority`. The "retry" action enqueues nothing at all.

**What happens.** Clicking Re-summarize on any pre-October episode today:
- sets it to `transcribed`, where nothing will ever pick it up;
- drops it from the public feed and from downloads (it was `compliance_checked`);
- while the UI says "queued".

**Proposed fix.** Set `priority = true` on the targeted row (the workers already honour it), or pass a one-day `window`. **Effort:** S. It touches the pipeline's selection, hence the write-up.

## 9. MEDIUM: the backlog, explained, and what to do with it

**KPFK has no live backlog:** 0 pending in Q3 or Q4, and Q3 has 2,026 episodes done. All **1,302 KPFK `pending`** rows aired before July 1:

| Aired | Pending | How they got there |
|---|---|---|
| Q4 2025 | 264 | Before the window existed. |
| Q1 2026 | 631 | A windowed backfill on 9/26 died partway (see below). |
| Q2 2026 | 320 | Confessor's 60-day history was pulled on 6/24 and 7/03, after or as Q2 closed (Q2 was finalized 6/30 without them). |
| 2019–2024, plus one "1970" | 87 | Bad dates. |

**Also stranded:**
- **70 `transcribed`:** Jan 11–19 2026, from the same 9/26 backfill.
- **185 `summarized`:** Q4 2025. They have never been compliance-checked, so a regenerated Q4 2025 draft would include them unchecked.
- **1 `transcript_missing`:** nothing ever recovers that status.

**Why backfills die silently** (`workers/transcribe.ts:145-150`, the processors' pause returns): when the station lock is busy, or a pause blips, a windowed job returns `remaining: false` and the drain just ends. Out-of-window rows are invisible to every cron afterwards. *(A third cause, backoffs dropping the chain flag, is fixed in this PR.)*

**Fix:** return "try later" instead of "done" for windowed jobs, or record active backfills so the hourly cron resumes them. **Effort:** S–M.

**Ingest keeps inserting already-closed-quarter episodes** as `pending` dead weight. **Fix:** give them a distinct status at insert. **Effort:** M.

**Paused stations.** KPFA, KPFT, WPFW and WBAI have been paused since 6/10, each with a $2/month cap; ingest keeps collecting.

| Station | Q3 pending | Q4 pending |
|---|---|---|
| KPFA | 172 | 61 |
| KPFT | 275 | 99 |
| WPFW | 500 | 170 |

The 10-day grace window closed **Oct 10**, so their Q3 rows (and Q3 deadline) are already out of steady-state reach. Unpausing processes only Q4. Unpausing is not a spend risk: at turbo rates the whole backlog is about $50.

**Recoverable Q3 dead episodes.** These are now fetchable from the archive (HEAD 200/206):
- `kpfk_260810_070000dn`
- `kpfk_260721_170000backgroundbriefing`
- `kpfk_260722_213000golpe`
- `kpfk_260810_170000backgroundbriefing`
- `kpfk_260801_020000potira` (marked `unavailable` by mistake; see 11)

Because Q3 is past the grace window, resetting them alone won't process them; they need `npm run backfill-quarter -- --station kpfk --year 2026 --quarter 3 --kick` after a reset. That's a data change, so it's your call. **The Q3 2026 QIR exists only as drafts in the app** (filed outside it).

**Decisions needed:**
- (a) Backfill Q1 and Q2 2026 for KPFK, or archive those rows? A Q1 backfill is roughly 630 episodes, about $25 at turbo.
- (b) Run compliance on the 185 Q4 2025 rows before any Q4 2025 regeneration?
- (c) Reset and re-run the 5 recoverable Q3 episodes?

## 10. MEDIUM (GM cost)

- **Windowed backfills bypass every spend cap**, including the universal ceiling. `isPipelinePaused()` without a station never reaches the budget check (`lib/settings.ts:247-256`). CLAUDE.md says backfills should skip only the *pause*. **Fix:** check `isStationOverBudget(stationId)` on windowed jobs too. **Effort:** XS. This changes cap enforcement, so it needs your OK.
- **The workers are still on whisper-large-v3** ($0.111/hr; October was $96 for 865 hours). The global setting says turbo ($0.04/hr), but the code that honours it isn't deployed yet. The next deploy should cut transcription cost by about 60%. Compliance moves to gpt-4.1-mini at the same deploy, about 3× its current pennies.
- **The dashboard and usage page only split costs into Groq and OpenAI.** AssemblyAI ($5.76) and Deepgram ($0.52) rows count toward the total but appear in no card. It's latent this quarter. Use a per-service map.
- **Paid calls that fail are never logged:**
  - The compliance AI pass logs usage only on success; if window N throws, windows 1..N-1 go unlogged.
  - A failed summarization (e.g. "incomplete summary") logs no OpenAI usage at all.
- **Auto-retry re-transcribes summarize failures** (`workers/auto-retry.ts:120-124`): every `failed` row goes back to `pending`, so a summarize retry pays for transcription again. Dead episodes 2774, 2968 and 7715 were each transcribed 3 times. These were tiny files; an hour-long one would cost about $0.11 per wasted retry. **Fix:** reset to `transcribed` when a transcript exists, and treat near-empty transcripts (the model answering "SKIP") as "no content", not a strike.

## 11. MEDIUM: a Deepgram billing error was classed as "audio missing" (names/vocab lane)

`lib/transcription/deepgram.ts:64-70` tests the error body against `/…|404/i`. The `404` matched inside the request id (`"request_id":"019fbda7-404e-…"`), so a **402 payment-required** error marked episode 7418 (potira, 8/01) permanently `unavailable`. **Fix:** test `response.status`, never a bare digit substring. **Effort:** XS.

**Related, in our lane but not fixed here:** `lib/retry-policy.ts#isSpendLimitError` doesn't recognise provider billing lapses (`ASR_PAYMENT_REQUIRED`, "not enough credits"). Each one counts as a strike, which is how dead ids 6995, 6998 and 6999 died within 10 hours on 7/21. I tried a substring fix, but review caught a problem: the error message combines every provider's error, so a real per-episode error from Groq plus a Deepgram 402 would then retry forever. The correct fix checks that *every* provider attempt (`AllProvidersFailedError.attempts`, in `lib/transcription/`) was a billing error, so it needs the names/vocab session.

## 12. MEDIUM: split recordings show up as duplicate episodes

**What's wrong.** Confessor's `def_time` is the *slot* start, and each file fragment becomes its own row (dedupe is by `mp3_url` only). One airing whose recording restarted becomes two rows with the same slot time and fragment durations.

**Evidence.**
- 32 KPFK groups (106 rows) share show + date + start time; 24 of those groups have 2 or more published rows.
- 3 published rows have `duration = 0` (ids 6646, 7685, 7743).
- No current draft contains two fragments of one airing, but curation could pick a "4:30 AM, 0 minutes" fragment.

**Fix:** merge fragments per (show, slot), or at least exclude `duration <= 1` from curation. **Effort:** M.

## 13. MEDIUM: public pages that may publish more than intended (please confirm)

- **`/api/feeds/[showKey]?station=<slug>`** is unauthenticated and filters neither status nor active show. It publishes headlines and summaries of episodes still in progress or flagged, and of inactive shows. **Fix:** restrict to published statuses and active shows.
- **`/compliance-report?station=<slug>`** renders flag excerpts, show and host (statuses `investigating` and `violation`; 2 live KPFK violations) with no login. If that isn't meant to be public, gate it.

## 14. Lower priority

- **Drafts:** no unique (station, year, quarter, version), so a double-click can create two drafts with the same version. Generation also runs inside the HTTP request, so a long curation can hit the proxy timeout.
- **`episode_log.mp3_url` is unique across stations**, so two stations sharing a syndicated file would silently skip one; 0 today. There are also 3 redundant `mp3_url` indexes.
- **Settings:** a key missing from both layers isn't cached, so it costs two DB reads per call (`spend_limit_*` on every job). `pipeline_mode` is double-JSON-encoded and works by luck.
- **Time zones:** usage date ranges and month/quarter boundaries are UTC, so evening Pacific spend books to the next day.
- **Audit:** the `pitch.report.complete` audit action (9 rows) comes from another app sharing the DB; register or document it.
- **CLAUDE.md is stale in two places:**
  - The station-aware `get_episode_counts_by_show` is already fixed (only the legacy overload remains; see 1).
  - "Every updated row's `updated_at` moves" was not true until this PR. It is true now for the edit paths fixed here, but there is still no DB trigger.
- **Compliance:** a show-scoped compliance run ("Run compliance" on one show) continues as a station-wide sweep, because the continuation can't stay show-scoped: show-scoped selection re-picks already-checked rows and would loop. That behaviour predates this PR. A proper fix excludes rows checked in this run.
- **Load:** the dashboard (polled every 15s) and Master Control (every 10s) now page their usage sums correctly, but that means several round-trips per poll. A SQL `sum()` RPC would be cheaper; it needs a migration.
- **Search lane:** `app/api/episodes/route.ts` bulk fix-dates shares the parser limits in 3, and its episode CSV still uses the old unguarded encoder. It should switch to `lib/csv.ts`. `lib/transcript-search.ts` uses `getQuarterDateRange`, which is now timezone-safe.

---

## Fixed in this PR (each has a vitest test, or reuses a tested helper)

| Fix | Who it helps | Plain English |
|---|---|---|
| Cost totals page past the 1000-row cap (Usage page, dashboard, Master Control, v1 usage, spend caps) | GM | October showed $37.55; real spend was $97.81. Spend caps were tripping late or never. |
| Episode CSV pages past 1000 rows | GM, PD | The Q3 CSV stopped at row 1000 of 2,089 (lost mid-August onward). |
| Transcript/VTT download includes `compliance_checked` | PD, producers | Every recent quarter returned "No transcripts found". |
| Shared CSV encoder: carriage returns quoted, formula injection blocked, UTF-8 BOM | everyone | Spanish names open correctly in Excel; a summary can't run as a formula. |
| QIR text export rebuilt from the current entries | FCC file | The .txt kept the original AI text after edits; now it matches the CSV and public page. |
| Toggling a field back to "Manual" keeps the hand-typed value | producers | It used to erase the edited summary. |
| Quarter date range independent of server time zone | FCC file | On a server east of UTC, Q3 would have become Jun 30 – Sep 29. |
| Backfill backoffs keep their chain flags; compliance backs off instead of hot-looping | GM | One batch of 404s silently ended a backfill's transcribe → summarize → compliance chain. |
| Summarize checks DB errors | GM | A failed transcript fetch marked a whole batch `transcript_missing` (never recovered); a failed save counted as success. |
| `updated_at` bumped on dashboard edits, fix-dates and the Confessor re-sync; re-sync pages past 1000 | podcast app | `?updated_since=` consumers never saw curator or Confessor corrections. |
| Public API: strict timestamp validation; DB error is 503 not 401; API key revoke/delete returns 404 for an unknown id | API consumers | A malformed cursor gave a 500; a DB blip looked like a revoked key; unknown ids returned "ok" and wrote a fake audit row. |
| Audit: DB errors logged; login events sent with `keepalive`; search escapes PostgREST syntax; client events use own-property lookup and bounded metadata | GM (audit trail) | Login events were cancelled by the page navigation (1 ever recorded); a comma in the search box gave a 500. |
| Translation cost logged as its own operation | GM | It was filed under "summarize". |
| `workers/compliance.ts` raw NUL byte replaced with the `\u0000` escape (same value) | reviewers | Git treated the file as binary, so #166's main diff was unreviewable. |
| Shared helpers instead of copies | n/a | `lib/fetch-all.ts` (moved from `scripts/verify-week.ts`), `lib/csv.ts`, `lib/job-chain.ts`, `TRANSCRIBED_STATUSES`, `logTranslationUsage`. |
