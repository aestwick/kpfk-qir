#!/usr/bin/env python3
"""ASR comparison, step 3: score QIR vs Pacifica side by side. Standard library only.

  python3 -I scripts/compare-asr/score.py [--out reports/asr-compare]

Reads <out>/manifest.json, <out>/qir/<id>.json, <out>/pacifica/<id>.json and writes
  <out>/results.json         every number below, per episode
  <out>/report.md            the tables, ready to paste into a findings doc
  <out>/listening-packet.html  the 10 biggest disagreements per episode, with audio

There is no human reference transcript. Nothing here says which pipeline is RIGHT
except the name check (against human-entered names); everything else measures
how the two DIFFER, and the listening packet is how a person settles who is right.
"""
import argparse
import difflib
import html
import json
import os
import re
import statistics
import subprocess
import unicodedata

HALLUCINATION_PHRASES = [
    "thank you for watching", "thanks for watching", "please subscribe", "subtitles by", "amara.org",
    "transcribed by", "gracias por ver", "subtítulos", "suscríbete", "❤", "♪",
]


# ---------- text helpers ----------

def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm_word(w: str) -> str:
    w = w.lower().replace("’", "'")
    w = re.sub(r"[^\w']+", "", w)
    return w.strip("'_")


def subwords(piece: str):
    """Split on anything but letters/digits/apostrophes, so "right-wing" == "right wing",
    "kpfk.org" == "kpfk .org" and "90.7" == "90 .7" (Pacifica spaces out punctuation)."""
    return [n for n in (norm_word(x) for x in re.findall(r"[\w'’]+", piece)) if n]


def tokens_from_segments(segments, has_words: bool):
    """[(original_word, normalized, start_sec)] — QIR has segment timing only, so a
    word's time is interpolated by character position inside its segment."""
    out = []
    for s in segments:
        if has_words and s.get("words"):
            for w in s["words"]:
                for piece in w["word"].split():
                    for k, n in enumerate(subwords(piece)):
                        out.append((piece if k == 0 else "", n, w["start"]))
            continue
        text = s["text"].strip()
        if not text:
            continue
        span = max(0.0, s["end"] - s["start"])
        for m in re.finditer(r"\S+", text):
            for k, n in enumerate(subwords(m.group(0))):
                out.append((m.group(0) if k == 0 else "", n, s["start"] + span * (m.start() / max(1, len(text)))))
    return out


EN_WORDS = set("the and of to is that it you we they this was for with are have what but not be on at so".split())
ES_WORDS = set("el la los las de que y en un una es por para con no se lo del al pero como más muy".split())


def language_mix(segments):
    """Words in segments that read as English vs Spanish (function-word vote)."""
    en = es = 0
    en_samples = []
    for s in segments:
        ws = [norm_word(w) for w in s["text"].split()]
        e = sum(w in EN_WORDS for w in ws)
        sp = sum(w in ES_WORDS for w in ws)
        if e + sp < 2:
            continue
        if e > sp:
            en += len(ws)
            en_samples.append(s["text"].strip())
        else:
            es += len(ws)
    return {"english_words": en, "spanish_words": es, "english_samples": en_samples}


def fmt_ts(sec: float) -> str:
    sec = max(0, int(round(sec)))
    return f"{sec // 60}:{sec % 60:02d}"


# ---------- 1. names ----------

def name_check(text: str, names):
    """Per name: exact (case-insensitive) hits, near-miss variants, verdict."""
    words = re.findall(r"[\w'’.-]+", text)
    folded = [strip_accents(norm_word(w)) for w in words]
    rows = []
    for name in names:
        exact = len(re.findall(r"(?<!\w)" + re.escape(name) + r"(?!\w)", text, flags=re.I))
        target = strip_accents(" ".join(norm_word(p) for p in name.split() if norm_word(p)))
        k = len(target.split())
        variants = {}
        claimed = set()  # word positions already used by a k-word match (exact or near)
        if k:
            for i in range(0, max(0, len(words) - k + 1)):
                cand = " ".join(x for x in folded[i:i + k] if x)
                if cand == target:
                    claimed.update(range(i, i + k))
            for size in [k] + [z for z in (k - 1, k + 1) if z >= 1 and z != k]:
                for i in range(0, max(0, len(words) - size + 1)):
                    if size != k and claimed.intersection(range(i, i + size)):
                        continue  # a split/merged-word variant only where no k-word match sits
                    cand = " ".join(x for x in folded[i:i + size] if x)
                    if not cand or cand[0] != target[0]:
                        continue
                    a, b = (cand, target) if size == k else (cand.replace(" ", ""), target.replace(" ", ""))
                    r = difflib.SequenceMatcher(None, a, b).ratio()
                    if r < (0.8 if size == k else 0.9):
                        continue
                    orig = " ".join(words[i:i + size]).strip(".,;:!?\"'“”")
                    if " ".join(subwords(orig)) == " ".join(subwords(name)):
                        continue  # the exact form (punctuation aside), counted above
                    variants[orig] = variants.get(orig, 0) + 1
                    claimed.update(range(i, i + size))
        # Surname alone, capitalised (lower-case "masters"/"green" are ordinary words).
        surname = name.split()[-1] if len(name.split()) > 1 else None
        sur_exact = len(re.findall(r"(?<![\w])" + re.escape(surname) + r"(?![\w])", text)) if surname and len(surname) >= 4 else 0
        near = sum(variants.values())
        verdict = "exact" if exact and not near else "mixed" if exact and near else "near-miss" if near else "missing"
        rows.append({"name": name, "exact": exact, "near_miss": near, "variants": sorted(variants, key=lambda v: -variants[v])[:3],
                     "surname_exact": sur_exact, "verdict": verdict})
    return rows


# ---------- 2. alignment ----------

def join(toks):
    return " ".join(t[0] for t in toks if t[0])


def align(qt, pt):
    a = [t[1] for t in qt]
    b = [t[1] for t in pt]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    matched = sum(bl.size for bl in sm.get_matching_blocks())
    agreement = 2 * matched / max(1, len(a) + len(b))
    # Merge non-equal opcodes separated by short (<=2 word) equal runs into spans.
    spans = []
    cur = None
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            if cur and (i2 - i1) <= 2 and (j2 - j1) <= 2:
                cur["i2"], cur["j2"] = i2, j2
                cur["bridge"] += i2 - i1
                continue
            if cur:
                spans.append(cur)
                cur = None
            continue
        if cur is None:
            cur = {"i1": i1, "i2": i2, "j1": j1, "j2": j2, "bridge": 0}
        else:
            cur["i2"], cur["j2"] = i2, j2
    if cur:
        spans.append(cur)
    out = []
    for s in spans:
        qa, pa = s["i2"] - s["i1"], s["j2"] - s["j1"]
        size = max(qa, pa) - s["bridge"]
        if max(qa, pa) <= 3:
            continue
        t_q = qt[s["i1"]][2] if s["i1"] < len(qt) else (qt[-1][2] if qt else 0)
        t_p = pt[s["j1"]][2] if s["j1"] < len(pt) else (pt[-1][2] if pt else 0)
        start = t_p if pa else t_q  # Pacifica has word timestamps; prefer them
        if qa and pa:
            start = min(t_q, t_p)
        end_q = qt[s["i2"] - 1][2] if qa else start
        end_p = pt[s["j2"] - 1][2] if pa else start
        out.append({
            "start": start, "end": max(end_q, end_p, start) + 2,
            "size": size, "qir_words": qa, "pacifica_words": pa,
            "qir": join(qt[s["i1"]:s["i2"]]),
            "pacifica": join(pt[s["j1"]:s["j2"]]),
            "ctx_before": join(qt[max(0, s["i1"] - 4):s["i1"]]),
            "ctx_after": join(qt[s["i2"]:s["i2"] + 4]),
        })
    return agreement, len(a), len(b), out


# ---------- 3. hallucination / music ----------

def repetition_loops(norm_words, min_repeats=4):
    """Runs where an n-gram (n=1..6) repeats back-to-back >= min_repeats times."""
    loops = []
    i, n_words = 0, len(norm_words)
    while i < n_words:
        found = None
        for n in range(1, 7):
            gram = norm_words[i:i + n]
            if len(gram) < n:
                break
            reps = 1
            while norm_words[i + reps * n:i + (reps + 1) * n] == gram:
                reps += 1
            if reps >= min_repeats:
                found = (n, reps, " ".join(gram))
                break
        if found:
            loops.append({"at_word": i, "ngram": found[2], "repeats": found[1]})
            i += found[0] * found[1]
        else:
            i += 1
    return loops


def silences(audio_path, noise_db=-40, min_dur=3.0):
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", audio_path, "-af",
                            f"silencedetect=noise={noise_db}dB:d={min_dur}", "-f", "null", "-"],
                           capture_output=True, text=True, timeout=600)
    except Exception:
        return []
    out, start = [], None
    for line in r.stderr.splitlines():
        m = re.search(r"silence_start: ([\d.]+)", line)
        if m:
            start = float(m.group(1))
        m = re.search(r"silence_end: ([\d.]+)", line)
        if m and start is not None:
            out.append((start, float(m.group(1))))
            start = None
    return out


def words_in(intervals, toks):
    return sum(1 for t in toks if any(a <= t[2] < b for a, b in intervals))


def non_speech(vad_speech, total, min_gap=3.0):
    gaps, prev = [], 0.0
    for r in vad_speech:
        if r["start"] - prev >= min_gap:
            gaps.append((prev, r["start"]))
        prev = max(prev, r["end"])
    if total - prev >= min_gap:
        gaps.append((prev, total))
    return gaps


# ---------- 4. captions ----------

def caption_stats(segments):
    cues = [s for s in segments if s["text"].strip()]
    durs = [max(0.0, s["end"] - s["start"]) for s in cues]
    lens = [len(s["text"].strip()) for s in cues]
    return {
        "cues": len(cues),
        "median_sec": round(statistics.median(durs), 1) if durs else 0,
        "max_sec": round(max(durs), 1) if durs else 0,
        "median_chars": int(statistics.median(lens)) if lens else 0,
        "max_chars": max(lens) if lens else 0,
        "over_7s": sum(1 for d in durs if d > 7),
        "over_84_chars": sum(1 for x in lens if x > 84),
    }


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="reports/asr-compare")
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    manifest = json.load(open(os.path.join(out, "manifest.json")))
    offset = manifest["start_sec"]
    results = []

    for ep in manifest["episodes"]:
        qp, pp = os.path.join(out, "qir", f"{ep['id']}.json"), os.path.join(out, "pacifica", f"{ep['id']}.json")
        if not (os.path.exists(qp) and os.path.exists(pp)):
            print(f"[score] {ep['id']}: missing a pipeline output — skipped")
            continue
        q, p = json.load(open(qp)), json.load(open(pp))
        qt = tokens_from_segments(q["segments"], has_words=False)
        pt = tokens_from_segments(p["segments"], has_words=True)
        q_text = " ".join(s["text"] for s in q["segments"])
        p_text = p["text"]

        ref = ep["reference"]
        headline = list(dict.fromkeys(ref["human"] + ref["vocabulary"] + [ref["show_name"]]))
        names = {"headline": {"qir": name_check(q_text, headline), "pacifica": name_check(p_text, headline)},
                 "ai_extracted": {"qir": name_check(q_text, ref["ai_extracted"]), "pacifica": name_check(p_text, ref["ai_extracted"])}}

        agreement, nq, np_, spans = align(qt, pt)
        spans.sort(key=lambda s: -s["size"])

        audio = os.path.join(out, ep["audio"])
        sil = silences(audio)
        gaps = non_speech(p.get("vad_speech", []), p.get("duration_sec") or 900)
        gap_secs = sum(b - a for a, b in gaps)
        q_in_gaps = [t for t in qt if any(a <= t[2] < b for a, b in gaps)]
        halluc = {
            "qir": {"loops": repetition_loops([t[1] for t in qt]), "words_in_silence": words_in(sil, qt),
                    "stock_phrases": [ph for ph in HALLUCINATION_PHRASES if ph in q_text.lower()]},
            "pacifica": {"loops": repetition_loops([t[1] for t in pt]), "words_in_silence": words_in(sil, pt),
                         "stock_phrases": [ph for ph in HALLUCINATION_PHRASES if ph in p_text.lower()]},
            "qir_text_in_silence": join([t for t in qt if any(a <= t[2] < b for a, b in sil)]),
            "pacifica_text_in_silence": join([t for t in pt if any(a <= t[2] < b for a, b in sil)]),
            "silences": [[round(a, 1), round(b, 1)] for a, b in sil],
            "silence_sec": round(sum(b - a for a, b in sil), 1),
            "vad_non_speech_sec": round(gap_secs, 1),
            "vad_non_speech_regions": [[round(a, 1), round(b, 1)] for a, b in gaps],
            "qir_words_where_vad_heard_no_speech": len(q_in_gaps),
            "qir_text_where_vad_heard_no_speech": join(q_in_gaps)[:1500],
            "words_per_min": {
                "qir": [sum(1 for t in qt if m * 60 <= t[2] < (m + 1) * 60) for m in range(15)],
                "pacifica": [sum(1 for t in pt if m * 60 <= t[2] < (m + 1) * 60) for m in range(15)],
            },
        }

        res = {
            "id": ep["id"], "role": ep["role"], "show": ep["show_name"], "category": ep["category"],
            "air_date": ep["air_date"], "mp3_url": ep["mp3_url"], "offset_sec": offset,
            "language": {"qir_detected": q.get("language"), "pacifica": p.get("language"),
                         "pacifica_forced": p["settings"]["language_forced"], "expected": "Spanish" if ep["category"] == "Español" else "English"},
            "words": {"qir": nq, "pacifica": np_},
            "language_mix": {"qir": language_mix(q["segments"]), "pacifica": language_mix(p["segments"])},
            "agreement": round(agreement, 4),
            "disagreements_over_3_words": len(spans),
            "spans": spans,
            "names": names,
            "hallucination": halluc,
            "captions": {"qir": caption_stats(q["segments"]), "pacifica": caption_stats(p["segments"])},
            "wall_sec": {"qir": q["wall_sec"]["total"], "pacifica": p["wall_sec"]["transcribe"]},
            "pacifica_rtf": round(p["wall_sec"]["transcribe"] / max(1, p.get("duration_sec") or 900), 3),
            "qir_cost_usd": q["cost_usd"],
        }
        results.append(res)
        print(f"[score] {ep['id']} {ep['show_name']}: agreement {agreement:.1%} · {len(spans)} spans >3 words")

    meta = {"qir_git_sha": None, "pacifica_versions": None, "cpu": None, "model_load_sec": None}
    for ep in manifest["episodes"]:
        try:
            meta["qir_git_sha"] = json.load(open(os.path.join(out, "qir", f"{ep['id']}.json")))["git_sha"]
            pj = json.load(open(os.path.join(out, "pacifica", f"{ep['id']}.json")))
            meta.update(pacifica_versions=pj["versions"], cpu=pj["cpu"], cores=pj["cores_visible"], model_load_sec=pj["model_load_sec"])
            break
        except (OSError, KeyError):
            continue
    json.dump({"manifest": {k: v for k, v in manifest.items() if k != "episodes"}, "meta": meta, "episodes": results},
              open(os.path.join(out, "results.json"), "w"), ensure_ascii=False, indent=1)
    open(os.path.join(out, "report.md"), "w").write(render_md(results, meta, offset))
    open(os.path.join(out, "listening-packet.html"), "w").write(render_html(results, meta, offset))
    # Same packet for publishing as a claude.ai artifact: its sandbox blocks media from
    # other hosts, so each row links out to the archive MP3 instead of an inline player.
    open(os.path.join(out, "listening-packet-artifact.html"), "w").write(render_html(results, meta, offset, artifact=True))
    print(f"[score] wrote results.json, report.md, listening-packet.html in {out}")


# ---------- rendering ----------

def name_cell(rows):
    seen = [r for r in rows]
    e = sum(1 for r in seen if r["verdict"] == "exact")
    m = sum(1 for r in seen if r["verdict"] == "mixed")
    n = sum(1 for r in seen if r["verdict"] == "near-miss")
    return f"{e} exact · {m} mixed · {n} near-miss"


def render_md(results, meta, offset):
    L = []
    L.append("# ASR comparison — raw tables\n")
    L.append(f"QIR commit `{meta.get('qir_git_sha')}` · Faster-Whisper {meta.get('pacifica_versions')} on {meta.get('cpu')} ({meta.get('cores')} cores visible)\n")
    L.append("## Summary\n")
    L.append("| Episode | Role | QIR words | Pacifica words | Agreement | Spans >3 words | QIR lang | Pacifica lang | QIR wall | Pacifica wall (RTF) | QIR cost |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in results:
        L.append(f"| {r['id']} {r['show']} | {r['role']} | {r['words']['qir']} | {r['words']['pacifica']} | {r['agreement']:.1%} | {r['disagreements_over_3_words']} | "
                 f"{r['language']['qir_detected']} | {r['language']['pacifica']} (forced) | {r['wall_sec']['qir']:.1f}s | {r['wall_sec']['pacifica']:.0f}s ({r['pacifica_rtf']}) | ${r['qir_cost_usd']:.4f} |")

    L.append("\n## Language of the output (function-word vote per segment)\n")
    L.append("| Episode | Expected | QIR English words | QIR Spanish words | Pacifica English words | Pacifica Spanish words |")
    L.append("|---|---|---|---|---|---|")
    for r in results:
        q, p = r["language_mix"]["qir"], r["language_mix"]["pacifica"]
        L.append(f"| {r['id']} {r['show']} | {r['language']['expected']} | {q['english_words']} | {q['spanish_words']} | {p['english_words']} | {p['spanish_words']} |")
    for r in results:
        if r["language"]["expected"] == "Spanish":
            for who in ("qir", "pacifica"):
                for smp in r["language_mix"][who]["english_samples"][:12]:
                    L.append(f"- {who}, English segment in a Spanish show: “{smp[:200]}”")

    L.append("\n## Names (headline: human-entered + vocabulary + show name)\n")
    L.append("Only names that at least one pipeline produced (exactly or as a near miss) are listed; the rest were most likely not said in the excerpt.\n")
    L.append("| Episode | Name | QIR exact | QIR near-miss (variants) | Pacifica exact | Pacifica near-miss (variants) |")
    L.append("|---|---|---|---|---|---|")
    for tier in ("headline", "ai_extracted"):
        if tier == "ai_extracted":
            L.append("\n### Names the AI summary pulled from QIR's own transcript (biased toward QIR — context only)\n")
            L.append("| Episode | Name | QIR exact | QIR near-miss (variants) | Pacifica exact | Pacifica near-miss (variants) |")
            L.append("|---|---|---|---|---|---|")
        for r in results:
            qs, ps = r["names"][tier]["qir"], r["names"][tier]["pacifica"]
            for qn, pn in zip(qs, ps):
                if qn["verdict"] == "missing" and pn["verdict"] == "missing":
                    continue
                L.append(f"| {r['id']} | {qn['name']} | {qn['exact']} | {qn['near_miss']} {('(' + ', '.join(qn['variants']) + ')') if qn['variants'] else ''} | "
                         f"{pn['exact']} | {pn['near_miss']} {('(' + ', '.join(pn['variants']) + ')') if pn['variants'] else ''} |")

    L.append("\n## Hallucination / music / silence\n")
    L.append("| Episode | Silence ≥3s (sec) | Words in silence Q/P | Repetition loops Q/P | Stock phrases Q/P | Pacifica VAD dropped (sec) | QIR words where VAD heard no speech |")
    L.append("|---|---|---|---|---|---|---|")
    for r in results:
        h = r["hallucination"]
        L.append(f"| {r['id']} {r['show']} | {h['silence_sec']} | {h['qir']['words_in_silence']}/{h['pacifica']['words_in_silence']} | "
                 f"{len(h['qir']['loops'])}/{len(h['pacifica']['loops'])} | {', '.join(h['qir']['stock_phrases']) or '—'} / {', '.join(h['pacifica']['stock_phrases']) or '—'} | "
                 f"{h['vad_non_speech_sec']} | {h['qir_words_where_vad_heard_no_speech']} |")
    for r in results:
        h = r["hallucination"]
        L.append(f"\n**{r['id']} {r['show']}** words per minute (QIR / Pacifica): " + " ".join(f"{a}/{b}" for a, b in zip(h['words_per_min']['qir'], h['words_per_min']['pacifica'])))
        for who in ("qir", "pacifica"):
            for lp in h[who]["loops"][:3]:
                L.append(f"- {who} loop: “{lp['ngram']}” ×{lp['repeats']}")
        if h["qir_text_where_vad_heard_no_speech"]:
            L.append(f"- QIR text inside Pacifica's VAD gaps: “{h['qir_text_where_vad_heard_no_speech'][:400]}”")

    L.append("\n## Captions (one cue per segment, as stored)\n")
    L.append("| Episode | Pipeline | Cues | Median sec | Max sec | Median chars | Max chars | Cues >7s | Cues >84 chars |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for r in results:
        for who in ("qir", "pacifica"):
            c = r["captions"][who]
            L.append(f"| {r['id']} | {who} | {c['cues']} | {c['median_sec']} | {c['max_sec']} | {c['median_chars']} | {c['max_chars']} | {c['over_7s']} | {c['over_84_chars']} |")

    L.append("\n## Biggest disagreements (top 10 per episode)\n")
    for r in results:
        L.append(f"\n### {r['id']} {r['show']} — {r['mp3_url']}\n")
        L.append("| At (original MP3) | QIR | Pacifica | Who's right |")
        L.append("|---|---|---|---|")
        for s in r["spans"][:10]:
            esc = lambda t: (clip(t) or "∅ (nothing)").replace("|", "\\|")
            L.append(f"| {fmt_ts(s['start'] + offset)} | {esc(s['qir'])} | {esc(s['pacifica'])} |  |")
    return "\n".join(L) + "\n"


def clip(t, n=450):
    return t if len(t) <= n else t[:n].rsplit(" ", 1)[0] + " …"


def render_html(results, meta, offset, artifact=False):
    e = html.escape
    rows = []
    for r in results:
        rows.append(f"<section><h2>{e(str(r['id']))} · {e(r['show'])} <span class=meta>{e(r['role'])} · aired {e(str(r['air_date']))} · agreement {r['agreement']:.0%}</span></h2>")
        rows.append(f"<p class=meta>Full audio: <a href=\"{e(r['mp3_url'])}\">{e(r['mp3_url'])}</a>. Times are into the original MP3. " + ("Play opens the archive MP3 at that moment in a new tab." if artifact else "Each player plays only that span (it starts a second early).") + "</p>")
        rows.append("<div class=tablewrap><table><thead><tr><th>At</th><th>Listen</th><th>QIR (Groq turbo)</th><th>Pacifica (FW small)</th><th>Who's right?</th></tr></thead><tbody>")
        for k, s in enumerate(r["spans"][:10]):
            a = max(0, s["start"] + offset - 1)
            b = s["end"] + offset + 1
            key = f"{r['id']}-{k}"
            frag = f"{r['mp3_url']}#t={a:.1f},{b:.1f}"
            rows.append(
                f"<tr data-key=\"{key}\" data-at=\"{fmt_ts(s['start'] + offset)}\" data-ep=\"{r['id']}\"><td class=ts><a href=\"{e(frag)}\" target=_blank>{fmt_ts(s['start'] + offset)}</a></td>"
                + (f"<td><a class=play href=\"{e(frag)}\" target=_blank rel=noopener>Play ↗</a></td>" if artifact else f"<td><audio controls preload=none src=\"{e(frag)}\"></audio></td>")
                + f"<td class=txt><span class=ctx>{e(s['ctx_before'])}</span> <mark>{e(clip(s['qir'])) or '<em>∅ nothing</em>'}</mark></td>"
                f"<td class=txt><mark>{e(clip(s['pacifica'])) or '<em>∅ nothing</em>'}</mark></td>"
                f"<td class=pick>" + "".join(
                    f"<label><input type=radio name=\"{key}\" value=\"{v}\"> {lbl}</label>" for v, lbl in
                    (("qir", "QIR"), ("pacifica", "Pacifica"), ("both", "Both OK"), ("neither", "Neither"))) +
                f"<input class=note id=\"note-{key}\" placeholder=\"note\" aria-label=\"Note\" data-note=\"{key}\"></td></tr>")
        rows.append("</tbody></table></div></section>")
    body = "\n".join(rows)
    head = "" if artifact else '<!doctype html>\n<html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1">\n'
    meta_tag = '<meta name="claude:viewport-fit-sides" content="cover">\n' if artifact else ""
    tail = "" if artifact else "</body></html>\n"
    open_body = "" if artifact else "</head><body>"
    return head + f"""<title>ASR Listening Packet</title>
{meta_tag}
<style>
:root{{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--line:#e2dfd8;--mark:#fff1b8;--card:#fff;--accent:#8a3b12}}
@media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{--bg:#161614;--fg:#ecebe6;--muted:#a3a19a;--line:#34332f;--mark:#5a4a12;--card:#1f1e1b;--accent:#f0a070;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#161614;--fg:#ecebe6;--muted:#a3a19a;--line:#34332f;--mark:#5a4a12;--card:#1f1e1b;--accent:#f0a070;color-scheme:dark}}
body{{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0 auto;max-width:1200px;padding-block:24px;padding-left:max(16px, env(safe-area-inset-left, 0px));padding-right:max(16px, env(safe-area-inset-right, 0px));box-sizing:border-box}}
h1{{font-size:22px;margin:0 0 6px}} h2{{font-size:17px;margin:28px 0 4px}} .meta{{color:var(--muted);font-weight:400;font-size:13px}}
a{{color:var(--accent)}} .tablewrap{{overflow-x:auto}} table{{border-collapse:collapse;width:100%;background:var(--card)}}
th,td{{border-bottom:1px solid var(--line);padding:8px 6px;vertical-align:top;text-align:left}} th{{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}}
td.ts{{white-space:nowrap;font-variant-numeric:tabular-nums}} td.txt{{min-width:220px}} mark{{background:var(--mark);color:inherit;padding:0 2px}}
.ctx{{color:var(--muted)}} audio{{width:200px;height:32px}} .pick label{{display:block;white-space:nowrap;font-size:13px}} .note{{width:110px;margin-top:4px}}
.bar{{position:sticky;top:env(safe-area-inset-top, 0px);background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:2}}
button{{font:inherit;padding:4px 10px}} .play{{white-space:nowrap}} #out{{width:100%;min-height:120px;font:12px ui-monospace,monospace}} a:focus-visible,button:focus-visible,input:focus-visible{{outline:2px solid var(--accent);outline-offset:2px}}
</style>{open_body}
<h1>ASR Listening Packet — QIR vs Pacifica Audio Services</h1>
<p class=meta>Same 15-minute excerpt per episode (from {fmt_ts(offset)} into each MP3). Rows are the 10 longest places where the two transcripts disagree, longest first.
Listen, then mark who got it right. Your picks are kept in this browser only; use “Copy results” to paste them into an email or doc.
QIR commit {e(str(meta.get('qir_git_sha'))[:10])}.</p>
<div class=bar><span id=tally class=meta></span><button id=copy>Copy results</button></div>
<textarea id=out hidden readonly aria-label="Results to copy"></textarea>
{body}
<script>
(function(){{
  var KEY='asr-packet-v1', state={{}};
  try{{state=JSON.parse(localStorage.getItem(KEY)||'{{}}')}}catch(e){{state={{}}}}
  function save(){{try{{localStorage.setItem(KEY,JSON.stringify(state))}}catch(e){{}} tally();}}
  function tally(){{var c={{qir:0,pacifica:0,both:0,neither:0}},n=0;for(var k in state){{if(state[k].pick){{c[state[k].pick]++;n++}}}}
    document.getElementById('tally').textContent=n+' marked — QIR '+c.qir+' · Pacifica '+c.pacifica+' · both OK '+c.both+' · neither '+c.neither;}}
  document.querySelectorAll('input[type=radio]').forEach(function(r){{
    if(state[r.name]&&state[r.name].pick===r.value) r.checked=true;
    r.addEventListener('change',function(){{state[r.name]=state[r.name]||{{}};state[r.name].pick=r.value;save();}});}});
  document.querySelectorAll('.note').forEach(function(i){{var k=i.dataset.note; if(state[k]&&state[k].note) i.value=state[k].note;
    i.addEventListener('input',function(){{state[k]=state[k]||{{}};state[k].note=i.value;save();}});}});
  document.getElementById('copy').addEventListener('click',function(){{
    var lines=['episode\\tat\\tpick\\tnote'];document.querySelectorAll('tr[data-key]').forEach(function(tr){{var s=state[tr.dataset.key]||{{}};
      lines.push(tr.dataset.ep+'\\t'+tr.dataset.at+'\\t'+(s.pick||'')+'\\t'+(s.note||''));}});
    var t=lines.join('\\n'); var o=document.getElementById('out'); o.value=t; o.hidden=false; o.select();
    try{{navigator.clipboard.writeText(t).then(function(){{document.getElementById('copy').textContent='Copied';}},function(){{}});}}catch(e){{}}}});
  tally();
}})();
</script>
""" + tail


if __name__ == "__main__":
    main()
