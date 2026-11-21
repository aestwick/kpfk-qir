# compare-asr — QIR vs Pacifica Audio Services, side by side

A reusable harness that transcribes the **same excerpt** of the same KPFK broadcasts with
two pipelines and scores how they differ:

| | QIR (this repo) | Pacifica Audio Services |
|---|---|---|
| Engine | Groq `whisper-large-v3-turbo` (API) | Faster-Whisper **Small**, CPU, int8 |
| Input | ffmpeg → mono 16 kHz 64k AAC M4A (`lib/transcription/chunking.ts`) | the MP3, decoded by faster-whisper |
| Decoding | Groq defaults, `verbose_json`, language auto-detected | `BatchedInferencePipeline` batch 4, beam 3, best_of 3, temperature 0, `condition_on_previous_text=False`, `word_timestamps=True` |
| Speech filter | none | `vad_filter=True` (Silero VAD) |
| Language | auto | forced `es` for the "Español" category, else `en` |
| After | station/show correction rules (`lib/transcription/corrections.ts`), `buildVtt` | — |

`run-qir.ts` calls the shipped code (`groqProvider`, `CHUNK_ENCODE_ARGS`, `applyCorrections`,
`buildVtt`), so it tests what production runs at the commit you have checked out — it records
the git SHA in every output. Pacifica's settings come from their `tools/benchmark-asr.py` as
called by `tools/run_archive_batch.py`; versions are pinned to their worker in `requirements.txt`.

## Run it

```bash
npm ci                                                     # QIR side
python3 -m venv .venv-asr && .venv-asr/bin/pip install -r scripts/compare-asr/requirements.txt

npx tsx scripts/compare-asr/prepare.ts                     # episodes + excerpts + reference names (read-only DB)
npx tsx scripts/compare-asr/run-qir.ts                     # Groq: ~15 s and ~$0.01 per excerpt
.venv-asr/bin/python -I scripts/compare-asr/run_pacifica.py   # CPU: ~1.5 min per excerpt on 4 cores
python3 -I scripts/compare-asr/score.py                    # tables + listening packet
```

Everything lands in `reports/asr-compare/` (gitignored — audio and full transcripts are never committed):
`manifest.json`, `audio/`, `qir/<id>.json`, `pacifica/<id>.json`, `results.json`, `report.md`,
`listening-packet.html` (open in a browser; each row plays just the disputed span from archive.kpfk.org).

### Options

- `prepare.ts --episodes 11015,10892 --start 120 --duration 900` — any KPFK episode ids (default set in
  `episodes.json`); excerpt offset/length in seconds. `--db psql` uses `DATABASE_URL` instead of the
  Claude-session read-only Supabase MCP endpoint (use a read-only role).
- `run-qir.ts --episodes … --fresh --model whisper-large-v3` — `--fresh` ignores cached outputs.
- `run_pacifica.py --episodes … --fresh --threads 4`
- All steps take `--out <dir>`, so a second run can sit beside the first.

### Rerunning after a QIR change

Outputs are cached per episode. After the Groq path changes (e.g. a speech/no-speech segment filter or
word-level caption splitting), re-run only our side into a new folder and re-score:

```bash
cp -r reports/asr-compare reports/asr-compare-new && rm -r reports/asr-compare-new/qir
npx tsx scripts/compare-asr/run-qir.ts --out reports/asr-compare-new
python3 -I scripts/compare-asr/score.py --out reports/asr-compare-new
```

The Pacifica outputs are reused, so the second run costs ~$0.06 and a minute.

## What the scores mean (and don't)

There is **no human reference transcript**. Only the name check compares against ground truth
(names a person typed: Confessor host/guest/rundown, `transcript_vocabulary`, the show name). Names
the AI summary extracted are listed separately because they came from QIR's own transcript.
Everything else — agreement %, disagreement spans, words in silence, words where VAD heard no speech —
measures *difference*, not accuracy. The listening packet is how a person settles who is right.
