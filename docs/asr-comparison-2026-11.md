# Transcription comparison: QIR (Groq) vs Pacifica Audio Services (Faster-Whisper Small)

*November 2026. Written for the GM, who has to decide whether Pacifica Audio Services' self-hosted
transcription can replace QIR's. This is evidence, not a recommendation.*

## The short version

- **On ordinary English talk, the two transcripts are 95–98% the same word for word.** For
  summaries, search and the QIR report, either one would mostly do.
- **The differences show up in four places**, and none of them has one clear winner:
  1. **Music and speech over music.** Pacifica's speech filter (VAD) threw away 60% of the
     Folkscene excerpt, including the song lyrics. It also dropped a 45-second Langston Hughes
     reading in the Hartmann show and a song in the Spanish show. QIR transcribed all of them,
     and what it produced reads coherently. KPFK runs music shows through QIR so the profanity
     check covers lyrics, and Pacifica's output as configured can't do that.
  2. **Spanish.** QIR guesses the language. In the Spanish show it turned about 60 words of
     Spanish speech into an **English translation**. The production transcript has the same flaw
     at the same spot. Pacifica forces Spanish, so it didn't do this. QIR can fix it cheaply (see
     the end of this doc).
  3. **Proper names.** Neither pipeline clearly wins. QIR got Langston Hughes, Woody Guthrie,
     "Hightower Lowdown" and the Nader Radio Hour web address right where Pacifica garbled them.
     Pacifica got "Michael Fuchs" and "Jesús Martínez" right where QIR slipped. Both wrote
     "Tom Hartman" for Thom Hartmann.
  4. **Captions.** Pacifica's raw segments average about 26 seconds and 400 characters, which is
     too long to use as caption cues. They do carry word timings, so a splitter could fix that. I
     couldn't see whether Pacifica already has one. QIR's cues are shorter (median about 5 s) but
     still run long.
- **Hallucination:** neither pipeline invented speech in silence or got stuck repeating
  itself in this sample. VAD's main effect here was **removing** content (lyrics, speech
  over music beds), not removing made-up text.
- **Cost and speed:** QIR costs **$0.04 per audio hour**: $0.06 for this whole test, about
  $1 a day if all 24 hours of airtime were transcribed. It took about 13 s per 15-minute
  excerpt. Pacifica has no per-hour fee. On this test machine it ran at about **0.1× real time**
  (1.5 min per 15 min) on 4 CPU cores, which works out to about 2.4 CPU-hours per day of airtime.
  That timing is indicative only, because their VPS has a different CPU.

**What's measured vs. what still needs ears:** the agreement figures, timings, cost, the VAD
drop-outs and the Spanish translation glitch are measured. Which transcript is *right* where they
disagree is not, apart from the few names checked against human-entered spellings. The
[listening packet](#listening-packet) settles that in about 20 minutes.

## Method

**Six recent KPFK episodes** were chosen from `episode_log`, read-only, all with audio live on
archive.kpfk.org. Each pipeline got **the same 15-minute excerpt, 2:00–17:00**, which skips the
station IDs at the top. The excerpt was cut from the archive MP3 with a stream copy (no
re-encode), so both pipelines started from identical bytes.

| Episode | Show | Category | Why it's in the set |
|---|---|---|---|
| 11015 | Background Briefing (2026-11-18) | Public Affairs – National | News / public-affairs talk |
| 10892 | Ralph Nader Hour (2026-11-15) | Public Affairs – National | Name-heavy interview |
| 10986 | Suplemento Comunitario (2026-11-17) | Español | Spanish-language |
| 10898 | Folkscene (2026-11-15) | Music | Music |
| 11004 | Thom Hartmann Program (2026-11-18) | Public Affairs – National | Call-in |
| 10932 | Scholars Circle (2026-11-15) | Public Affairs – Local | Confessor host and guests filled in by a producer |

**QIR** was tested exactly as it runs on main at commit `c93f357`, using the shipped code
(`scripts/compare-asr/run-qir.ts`):
- ffmpeg converts to mono 16 kHz 64k AAC (`lib/transcription/chunking.ts`).
- `groqProvider` sends it to `whisper-large-v3-turbo` with `verbose_json`, and the language is
  auto-detected.
- No vocabulary hint, because that's off for KPFK.
- The station and show correction rules and `buildVtt` run on the output.

Another session is currently adding a speech/no-speech filter and word-level caption splitting
to the Groq path. Neither is in this test. Rerunning after those land costs about $0.06 (see
`scripts/compare-asr/README.md`).

**Pacifica** was tested with the settings from their `tools/benchmark-asr.py`, as called by
`tools/run_archive_batch.py` (`scripts/compare-asr/run_pacifica.py`):
- Model `Systran/faster-whisper-small`, CPU, int8, 4 threads.
- `BatchedInferencePipeline` with batch size 4, beam 3, best_of 3, temperature 0.
- `vad_filter=True`, `word_timestamps=True`, `condition_on_previous_text=False`.
- Language forced to `es` for the Español category and `en` for everything else.
- faster-whisper 1.2.1 and ctranslate2 4.9.0, matching their worker. PyAV is pinned below 16
  because faster-whisper 1.2.1 doesn't run on newer PyAV.

**Caveat:** I couldn't attach their repository to this session, so these settings come from the
brief, not from reading their code. Their caption builder wasn't reproduced either. "Pacifica
captions" below means their raw segments.

**Machine:** Intel Xeon @ 2.10 GHz, 4 cores visible, in a cloud container. Their production
worker is a 4-vCPU Contabo VPS, so treat CPU speed as indicative.

**Scoring** was done with `scripts/compare-asr/score.py`. **There is no human reference
transcript.** The name check is the only measure against ground truth. Everything else measures
how the two transcripts *differ*:
- Words are compared after lower-casing and stripping punctuation. Hyphens and dots split
  words, so "right-wing" counts the same as "right wing" and "kpfk.org" the same as "kpfk .org".
- "Agreement" is the share of words that line up between the two transcripts (difflib matching
  blocks).

## Results

### Overall

| Episode | Words QIR / Pacifica | Agreement | Disagreements >3 words | QIR wall time | Pacifica wall time (× real time) | QIR cost |
|---|---|---|---|---|---|---|
| Background Briefing | 2422 / 2409 | **98.0%** | 1 | 14.1 s | 90 s (0.10) | $0.010 |
| Ralph Nader Hour | 2508 / 2510 | **97.9%** | 5 | 13.6 s | 93 s (0.10) | $0.010 |
| Suplemento Comunitario | 1550 / 1466 | 82.4% | 22 | 13.4 s | 75 s (0.08) | $0.010 |
| Folkscene (music) | 971 / 573 | 59.8% | 18 | 11.5 s | 29 s (0.03) | $0.010 |
| Thom Hartmann (call-in) | 2212 / 2137 | **95.4%** | 6 | 13.6 s | 85 s (0.09) | $0.010 |
| Scholars Circle | 2406 / 2350 | **97.3%** | 11 | 13.0 s | 88 s (0.10) | $0.010 |
| **Total (90 audio-min)** | | | | **79 s** | **470 s** (+1.5 s model load) | **$0.06** |

QIR's wall time includes the ffmpeg encode and the round trip to Groq. Pacifica's ran faster on
Folkscene because VAD skipped most of the excerpt.

On the English talk shows, most of the short disagreements are fillers. QIR keeps "you know",
"uh" and "and yet and yet", and Pacifica drops them. That's a style difference more than an
error, and it inflates QIR's word count slightly.

### 1. Names (the metric that matters most)

The reference list came only from what people typed: Confessor host, guest and rundown; the
show's `transcript_vocabulary`; and the show name. Most names on that list weren't spoken in a
15-minute excerpt. These are the ones at least one pipeline produced:

| Episode | Reference spelling | QIR | Pacifica |
|---|---|---|---|
| Hartmann | Thom Hartmann (vocabulary) | "Tom Hartman" ×5, 0 exact | "Tom Hartman" ×4, 0 exact |
| Folkscene | Allen Larman (vocabulary) | "Alan Larman" | "Alan Larmann" |
| Folkscene | Kat Griffin | ✓ | ✓ |
| Suplemento | Oscar Ulloa (vocabulary) | "Oscar M Ulloa" ×3 | "Óscar M. Ulloa" ×1, "Óscar M Uyoa" ×2 |
| Scholars Circle | Doug Becker | ✓ | ✓ |
| Scholars Circle | Michael D. Smith | "Michael Smith" | "Michael Smith" |
| Nader | Ralph Nader | ✓ ×3 | ✓ ×3 |

**The human-referenced names come out about a tie.** Both pipelines make the same mistakes
("Tom Hartman", "Alan Larman"). QIR is more consistent on "Ulloa".

A one-line correction rule (Settings → Corrections) would fix "Tom Hartman" in QIR for every
future episode. I didn't see whether Pacifica has an equivalent.

The next table covers names that came from the AI summary. **These are biased toward QIR**,
because the summary was generated from QIR's own transcript. The calls of right and wrong below
are my reading of the text, so confirm them by ear in the packet.

| Where | QIR | Pacifica |
|---|---|---|
| Background Briefing | "Michael Fuchs" ×2, "Michael Fuse" ×1 | "Michael Fuchs" ×3 ✓ |
| Suplemento 13:12 | "Jesus Mart" / "Jes Mart" (inside the translation glitch) | "Jesús Martínez" ✓ |
| Hartmann 7:28 | "That's Langston Hughes" ✓ (it follows his poem *Democracy*) | "It's lengths and hues" |
| Nader 6:39 | "You know, Woody Guthrie" | "What do you got three" |
| Nader 13:47 | "Hightower Lowdown" ✓ | "high tower low down" |
| Nader 14:53 | "ralphnaderradiohour.com" ✓ | "RalphNeederRadioHour .com" |
| Hartmann 4:13 | "Kana" (Ro Khanna) ✗ | "Conor" ✗ |

### 2. Where they disagree

The full tables are in the packet. In outline:

- **Background Briefing:** one disagreement longer than 3 words. QIR has "And I think that"
  where Pacifica has nothing.
- **Nader:** five disagreements, all names or URLs (above), plus two short phrases.
- **Scholars Circle:** eleven disagreements, almost all fillers QIR kept and Pacifica dropped.
  Also "Daphne Kohler" at 14:45 (QIR) vs nothing (Pacifica).
- **Hartmann:** at 6:37, QIR has 66 words of a Langston Hughes reading. Pacifica has nothing
  for that stretch: its VAD dropped 18 s of it and the model emitted nothing for the rest.
- **Suplemento:** QIR transcribes an English protest song at 8:34 (140 words) that Pacifica
  reduces to one word. At 3:27, Pacifica has a ~25-word station promo that QIR is missing. At
  2:00 the two disagree outright and need a listen. And there's the translation glitch below.
- **Folkscene:** QIR transcribes the songs, including a Steve Earle station ID and coherent
  lyrics. Pacifica outputs fragments: "I'll sit in a row Brasov's boy with potsy and hawk shore"
  vs QIR's "hitting the road with the Brazos boys With Patsy and Hawkshore".

### 3. Hallucination, music and silence

| Episode | Silence ≥3 s | Words emitted in silence (QIR / Pacifica) | Repetition loops | Stock phrases ("thanks for watching"…) | Audio Pacifica's VAD dropped | QIR words inside those dropped stretches |
|---|---|---|---|---|---|---|
| Background Briefing | 0 s | 0 / 0 | none | none | 0 s | 0 |
| Nader | 0 s | 0 / 0 | none | none | 0 s | 0 |
| Suplemento | 4.7 s | 0 / 0 | Pacifica: "no" ×4 | none | **164 s** | 127 (song lyrics, station promo) |
| Folkscene | 0 s | 0 / 0 | none | none | **537 s of 900** | 354 (song lyrics) |
| Hartmann | 10.4 s | 4 / 1 | both: "over and" ×4–5 (real speech) | none | 45 s | 31 |
| Scholars Circle | 0 s | 0 / 0 | none | none | 0 s | 0 |

Silence here means below −40 dB for at least 3 s. The 4 QIR words "in silence" on Hartmann are
"incumbent Dan Sullivan 50.1", which looks like quiet speech, not invention.

**VAD dropped music, not hallucinations.** On talk shows VAD changed almost nothing (0–45 s
dropped). On music it removed most of the audio, and the QIR text from those stretches reads
like real lyrics, not Whisper's typical made-up filler. Whether you *want* lyrics is a policy
question:
- For **profanity/compliance screening of music shows**, you do, and that's why KPFK processes
  music shows at all.
- For **captions and search**, lyrics are arguably noise.

This sample had no long dead air. The hallucination-in-silence risk that VAD guards against
wasn't tested here, so don't read this as "QIR never hallucinates".

### 4. Captions

These are raw cues: QIR's VTT as stored, Pacifica's segments. 84 characters is two standard
caption lines.

| Episode | Cues QIR / Pacifica | Median length QIR / Pacifica | Longest QIR / Pacifica | Cues >84 chars QIR / Pacifica |
|---|---|---|---|---|
| Background Briefing | 142 / 36 | 5.4 s, 91 ch / 26.3 s, 394 ch | 27 s, 526 ch / 30 s, 556 ch | 89 / 36 |
| Nader | 168 / 36 | 4.9 s, 83 ch / 26.5 s, 413 ch | 20 s, 309 ch / 30 s, 547 ch | 80 / 35 |
| Suplemento | 152 / 32 | 4.0 s, 40 ch / 23.9 s, 261 ch | 30 s, 334 ch / 34 s, 463 ch | 29 / 30 |
| Folkscene | 141 / 12 | 4.3 s, 32 ch / 46.7 s, 262 ch | 30 s, 131 ch / 159 s, 467 ch | 3 / 10 |
| Hartmann | 203 / 31 | 3.3 s, 56 ch / 27.4 s, 395 ch | 18 s, 221 ch / 42 s, 540 ch | 51 / 30 |
| Scholars Circle | 151 / 34 | 5.5 s, 91 ch / 26.8 s, 385 ch | 28 s, 363 ch / 30 s, 549 ch | 89 / 34 |

Neither set of raw cues is caption-ready:
- Pacifica's are about 30-second blocks, because the batched pipeline emits one segment per VAD
  chunk. Its word timestamps would allow a proper splitter, which I didn't see.
- QIR's are closer, but up to 60% of cues on dense talk exceed two lines. The word-level
  splitting being added in another session targets exactly this, so rerun this table after it
  lands.

### 5. Spanish

| | QIR | Pacifica |
|---|---|---|
| Language | auto-detected **Spanish** ✓ (production transcript also Spanish) | forced `es` |
| English words output in segments that read as English | 127 | 0 |

Of QIR's 127 English words, about 70 are an English protest song that really is sung in
English. The other **~60 are an English *translation* of Spanish speech** (11:20–13:15 into
the MP3: "They were exposed to radioactive levels… what do you think if for example I like to
give the voice to the colleague Jesus Mart…"). Pacifica has the Spanish original there. **The
same glitch is in the production transcript of this episode** ("perhaps the dark one for many
people who were recently watching the movie of Oppenheimer…"), so this isn't a harness
artifact.

Forcing Spanish has a cost of its own: Pacifica reduced the English song to a single word,
"escuchamos".

## Listening packet

The packet is published as a private page: https://claude.ai/artifact/Gv7vjUhhqxmB5zpjkT3tq9.
Share it from the page's Share menu. The same file is regenerated locally as
`reports/asr-compare/listening-packet.html`, which has inline players, by
`scripts/compare-asr/score.py`. It isn't committed.

It shows the **10 biggest disagreements per episode**, longest first. Each row has:
- the time into the original MP3
- a link that plays that moment from archive.kpfk.org
- QIR's text and Pacifica's text
- a "who's right?" pick (QIR / Pacifica / both OK / neither) and a note field

Picks stay in your browser. "Copy results" gives them back as a table. The same rows are in
`reports/asr-compare/report.md`.

The rows most worth your ears:
- Suplemento 2:00, 3:27 and 11:20
- Hartmann 6:37
- Nader 6:39
- Folkscene 4:45 and 5:50

## What this does and doesn't settle

**Settled by measurement:**
- Talk-show transcripts are near-identical.
- Pacifica's VAD removes music and speech over music beds.
- QIR's auto language detection can translate Spanish into English, and does so in production.
- Raw caption segmentation differs a lot between the two.
- Cost: $0.04 per audio hour vs no per-hour fee.
- Speed: about 13 s vs about 1.5 min per 15 minutes on 4 cores.

**Not settled without listening:**
- Who's right in each disagreement.
- Whether QIR's lyric text is accurate.
- Whether Pacifica's missing words are real speech.

**Not tested:**
- Long dead air, where VAD should help most.
- Whole episodes. Chunk boundaries every 15 min in QIR aren't exercised by a single excerpt.
- Pacifica's own caption builder and any post-processing beyond the settings above.
- Their real hardware.

**Things QIR could adopt either way:**
- Pass the show's language (`show_keys.primary_language`, or the Español category) to Groq
  instead of auto-detecting. That would remove the translation glitch.
- Add a "Tom Hartman → Thom Hartmann" correction rule.

Neither change depends on this decision.
