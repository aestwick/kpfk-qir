#!/usr/bin/env python3
"""ASR comparison, step 2b: Pacifica Audio Services' transcription settings.

Reproduces the production settings of pacifica-foundation/pacifica-audio-services
as given in its tools/benchmark-asr.py (called by tools/run_archive_batch.py):

  model            Systran/faster-whisper-small, CPU, int8, cpu_threads=4
  pipeline         BatchedInferencePipeline, batch_size=4
  decoding         beam_size=3, best_of=3, temperature=0,
                   condition_on_previous_text=False, word_timestamps=True
  vad              vad_filter=True (faster-whisper's batched default VAD options)
  language         "es" for the "Español" catalog category, else "en"
                   (from manifest.json; prepare.ts decides it)
  versions         faster-whisper 1.2.1 / ctranslate2 4.9.0 (ops/worker/requirements.txt)

Their repo could not be attached to the session that wrote this, so these
settings come from the brief, not from reading their code. Their caption
builder was not reproduced: cues here are the raw segments.

  python3 -m venv .venv && .venv/bin/pip install faster-whisper==1.2.1 ctranslate2==4.9.0
  .venv/bin/python -I scripts/compare-asr/run_pacifica.py [--out reports/asr-compare] [--episodes 11015,10892] [--fresh] [--threads 4]

Writes <out>/pacifica/<id>.json.
"""
import argparse
import json
import os
import platform
import sys
import time


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="reports/asr-compare")
    ap.add_argument("--episodes", default="")
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--model", default="Systran/faster-whisper-small")
    a = ap.parse_args()

    import ctranslate2
    import faster_whisper
    from faster_whisper import BatchedInferencePipeline, WhisperModel
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import get_speech_timestamps

    out = os.path.abspath(a.out)
    manifest = json.load(open(os.path.join(out, "manifest.json")))
    only = {int(x) for x in a.episodes.split(",") if x.strip()}
    os.makedirs(os.path.join(out, "pacifica"), exist_ok=True)

    cpu = "unknown"
    try:
        for line in open("/proc/cpuinfo"):
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        cpu = platform.processor() or "unknown"

    t_load = time.time()
    model = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=a.threads)
    pipe = BatchedInferencePipeline(model=model)
    load_sec = time.time() - t_load
    print(f"[pacifica] model {a.model} loaded in {load_sec:.1f}s (faster-whisper {faster_whisper.__version__}, ctranslate2 {ctranslate2.__version__}, {a.threads} threads, {cpu}, {os.cpu_count()} cores visible)", flush=True)

    for ep in manifest["episodes"]:
        if only and ep["id"] not in only:
            continue
        dest = os.path.join(out, "pacifica", f"{ep['id']}.json")
        if os.path.exists(dest) and not a.fresh:
            print(f"[pacifica] {ep['id']}: cached (use --fresh to rerun)")
            continue
        audio_path = os.path.join(out, ep["audio"])
        lang = ep.get("pacifica_language")
        t0 = time.time()
        segments_iter, info = pipe.transcribe(
            audio_path,
            language=lang,
            batch_size=4,
            beam_size=3,
            best_of=3,
            temperature=0,
            vad_filter=True,
            word_timestamps=True,
            condition_on_previous_text=False,
        )
        segs = []
        for s in segments_iter:  # generator: the work happens here
            segs.append({
                "start": s.start,
                "end": s.end,
                "text": s.text.strip(),
                "avg_logprob": s.avg_logprob,
                "no_speech_prob": s.no_speech_prob,
                "compression_ratio": s.compression_ratio,
                "words": [{"start": w.start, "end": w.end, "word": w.word, "p": w.probability} for w in (s.words or [])],
            })
        wall = time.time() - t0
        # The speech regions their VAD kept (same options the pipeline used), for the music/silence check.
        audio = decode_audio(audio_path, sampling_rate=16000)
        speech = [{"start": r["start"] / 16000, "end": r["end"] / 16000} for r in get_speech_timestamps(audio, info.vad_options)]
        rec = {
            "pipeline": "pacifica",
            "model": a.model,
            "settings": {
                "compute_type": "int8", "cpu_threads": a.threads, "batch_size": 4, "beam_size": 3, "best_of": 3,
                "temperature": 0, "vad_filter": True, "word_timestamps": True, "condition_on_previous_text": False,
                "language_forced": lang,
            },
            "versions": {"faster_whisper": faster_whisper.__version__, "ctranslate2": ctranslate2.__version__, "python": sys.version.split()[0]},
            "cpu": cpu,
            "cores_visible": os.cpu_count(),
            "model_load_sec": load_sec,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration_sec": info.duration,
            "duration_after_vad_sec": info.duration_after_vad,
            "wall_sec": {"transcribe": wall},
            "vad_speech": speech,
            "text": " ".join(s["text"] for s in segs if s["text"]),
            "segments": segs,
        }
        json.dump(rec, open(dest, "w"), ensure_ascii=False, indent=1)
        print(f"[pacifica] {ep['id']} {ep['show_key']}: {info.language} · {len(segs)} segments · {wall:.1f}s wall (RTF {wall / info.duration:.3f}) · VAD kept {info.duration_after_vad:.0f}/{info.duration:.0f}s", flush=True)


if __name__ == "__main__":
    main()
