# Names in transcripts: scan and proposal (Phase 1)

*KPFK, 2026-11-04. Read-only scan of the live QIR database plus a small Whisper test. Nothing in the database was changed. Live API spend for this phase: **$0.31** (Groq audio) of the $5 cap.*

---

## The short version (for Ace)

**The problem is real and bigger than it looked.**
- For hosts listed on the website, the transcript spells their name correctly in only **about 35%** of their episodes. 25 of 57 listed hosts are **never** spelled right in their last 30 episodes.
- Guests do better (about 70%), because they are usually introduced slowly and clearly once.
- The worst repeat offenders, counted over every KPFK transcript:

| Correct | What the transcripts say | How often |
|---|---|---|
| Brian DeShazor (This Way Out credit) | "Brian DeShazer" | 1,415 times in 531 episodes |
| Cary Harrison | "Carrie Harrison" | 352 times in 55 episodes |
| Sonali Kolhatkar | "Sonali Kohatkar" | 167 times in 64 episodes |
| Kevin Kamps (Solartopia) | "Kevin Camps" | 163 times; the correct spelling appears **zero** times |
| Margaret Prescod | "Margaret Prescott" | 103 times in 80 episodes |
| Matt Sedillo (La Raza Radio) | "Matt Cedillo" | 92 times; the correct spelling appears **zero** times |
| Nick Richert (Bike Talk) | "Nick Richard" | in 28 of his last 30 episodes |

**The AI copies these mistakes.** The AI-written host field says "Tom Hartman", "Susie Wiseman" and "Nana Jumfi", because it read them from the transcript. That field cannot be used as a source of correct spellings.

**We have far fewer correct spellings on file than we thought.**
- The earlier figures ("hosts on 113 of 225 shows, 1,584 guests") were counted from those AI-written fields. They also covered two quarters, not one.
- Names a human actually typed exist for only **10 shows** (in Confessor).
- The website lists hosts for **27 more shows**, giving **34 shows in total** once the overlap is removed.
- **133 of the 167 active shows have no trusted host name.** 42 of those are talk shows that aired this quarter. They carry 420 of the quarter's 783 episodes, including Democracy Now!, Something's Happening, Pacifica Evening News, BradCast and Thom Hartmann.

**Hinting Whisper works for talk shows, but it badly damages music shows.**
- I gave Whisper a short list of names on a few real episodes. "Carrie ×5, Cary ×0" became "Cary ×5, Carrie ×1", and "Matt Cedillo" became "Matt Sedillo".
- On music shows, every version of the hint made things much worse. Whisper filled the song stretches with "Awakenings, KPFK, Pacifica, Michelle Coltrane" over and over, or with gibberish.
- Phrasing the hint as a sentence ("Hosts: … Guests: …") made Whisper insert the word "Guests," into the text and drop real speech.
- So the hint must be **short, names only, and switched off for music shows.**

**The existing fix-up rules are mostly fine.**
- Re-running your 9 active rules over stored transcripts would fix **32 transcripts**. Every match I found was a genuine misspelling of Nagwa Ibrahim, Estee Chandler, Cary Harrison or Victor Pickard. I found no collateral damage, including in the Spanish shows.
- **One inactive rule is dangerous.** It turns every letter "d" into "B" on one Spanish episode. It is harmless only while switched off, so I recommend deleting it.

**What I need from you before I build.** The proposal is in section 6. The decisions are in section 7, and most are yes/no.

---

## Phase 2: what was built and what it measured (2026-11-05)

**Ace's decisions:**
- Keep transcribing music shows.
- Delete the "D → B" rule (done 2026-11-05).
- Import the show names we can get.
- Spell "Renee Yaworski" without the accent.
- Eco-Justice Radio: Carry Kim and Jessica Aldridge.
- John Cromshow and Marylin Cavanaugh are correct as spelled.
- Refresh semantic search after a repair: yes.

**Show names now on file: 99 of 167 active shows** (up from 34).
- Sources: Confessor's DJ column, kpfk.org co-hosts, and Ace's confirmations (migration 048). Website hosts sync in nightly.
- This quarter, 64 of the 72 talk shows that aired have names, covering 717 of 805 episodes.
- Still missing:
  - Making Contact
  - Pacifica Evening News
  - Feminist Magazine
  - Insurgencia Feminina
  - Capitalism, Race and Democracy
  - Special Programming

**Before/after on a fixed set** (`npm run benchmark-names`).
- The set: 11 talk-show chunks where a host's name is spoken, plus 4 music chunks.
- Run on `whisper-large-v3-turbo`; cost $0.30.

| Talk shows | Names spelled right |
|---|---|
| Today (no hint, current rules) | **8%** (2 right, 22 wrong) |
| Approve the 8 suggested fixes | **74%** (17 right, 6 wrong) |
| Turn on the Whisper name hint | **100%** (21 right, 0 wrong) |

**But the hint has a real cost. It stays OFF.**
- **It deletes or replaces real speech.** 130 words across the 11 talk chunks were affected:
  - On Rising Up, a whole sentence became "Sonali Kolhatkar".
  - On Bike Talk, a sentence about RAGBRAI vanished.
  - On LARB, the producers' names in the credits disappeared entirely.
- **It coarsens captions:** sometimes half as many cues (186 → 81), which makes jump-to-moment links less precise.
- **On music, forcing the hint repeats the host's name** through the songs: 21 times on Awakenings, even after the echo guard. Production never sends it to music, but this is why that rule exists.

**The safe route is rules.** The nightly miner proposes them, a person approves them, and they fix past transcripts too. That's 8% → 74% with no risk to the text, and it keeps improving as suggestions are approved. The hint stays available as a per-station switch for later experiments.

**Repair of past transcripts.**
- The 9 existing active rules (pre-approved) will be re-applied automatically the first time the workers start after deploy.
- By a read-only count, that changes **32 stored transcripts**.
- Every rule approved or edited after that is re-applied within minutes.

**Spend:** $0.31 (Phase 1 prompt tests) + $0.30 (benchmark) = **$0.61** of the $5 cap.

## 1. Where correct spellings exist today

| Source | What it is | Shows it covers (of 167 active) | Trust |
|---|---|---|---|
| **Confessor (human)** | Names producers type into the archive: `field_sources.host/guest.human`, raw `confessor_meta` | Hosts: **10 shows** (86 episodes, all time). Guests: 12 shows (134 episodes). This quarter only 19 episodes have a human host and 31 a human guest. | High, but messy |
| **Website host list** (`cms_show_hosts`) | The curated hosts on kpfk.org show pages, 57 names | **27 shows**. 20 are linked through `cms_show_source`. 7 more (CODEPINK, FolkScene, Afrodicia, Awakenings, Dark Star, Rhapsody in Black, Way Out West) are linked only by matching `program_slug` to the show key; that's how verify-week already joins them. | High, and clean |
| **Show names** | Show names containing the host ("Thom Hartmann Program") | Names a host for 25 shows, 19 of which are otherwise gaps | Medium. Useful to seed, but first names only in places ("Phil & Ted") |
| **AI entity mentions** (`cms_entity_mentions`) | 239 names the website's AI suggested; none approved | 12 shows have an AI-suggested host | Low (unreviewed AI) |
| **AI-resolved host/guest** (`episode_log.host/guest`) | What the summarizer wrote | 110 shows | **Do not use as a source**: it repeats the transcript's misspellings |

**Combined, trusted hosts cover 34 shows** (27 from the website, 10 from Confessor; Solartopia, Rising Up and This Way Out are in both).

**Join paths**
- Confessor: `episode_log.show_key → show_keys.key`.
- Website: `cms_show_hosts.show_id → cms_shows.id`, then either `cms_show_source.cms_show_id → qir_show_key` or `cms_shows.program_slug`, to `show_keys.key`. Then expand through `coalesce(show_group, key)` so all feeds of one show share the list.

**Quality problems to clean up while building the list**
- **Confessor host strings are free text.** Solartopia alone has 10 versions ("Harvey \"Sunny\" Wasserman & Kevin Kamps", "HARVEY … Host; KEVIN KAMPS, Co-Host"). There are "(Guest Host)" suffixes, and the guest field mixes in titles and bios.
- **Name splitting is needed.** "X and Y", commas, and "Name, title, org" all have to be broken into separate names.
- **The human or website spelling may itself be wrong.** Check these before any rule is written:
  - **"John Cromshow"** (Politics or Pedagogy): transcripts always say "Crumshaw". **Confirmed by Ace 2026-11-05: Cromshow is correct.**
  - "Renèe Yaworski" is probably Renée.
  - "Marylin Cavanaugh" is correct (confirmed by Ace 2026-11-05 via kpfk.org/on-air/revolucion-arcoiris).
  - "Aziz Haq" is probably Huq.
  - "John Dingus" is probably Dinges.
- **The two sources conflict on Solartopia.** Confessor lists Kevin Kamps and the website lists Myla Reson. Both are probably right (co-hosts).
- **Show grouping problems** were found in passing. They don't block this work, but they split one show's name list in two:
  - BradCast is split into 3 groups, two differing only by capital letters.
  - The group name "Cncuentros con Gregorio Luke" is a typo.
  - There are duplicate dormant keys (`beneaththesurfacewithsuziweiss`, `theoutagenda`, `radioafrodicia`).

## 2. How bad the misspellings are (measured on real data)

**Method.**
- For each trusted name, I checked whether it appears in the transcript exactly: whole word, ignoring case.
- I also checked for a close-sounding variant ("Prescott" for Prescod). SQL found the candidates and I classified them by hand.
- The data is 6,009 stored KPFK transcripts, Dec 2025 to Nov 2026.
- An independent second pass recomputed the key figures; where the two disagreed, I give the second pass's number.

| Answer key | Pairs tested | Exact | Variant only | Neither |
|---|---|---|---|---|
| Website hosts (57 hosts × their 30 most recent episodes) | 1,343 | **≈35%** | ≈28% | ≈37% |
| Confessor human hosts (19 names) | 97 | 28% | 68% | 4% |
| Confessor human guests (153 names) | 179 | 70% | 22% | 8% |

"Neither" includes episodes where the host simply doesn't say their name, so it is an upper bound on misses.

**Top recurring misspellings (station-wide, all transcripts)**

| Wrong → right | Count / episodes | Shows | Safe as a rule? |
|---|---|---|---|
| Brian DeShazer → Brian DeShazor | 1,415 / 531 | This Way Out, Pacifica Evening News, PRA, Out Agenda | Safe |
| Carrie Harrison → Cary Harrison | 352 / 55 | Cary Harrison Files and promos | Safe as the **full name** ("Carrie" alone is a real name) |
| Sonali Kohatkar → Sonali Kolhatkar | 167 / 64 | Rising Up and promos | Safe |
| Kevin Camps → Kevin Kamps | 163 / 27 | Solartopia | Safe as the full name |
| Nana Jumfi / Jumphy / Jumpy → Nana Gyamfi | ~143 | Sojourner Truth, Democracy Now, Law & Disorder | Safe as the full name ("jumpy" is a word) |
| Lucia Chappell → Lucia Chappelle | 110 / 66 | This Way Out, news | Safe |
| Margaret Prescott → Margaret Prescod | 103 / 80 | Sojourner Truth and promos | Safe as the full name |
| Matt Cedillo → Matt Sedillo | 92 / 38 | La Raza Radio | Safe as the full name |
| Maggie LaPique → Maggie LePique | 72 / 49 | Rock Profile and promos | Safe |
| John Crumshaw → John Cromshow | 48 / 29 | Politics or Pedagogy | Safe (Cromshow confirmed) |
| Steve Scrovan → Steve Skrovan | 45 / 32 | Ralph Nader Radio Hour | Safe |
| Nick Richard → Nick Richert | 40 / 40 | Bike Talk | **This show only** (common real name) |
| Ramses Jaw → Ramses Ja | 40 / 30 | QR Code | Safe as the full name, this show |
| Rita Gonzalez → Rita Gonzales | 64 / 33 | Out Agenda, PRA | Risky (both spellings are real) |
| Kate Wolfe → Kate Wolf | 29 / 20 | LARB, FolkScene | Risky (Kate Wolf is also a folk singer) |
| Ralph Radabaugh → Ralph Radebaugh | 27 / 14 | Out Agenda | Safe |
| Medea Ocher → Medaya Ocher | 18 / 14 | LARB | Safe as the full name (Medea Benjamin is another person) |
| Susan Greenhall → Susan Greenhalgh | 19 / 4 | BradCast | Safe |

**The pattern that matters for design.**
- A variant is only safe to auto-correct as the **full two-word name**, and some only **within one show**.
- On its own, a first or last name is nearly always a real word or a different person: Carrie, Jumpy, Camps, Prescott, Cedillo, Wolfe, Medea.
- That is why per-show scope (6b) is not optional.

All figures above are on **large-v3** transcripts. No turbo transcripts exist yet: the turbo setting is saved, but production is still producing large-v3, so the merged change probably isn't deployed. Turbo is described as "slightly weaker on rare names", so this problem is more likely to grow than shrink.

## 3. Shows Ace needs to fill in (the gap list)

- 133 of 167 active shows have no trusted host. To keep this manageable, the appendix lists only the 67 that **aired this quarter**: **42 talk** and **25 music/arts**.
- Each row has the show, its air time, a sample episode link, and the host name the AI *thinks* it heard, so you can **confirm or fix** rather than type from scratch.
- Note: the AI suggestions are often wrong in exactly the way this project fixes ("Tom Hartman", "Scott Baba" vs "Scott Bava").
- The other 66 active shows have had **no episodes this quarter**, and most have never had one. They came in through the auto-activate discovery sync. Ignore or deactivate them; they don't need hosts.

Start with these six: they're half of the talk-show episodes.

| Show | Q4 episodes |
|---|---|
| Something's Happening | 117 (AI only knows "Diane, Buzz") |
| Democracy Now! | 39 |
| Pacifica Evening News | 25 |
| BradCast | 24 + 5 on a second key |
| Thom Hartmann | 24 |
| Law and Disorder | 19 |

## 4. The 10 existing correction rules

| # | Rule | Verdict |
|---|---|---|
| 1 | Kerry Harrison → Cary Harrison | Good. It misses "**Carrie** Harrison" (352 hits), the far bigger problem. |
| 2 | jackiebots → jackiebotts | Harmless. Matches nothing stored. |
| 3 | **D → B** (inactive, one episode) | **Delete it.** If anyone re-enables it, it turns every "d" in that Spanish episode (≈1,800 letters) into "B" the next time it's transcribed. |
| 4 | Negwa/Negua/Nagua → Nagwa | Good: 29 stored transcripts to fix, all genuinely Nagwa Ibrahim (fund-drive pitches and Middle East in Focus sign-offs across 14 shows). It's station-wide, which is right, because she's heard station-wide. Small risk: "Nagua" is a Dominican city, but it had zero Spanish-show hits today. |
| 5 | Esty/Esti → Estee | Good: 4 to fix, all "Esty Chandler". Safer as "Est(y\|i) Chandler". |
| 6 | Mohammed Murtaza… → Mourtaja | Harmless. 0 stored hits. |
| 7 | Kharosh… Ziabari → Kourosh Ziabari | Harmless. 0 hits. |
| 8 | Shireen El-Adi[mb]i → Al-Adeimi | **Misses** "Shireen Al-Ademi" (2 episodes). Widen the pattern. |
| 9 | Victor Picard → Pickard | Good: 1 to fix. |
| 10 | Matt Pierce → Matt Pearce | OK. 0 stored hits. Watch for a different Matt Pierce. |

**None are redundant or harmful while active.**
- Re-applying them to stored transcripts (pre-approved) would change **32 transcripts**, only 1 of them this quarter. It's small, but it proves the repair works.
- **A technical trap to avoid:** the rules are written in JavaScript regex, where `\b` means "word boundary". The repair must run them in the app's code (as transcription does), never translated into SQL, where `\b` means something else.

## 5. Whisper "prompt" (vocabulary hint) on Groq

**What Groq accepts**
- Groq's transcription endpoint accepts a `prompt` for `whisper-large-v3-turbo` (and large-v3).
- It applies **per request**, so with our 15-minute chunks it must be sent with **every chunk**.
- Whisper only "listens" to roughly the last 224 tokens of the prompt.

**Size limit**
- Groq **rejects** an oversized prompt with an HTTP 400 error; it does not trim it.
- In testing, 888 plain-ASCII characters were accepted; 1,068 bytes (890 accented characters) were rejected. The exact cutoff isn't pinned down. Groq's error text reportedly says 896 characters, but the saved evidence doesn't include it.
- In our worker, that 400 would currently make the **whole Groq attempt fail** and fall through to the backup provider. **The code must cap the prompt well under the limit** (I'd use 600 bytes) **and, on a prompt error, retry the chunk without a prompt.**

**What happened on real audio**
One 15-minute chunk per episode, turbo unless noted. Runs are deterministic: the same input twice gives identical output.

| Episode | No hint | Short name list | Sentence ("with host …") | Long list (~55 names) |
|---|---|---|---|---|
| Cary Harrison Files | Carrie ×5, Cary ×0 | **Cary ×5**, Carrie ×1 | Cary ×6, but extra lyrics transcribed | Carrie ×4, Cary ×0 (no help) |
| Same, on large-v3 | Carrie ×3, Kerry ×1 | – | Cary ×6 | – |
| Thom Hartmann | "Tom Hartman" | "Tom Hartmann" | "Tom Hartmann", but **192 words of real speech replaced** | – |
| La Raza Radio | "Matt Cedillo" | **"Matt Sedillo"** | "Guests," inserted ~12×, **247 words lost** | – |
| Music: Global Village, Awakenings, World Massive | Already hallucinates "Thank you." every 30 s | Prompt names repeated as if spoken; "Ski Ski Ski…" | "Awakenings, with host Michelle Coltrane." in 25 of 29 segments | "Sous-titrage ST' 501" ×20 |

**Takeaways**
1. **The format is a short comma list** of the call letters plus that show's hosts and regulars, about 5–10 names (≈150 bytes). Spell each name exactly as it should be written. No sentences and no "Host:/Guest:" labels: those words leak into the text.
2. **The hint must never be sent for music shows.** Groq's "no speech" signal reads 0.00 even on pure music, so we can't detect music per segment. We have to decide per show (category), with a per-show override for mixed shows.
3. **It doesn't fix everything.** "Thom" still came out "Tom" (they sound the same), and a long list fixed nothing. Correction rules stay the backstop.
4. **Side effect: a prompted chunk comes back in fewer, longer caption cues** (e.g. 284 → 92). Search still finds the words, but jump-to-moment links get coarser. The benchmark (6e) will measure this before we turn the hint on everywhere.

## 6. Proposed design

Ordered by value per effort. Every piece is in my lane (`workers/transcribe.ts`, `lib/transcription/**`, corrections API, Settings, and the table) unless noted.

### (b) Per-show correction scope: build first (½ day, $0)
- **What:** Add an optional **show** to each rule (`transcript_corrections.show_group`; migration 046). A rule then applies station-wide, to one show (every feed in its group), or to one episode. This is what makes "Nick Richard → Nick Richert, Bike Talk only" safe.
- **Who uses it:** a producer or the PD adds "Matt Cedillo → Matt Sedillo" once, scoped to La Raza.
- **Code:** extend the existing `correctionsForEpisode()` helper (it already handles station vs episode scope) and add a show dropdown in Settings → Corrections.

### (d) Backlog repair: apply rules to stored transcripts (½ day, ~$0)
- **What:** One shared "re-apply corrections to stored text" routine, run in the app's own regex engine (see the `\b` trap above). It updates the transcript and the captions, then rebuilds the cue-level search index for that episode.
  - The cue rebuild currently exists as two copy-pasted functions (`workers/transcribe.ts` and `scripts/backfill-transcript-cues.ts`). I'll extract one shared helper.
- **Runs:**
  1. Once now, for the **existing active rules** (pre-approved): 32 transcripts.
  2. Automatically for just the affected episodes whenever a rule is **added, approved or edited**, so a new rule fixes history too, not just future shows.
  - Dry-run first; every changed transcript gets an audit-log row.
- **Search side-effect:** the full-text index updates itself. The semantic-search chunks (another session's lane) would still hold the old spelling until re-embedded. I'll call their existing `storeEpisodeChunks` helper (`lib/transcript-embeddings.ts`) without editing it, at ≈$0.0002 per episode, or leave that to them; your call.

### (a) Per-episode vocabulary hint for Groq (1 day, $0 extra per episode)
- **What:** Before each Groq chunk, build `KPFK, Pacifica, <show hosts>, <show regulars>, <this episode's Confessor host/guests>`.
  - Deduplicated, show names first, then episode names.
  - Hard-capped at 600 bytes.
  - **Only for non-music shows**, with a per-show "use name hint" on/off switch for exceptions.
- **Where the names come from (one per-show list):**
  - Website hosts.
  - Confessor human hosts.
  - Names you confirm from the gap list.
  - Names promoted from approved corrections (an approved "Carrie Harrison → Cary Harrison" adds "Cary Harrison" to the hint).
  - Stored as a new `show_keys.vocabulary` list (or a small table), editable in Settings → Shows.
- **Guards:**
  - If Groq rejects the prompt, retry the chunk without it.
  - After a prompted chunk, drop segments that are just the prompt echoed back, or the same line repeated 3+ times.
- **Off by default.** It's a per-station setting, so we flip it on only after the benchmark passes.
- Diarizing providers (Deepgram/AssemblyAI) have their own keyword-boost features; the same name list can feed them later.

### (c) Suggested-corrections miner (1–1½ days, $0)
- **What it does:** a nightly job (or a button) compares each show's trusted names against its recent transcripts, using the SQL fuzzy matching from this scan. It proposes rules like "*Matt Cedillo → Matt Sedillo, La Raza Radio, seen 28 times in 30 episodes*".
- **What it proposes:**
  - Full names only.
  - Per show, unless the variant is never a real word.
  - With a sample snippet as evidence.
- **Where they go:** proposals land in a **"Suggested" list in Settings → Corrections**, with Approve / Edit / Reject. Approving creates the rule and triggers the backlog repair (d) for that rule. Rejected suggestions don't come back.
- **Nothing rewrites a transcript until a person clicks Approve.** That's the approval gate you asked for.
- **Weekly upkeep:** a few clicks. The PD or a producer glances at the suggestions list, nobody types regexes, and the miner finds both the misspelling and the episodes.

### (e) Before/after benchmark (½ day, ≈$0.30 per run)
- **The fixed set:** about 12 chunks, 8 talk shows with known names and 4 music shows (Global Village, Awakenings, World Massive, plus one more). It's kept in the repo so every future change is measured against the same audio.
- **The answer key:** website/Confessor names (and confirmed gap names).
- **Reported, per run:**
  - Name accuracy (exact-hit rate), with and without hint, and with rules.
  - Lost-content words versus no-hint.
  - Prompt-echo lines on music chunks (**must be zero** to ship the hint).
  - Caption cue count.
- **Cost:** ~3 hours of turbo audio is ≈$0.12 per run, ≈$0.30 with a large-v3 comparison.

### Total
About **4 days of build**. Running cost is **~$0**: the hint adds no Groq charge, and the miner and repair are database work. Benchmark runs are pennies.

**Sequence:** b → d (with the pre-approved repair) → c → e → a. The hint goes on only after e shows it helps on talk and leaves music clean.

## 7. Decisions for Ace

1. **Go ahead with Phase 2 as proposed** (b, d, c, e, a in that order)?
2. **Delete rule #3 ("D → B")?** It's a database write, so I need your OK. Recommended.
3. **Gap list:** will you confirm the AI-suggested hosts for the 42 talk shows (the appendix, starting with the six big ones)? Or should I put a "confirm host" button on the Shows page so you, the PD or producers can do it there?
4. ~~John Cromshow or Crumshaw?~~ Cromshow, and Marylin Cavanaugh, confirmed. Still open: Renèe vs Renée Yaworski.
5. **Semantic search refresh after repair:** re-embed changed episodes (≈free, uses the search lane's helper), or leave it to the search session?
6. **Name hint for music shows:** off is recommended. Are there any music-category shows that are really talk (e.g. *Perspectiva de Las Americas* is tagged Music but sounds like Spanish talk)?

*Out of scope, flagged for whoever owns Shows:*
- Link the 7 website shows that only match by `program_slug` in `cms_show_source`.
- Merge the BradCast groups.
- Fix the "Cncuentros" group typo.
- Deactivate the 66 dormant auto-activated shows.

---

## Appendix A: gap list (active KPFK shows with no trusted host, aired this quarter)

**"Suggested host"** is the most frequent AI-written host for the show since April, shown as matches/total. It's unverified and sometimes misspelled; confirm or correct it. **Schedule** comes from the website schedule; `[ep]` means it was inferred from episode air times. Episode links open the QIR dashboard.

### A. Talk shows airing this quarter (42), highest priority

| Name | Keys | Category | Schedule | Q4 | Sample | Suggested host (unverified) | Note |
|---|---|---|---|---|---|---|---|
| KPFK - Something's Happening | somethihappenihour, somethihappenibhour, somethingshappeningb, somethihappenihoura, somethingshappening, somethihappenibhoura | PA - National+Synd | Tue/Wed/Thu/Fri 00:00 to 05:00 (6 hourly slots) | 117 | [10517](https://qir.kpfk.org/dashboard/episodes/10517) | Diane, Buzz (36/250) | Only first names. Biggest single gap. |
| KPFK - Democracy Now! | dn, democracynow | PA - National+Synd | Mon to Fri 07:00; Mon to Thu 16:00 | 39 | [10506](https://qir.kpfk.org/dashboard/episodes/10506) | Amy Goodman (74/191) | Entity mentions also give Juan González. |
| KPFK - Pacifica Evening News | kpfknews | News | Thu 18:00 (20x) [ep] | 25 | [10466](https://qir.kpfk.org/dashboard/episodes/10466) | Scott Bava (37/90) | AI also spells it "Scott Baba". |
| KPFK - BradCast w/ Brad Friedman | bradcast2 | PA - National+Synd | Mon 15:00 | 24 | [10508](https://qir.kpfk.org/dashboard/episodes/10508) | Brad Friedman (113/114) | Host is in the show name. Confessor has 57 human guests here but no human host. Entity mentions add Desi Doyen. |
| KPFK - Thom Hartmann Program | hartmann, thethomhartmannshow | PA - National+Synd | Mon to Fri 09:00 | 24 | [10493](https://qir.kpfk.org/dashboard/episodes/10493) | Tom Hartman (65/85) | The AI misspells it; the show name has "Thom Hartmann". |
| KPFK - Law and Disorder | lawsnddisor | PA - National+Synd | Mon 08:00 (19x) [ep] | 19 | [10492](https://qir.kpfk.org/dashboard/episodes/10492) | Kat Brooks (70/91) | |
| The Aware Show | aware | Health & Spirituality | Wed/Thu 13:00 | 10 | [10347](https://qir.kpfk.org/dashboard/episodes/10347) | Lisa Garr (19/23) | |
| Alan Watts | alanwatts | Health & Spirituality | Sun 08:00 | 5 | [10419](https://qir.kpfk.org/dashboard/episodes/10419) | Diane (17/18) | Lecture archive; "Alan Watts" is in the title. |
| KPFK - Planting Medicine | plantingmedecine | Health & Spirituality | Tue 13:00 (17x) [ep] | 5 | [10499](https://qir.kpfk.org/dashboard/episodes/10499) | René Camila (7/25) | |
| Global Village - Mon | gv_derek, globalvillagemonday, globalvillagemondays | PA - Local (music in practice) | Mon 11:00 | 5 | [10453](https://qir.kpfk.org/dashboard/episodes/10453) | Kathy Diaz (15/20) | The key suggests Derek (Rath). |
| KPFK - American Indian Airwaves | americanindian | PA - Local | Thu 19:00 | 5 | [10359](https://qir.kpfk.org/dashboard/episodes/10359) | Larry Smith (25/25) | |
| KPFK - Be a Better Relative | nativenationsreport | PA - Local | Tue 19:30 | 5 | [10505](https://qir.kpfk.org/dashboard/episodes/10505) | Sunrose Ironshell, Lydia Ponce (10/21) | |
| KPFK - Brad Friedman's BradCast | friedman | PA - Local | Mon 15:00 | 5 | [10458](https://qir.kpfk.org/dashboard/episodes/10458) | Brad Friedman (6/6) | Same show as bradcast2. Its show_group differs only in case ("BradCast" vs "Bradcast"), so the two are not merged. |
| KPFK - Car Show, The | carshow, thecarshow | PA - Local | Sat 13:00 | 5 | [10407](https://qir.kpfk.org/dashboard/episodes/10407) | Mark Vaughn, Michelle Spencer, Carl Brouwer (10/27) | |
| KPFK - Conversation Piece | conversatpiece | PA - Local | Sat 10:00 | 5 | [10404](https://qir.kpfk.org/dashboard/episodes/10404) | Angela Birdsong (21/25) | |
| KPFK - Eco-Justice Radio | ecojustiradio | PA - Local | Mon 04:30 | 5 | [10438](https://qir.kpfk.org/dashboard/episodes/10438) | Carrie Kim (9/27) | A Confessor "special" episode names Jack Eidt. |
| KPFK - Expansion Zone | ivmon, expansionzone | PA - Local | Mon 13:00 | 5 | [10454](https://qir.kpfk.org/dashboard/episodes/10454) | Sonia Barrett (26/26) | |
| KPFK - Freedom Now | freedomnow | PA - Local | Sat 11:00 | 5 | [10405](https://qir.kpfk.org/dashboard/episodes/10405) | Brother Brandon Sankara (7/24) | |
| KPFK - Living In The USA | johnwiener | PA - Local | Fri 16:00 | 5 | [10392](https://qir.kpfk.org/dashboard/episodes/10392) | John Wiener (18/18) | The key carries the host's name. |
| KPFK - Pocho Hour Of Power | pocho, thepochohourofpower | PA - Local | Fri 15:00 | 5 | [10391](https://qir.kpfk.org/dashboard/episodes/10391) | Jeff Keller, Lalo Alcaraz (3/27) | |
| KPFK - Think Outside The Cage | prisonrights | PA - Local | Sun 09:00 | 5 | [10421](https://qir.kpfk.org/dashboard/episodes/10421) | Mark Cofield (19/27) | |
| KPFK - Working Voices | workingvoices | PA - Local | Mon 05:00 | 5 | [10441](https://qir.kpfk.org/dashboard/episodes/10441) | Hal Lohr, Marissa Remsky (7/25) | |
| KPFK - Contragolpe | golpe, contragolpe | PA - Local | Wed 21:30 | 4 | [10322](https://qir.kpfk.org/dashboard/episodes/10322) | Pablo López (9/11) | |
| KPFK - Encuentros con Gregorio Luke | luke, encuentroscongregorioluke | PA - Local | Wed 22:30 | 4 | [10323](https://qir.kpfk.org/dashboard/episodes/10323) | Gregorio Luke (7/12) | Host is in the title. The show_group is misspelled "Cncuentros…". |
| KPFK - Feminist Magazine | femmag, feministmagazine | PA - Local | Wed 19:00 | 4 | [10319](https://qir.kpfk.org/dashboard/episodes/10319) | Lynn Harris-Ballon (19/25) | |
| KPFK - Insurgencia Feminina | radioinsurgencia, insurgenciafeminina | PA - Local | Tue 21:00 | 4 | [10284](https://qir.kpfk.org/dashboard/episodes/10284) | Elisa Mejía (6/11) | |
| KPFK - Radio Bilingue | radiobilingu, radiobilinguenewsspecial | PA - Local | Wed 23:30 | 4 | [10324](https://qir.kpfk.org/dashboard/episodes/10324) | Chelis López (10/18) | |
| KPFK - Radio Maiz/El Vuelo del Águila y el Condor/Radio Sudamerica | radiomaiz, radiomaizelvuelodelguilayelcod | PA - Local | Mon 20:30 (17x) [ep] | 4 | [10470](https://qir.kpfk.org/dashboard/episodes/10470) | Anette Feliz Aguilar (3/14) | Rotating show, so expect several hosts. |
| KPFK - Soul Rebel Radio | soulrebel, soulrebelradio | PA - Local | Fri 19:00 | 4 | [10395](https://qir.kpfk.org/dashboard/episodes/10395) | Emiliano Miranda, Joanna Rivas (13/22) | |
| KPFK - Capitalism, Race and Democracy | covidraceanddemocr | PA - National+Synd | Tue 19:00 | 5 | [10503](https://qir.kpfk.org/dashboard/episodes/10503) | Thomas O'Rourke (12/25) | |
| KPFK - Chris Hedges Report | onconta | PA - National+Synd | Sun 08:30 | 5 | [10420](https://qir.kpfk.org/dashboard/episodes/10420) | Chris Hedges (9/19) | Host is in the title. |
| KPFK - Counterspin | counterspin | PA - National+Synd | Mon 16:30 (11x) [ep] | 5 | [10462](https://qir.kpfk.org/dashboard/episodes/10462) | Janine Jackson (10/11) | |
| KPFK - The Visionary Activist | visionalryactivist | PA - National+Synd | Fri 13:00 (18x) [ep] | 5 | [10384](https://qir.kpfk.org/dashboard/episodes/10384) | Caroline Casey (26/27) | |
| KPFK - Alternative Radio | alterradioar | PA - National+Synd | Wed 14:00 | 4 | [10311](https://qir.kpfk.org/dashboard/episodes/10311) | David Barsamian (19/27) | |
| KPFK - Dialogos de Media Noche | medianoche, dialogosdemedianocheinquilinos | Español | Thu 23:00 | 5 | [10363](https://qir.kpfk.org/dashboard/episodes/10363) | Sergio Serdio (19/24) | |
| KPFK - Enfoque Latino | enfoque | Español | Thu 22:00 | 5 | [10362](https://qir.kpfk.org/dashboard/episodes/10362) | Gonzalo Ruacaba (4/28) | Weak suggestion. Entity mentions give Alejandro Maciel and Elisa Belén. |
| KPFK - Nuestra Voz | nuestravoz | Español | Thu 20:30 | 5 | [10361](https://qir.kpfk.org/dashboard/episodes/10361) | Rubén Tapia (13/26) | |
| KPFK - Contacto Ancestral | contactoancestral | Español | Mon 22:30 | 4 | [10473](https://qir.kpfk.org/dashboard/episodes/10473) | Felipe Pérez (4/9) | |
| KPFK - Hablando de Sudamerica | hablanddesudamer, hablandodesudamrica | Español | Mon 21:00 | 4 | [10471](https://qir.kpfk.org/dashboard/episodes/10471) | Ángel Jaramillo (8/19) | |
| KPFK - Senderos de Oaxaca o Asi Es Nuestra Cultura | sendedeoaxacoasiesnuestcultu, senderosdeoaxaca | Español | Wed 20:30 | 4 | [10321](https://qir.kpfk.org/dashboard/episodes/10321) | Ricardo Núñez Román (13/22) | |
| KPFK - Suplemento Comunitario | suplemento, suplementocomunitario | Español | Tue 22:00 | 4 | [10285](https://qir.kpfk.org/dashboard/episodes/10285) | Oscar Ulloa (8/22) | |
| KPFK - Voces de Libertad | vocesdelibertad | Español | Tue 20:00 | 4 | [10283](https://qir.kpfk.org/dashboard/episodes/10283) | Rodrigo (1/5) | Weak suggestion. |

### B. Music and arts shows airing this quarter (25), lower priority

| Name | Keys | Category | Schedule | Q4 | Sample | Suggested host (unverified) | Note |
|---|---|---|---|---|---|---|---|
| KPFK - Arts In Review | artsinreview | Arts & Ent. | Fri 14:00 | 5 | [10386](https://qir.kpfk.org/dashboard/episodes/10386) | Julio Martinez (24/27) | Talk format |
| KPFK - Bibliocracy | bibliocracy | Arts & Ent. | Thu 14:30 | 5 | [10348](https://qir.kpfk.org/dashboard/episodes/10348) | Andrew Tonkovich (22/24) | Talk format |
| KPFK - Pacifica Performance Showcase | pperf, pacificaperformanceshowcase | Arts & Ent. | Fri 14:30 | 5 | [10387](https://qir.kpfk.org/dashboard/episodes/10387) | Donna Walker (13/17) | Entity mention gives "Dawn". |
| KPFK - Phil & Ted's Sexy Boomer Show | philandtedrsqsexyboomershow | Arts & Ent. | Tue 14:00 | 5 | [10502](https://qir.kpfk.org/dashboard/episodes/10502) | Ted Bonnet, Phil Proctor (17/26) | Title has first names only. |
| Travel Tips For Aztlan | traveltips, traveltipsforaztlan | Music | Sat 22:00 | 6 | [10415](https://qir.kpfk.org/dashboard/episodes/10415) | Mark Torres (14/19) | |
| Breakbeats And Rhymes | breakbeats | Music | Fri 22:00 | 5 | [10397](https://qir.kpfk.org/dashboard/episodes/10397) | MP (6/11) | |
| Canto Sin Fronteras | cantossin, cantosinfronteras | Music | Sat 18:00 | 5 | [10413](https://qir.kpfk.org/dashboard/episodes/10413) | Tania Mayagüel Torres (13/18) | |
| Canto Tropical | cantotropical | Music | Sat 20:00 | 5 | [10414](https://qir.kpfk.org/dashboard/episodes/10414) | Kathy Larumbera Díaz (5/17) | |
| CinemaScore | cinemascore | Music | Sun 17:00 | 5 | [10428](https://qir.kpfk.org/dashboard/episodes/10428) | John Santana (7/7) | |
| East Side Story Radio | eastsidestoryradio | Music | Fri 20:00 (18x) [ep] | 5 | [10396](https://qir.kpfk.org/dashboard/episodes/10396) | Anthony Bousalis (15/18) | |
| Global Village - Fri | gv_sergio, globalvillagefridays | Music | Fri 11:00 | 5 | [10383](https://qir.kpfk.org/dashboard/episodes/10383) | Sergio Melnichenko (11/18) | |
| Global Village - Tuesday | gv_tue, globalvillagetuesdays | Music | Tue 11:00 | 5 | [10497](https://qir.kpfk.org/dashboard/episodes/10497) | Gary Baca (17/17) | Gary Baca is also a CMS host of La Raza Radio. |
| Gospel Classics | gospelclassics | Music | Sun 06:00 | 5 | [10418](https://qir.kpfk.org/dashboard/episodes/10418) | Gil Fears (6/17) | A dormant key is titled "Edna Tatum's Gospel Classics". |
| In The Cut Radio | realrockriffsamprhyth | Music | Sun 00:00 | 5 | [10416](https://qir.kpfk.org/dashboard/episodes/10416) | DJ Ben Vera (17/18) | |
| KPFK - Global Village - Thurs | gv_john, theglobalvillagethursday | Music | Thu 11:00 | 5 | [10344](https://qir.kpfk.org/dashboard/episodes/10344) | John Schneider (16/18) | |
| Midnight Snack | deepend | Music | Sat 00:00 | 5 | [10398](https://qir.kpfk.org/dashboard/episodes/10398) | Dani (9/17) | |
| Nightscapes | lstation | Music | Sun 04:00 | 5 | [10417](https://qir.kpfk.org/dashboard/episodes/10417) | Jillian Rise (5/7) | |
| Reggae Central | reggaecent | Music | Sun 14:00 | 5 | [10427](https://qir.kpfk.org/dashboard/episodes/10427) | Chuck Foster (5/7) | |
| Roots Music and Beyond | aliveandpicking, rootsmusicbeyond3rdsaturdayalt, rootsmusicandbeyond, rootsmusicbeyond | Music | Sat 07:00 | 5 | [10402](https://qir.kpfk.org/dashboard/episodes/10402) | Mark Humphrey (6/18) | Rotating hosts |
| Soundwaves | soundwaves, soundwavesradio | Music | Mon 00:00 | 5 | [10434](https://qir.kpfk.org/dashboard/episodes/10434) | Val the Vandal (5/19) | |
| Stairway To Heaven | musicmix, stairwaytoheaven | Music | Mon 02:00 | 5 | [10435](https://qir.kpfk.org/dashboard/episodes/10435) | Teddy (4/13) | |
| World Massive | potira | Music | Sat 02:00 | 5 | [10399](https://qir.kpfk.org/dashboard/episodes/10399) | D Painter (7/17) | The key and the dormant "DJ Potira's Show" point to DJ Potira. |
| All Of The Above | allabove | Music | Sun 02:00 | 4 | [10184](https://qir.kpfk.org/dashboard/episodes/10184) | Django (6/6) | |
| KPFK - Perspectiva de Las Americas | perspectiva, perspectivadelasamericas | Music (mis-tagged? Spanish talk) | Mon 21:30 | 4 | [10472](https://qir.kpfk.org/dashboard/episodes/10472) | Brenda Martínez (23/25) | |
| Special Music Programming | specialmusicprogramm | Music | Tue 23:00 (17x) [ep] | 4 | [10286](https://qir.kpfk.org/dashboard/episodes/10286) | Rodrigo (3/11) | Filler slot |

### C. Active but no Q4 episodes (66), probably deactivate or ignore

Format is name (key), followed by the sample episode id and its last air date where any episode exists. Everything else has 0 episodes ever: these are discovery imports that were auto-activated (KPFK `discovery_auto_activate`).

- **PA - Local (36):** Access Unlimited, Beneath the Surface with Suzi Weissman (beneaththesurfacewithsuziweiss, a duplicate of bts_friday), Connect The Dots, Conversations On the Way: The Asafo Edition, Digital Village, Eagle & Condor: Be A Better Relative, Economic Update, Flip the Script, Global Voices for Justice, Hutchinson's Inside LA, Indymedia On Air, Inner Vision, KPFK - Beautiful Struggle (759, 2023-11-29), KPFK - CalState LA Community News Hour (9394, 2026-09-06), KPFK - Centroamerica Sin Censura (1402, 2026-03-03), KPFK - Deadline LA (764, 2020), KPFK - Experience Talks (769, 2019), KPFK - IMpact (777, 2021), KPFK - Ruben Luengas (783, 2019), KPFK - The People's Game (peoplegamea; 7412, 2026-07-31; AI suggests Alan Minsky 4/7), KPFK - Treasures Of The West (782, 2019), Letters & Politics, Liberated Sisters, On Contact, Questioning Everything with Tony Bates, Re:Work, Reality Check Live, Sounds of Transformation, Stephanie Miller Show, The BradCast with Brad Friedman (a third Brad Friedman group), The Michael Slate Show, The Out Agenda (theoutagenda, a duplicate of outagenda), Transforming Consciousness, Trump Watch, Voices de Libertad, Voices From the Frontline
- **PA - National+Synd (1):** KPFK - Laura Flanders and Friends (648, 2026-01-09)
- **Español (7):** ARRABALEROS DE MAGÓN, Edición Semanaria and Línea Abierta, El Vuelo Del Aguila y El Condor, Inquilinos N Accion, KPFK - ¿Que Pasa En Los Angeles? (1765, 2026-05-21), KPFK - MUSIQUEROS Y JUVENTUD (1409, 2026-03-03), Voces Jornaleras
- **News (1):** News
- **Special (4):** Alternative Radio Special, KPFK - Special Fund Drive Programming (7608), Special Fund Drive Programming a/b (7609, 7607)
- **Arts & Ent. (6):** David Feldman Show, Dialogos Culturales de Media Noche, LA Theater Works, Nuestra Voz (Cultural Segment), The Jimmy Dore Show, Why Poetry
- **Music (11):** Adventures In Stereo, Breakbeats & Rhymes, DJ Potira's Show, Edna Tatum's Gospel Classics, Evolution of the Groove, Head Room, One Track Mind, Radio Afrodicia, Real Rock, Riffs, & Rhythms, RISE, We Want The Funk
