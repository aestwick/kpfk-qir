# Spec: Show-Schedule Language Tagging

**Status:** Proposed
**Area:** transcription pipeline, transcripts data model, dashboard
**Migrations:** `019_show_language.sql`
**Related:** PR #73 (retry-policy fix); `workers/transcribe.ts`, `app/api/episodes/[id]/translate/route.ts`

---

## 1. Problem

An episode's stored language is derived from a single Whisper guess on the
**first ~30 seconds of the first 15-minute chunk**, and that one value is applied
to the whole hour:

```js
// workers/transcribe.ts
if (i === 0 && result.language) detectedLanguage = result.language
```

Whisper detects language per chunk, but chunks 2..N are discarded. Consequences:

- A bilingual show that **opens in English** is labelled `en`, so its Spanish
  content never gets an offered English translation (the translate button is
  gated on `language != null && language !== 'en'`).
- A show that opens with a Spanish station ID but is mostly English gets `es`.
- The label is a coarse, unreliable guess even though **the program schedule is
  known and deterministic** — every episode maps to exactly one `show_keys` row,
  and each show airs in a fixed slot.

The transcript **text** itself is fine (Whisper transcribes code-switching as
spoken). The defect is purely in the **language label** and what it gates.

## 2. Goals

- Make the language label authoritative and stable by sourcing it from the
  **show schedule** (`show_keys`), which staff already curate.
- Keep automatic detection as a **fallback** (when a show is untagged) and as a
  **quality-control signal** (detected ≠ expected ⇒ likely bad feed / dead air).
- Fix the translate affordance so Spanish/bilingual content is always offered an
  English rendering, regardless of how the hour opens.
- Zero change to how transcription text is produced.

## 3. Non-goals

- No per-segment language switching in the transcript text (Whisper already
  handles code-switching adequately; we are not re-segmenting).
- No automatic translation in the pipeline — translation stays **on-demand**.
- No change to translation direction (Spanish→English remains the only pair;
  GPT passes already-English text through safely).
- No per-episode language override in v1 (see §9, deferred).

## 4. Data model changes

### `show_keys.language` (new)

The curated, authoritative expected language for the show.

- Type: `text`, nullable.
- Allowed values: `'en' | 'es' | 'bilingual'`. `NULL` = unknown ⇒ auto-detect.
- `CHECK (language IN ('en','es','bilingual'))`.
- Scoped with the row's existing `station_id` (no new RLS needed — inherits the
  `show_keys` policies).

### `transcripts.detected_language` (new)

What Whisper actually detected, stored separately so it never overwrites the
curated value and can be compared against it.

- Type: `text`, nullable. Holds the **majority-vote** detection across all chunks.

> The existing `transcripts.language` column is **retained** and becomes the
> *effective/resolved* language written at transcription time (see §6). This
> keeps every existing reader working without change.

### Migration `019_show_language.sql`

```sql
alter table show_keys
  add column if not exists language text
    check (language in ('en','es','bilingual'));

alter table transcripts
  add column if not exists detected_language text;
```

No backfill of `show_keys.language` in the migration itself; seeding of known
Spanish shows is a separate, reviewable step (§8).

## 5. Language resolution

Define the **effective language** of an episode as:

```
effective = show_keys.language            -- curated, if set
          ?? transcripts.detected_language -- else what Whisper found (majority vote)
          ?? null                          -- else unknown
```

`bilingual` is a first-class effective value (not coerced to en/es).

## 6. Worker changes (`workers/transcribe.ts`)

1. **Majority-vote detection.** Collect `result.language` from **every** chunk,
   not just the first. Pick the most frequent non-null value; ties broken by the
   earliest chunk. Store as `detected_language`.

   ```js
   // accumulate per chunk
   const langs = [] // push result.language for each chunk
   // after loop:
   const detectedLanguage = majority(langs) // null if none reported
   ```

2. **Resolve the effective label.** Look up the episode's show language once per
   batch (the claim query already selects the episode; join or fetch
   `show_keys.language` by `(station_id, key)`), then:

   ```js
   const effectiveLanguage = showLanguage ?? detectedLanguage ?? null
   ```

3. **Write both** in the transcript upsert:

   ```js
   language: effectiveLanguage,        // was: detectedLanguage (first chunk)
   detected_language: detectedLanguage,
   english_transcript: null,
   english_vtt: null,
   ```

No other transcription behaviour changes. `bilingual` shows store
`language = 'bilingual'`.

## 7. API / UI changes

### Episode detail page (`app/dashboard/episodes/[id]/page.tsx`)

- **Translate affordance** — replace `isNonEnglish` with effective-language logic:

  ```js
  const effLang = transcript?.language // already resolved at transcription time
  const canTranslate = effLang === 'es' || effLang === 'bilingual'
                       || (effLang == null && transcript?.transcript)
  ```

  i.e. offer translation for Spanish, bilingual, and unknown-but-has-text. Only
  hide it for confirmed `en`.

- **Mismatch warning** — when `show_keys.language` is set and
  `transcripts.detected_language` disagrees (and neither is `bilingual`), show a
  non-blocking banner:

  > ⚠️ Expected **Spanish**, but the audio was detected as **English**. The feed
  > may be wrong, or the show may have aired off-format.

  This is advisory only; it does not change status or block the QIR.

- **Language badge** — display the effective language; if `bilingual`, label it
  "Bilingual (ES/EN)".

### Settings page (`app/dashboard/settings/page.tsx`)

- Add a **language dropdown** to the per-show editor: *Auto-detect (default) /
  English / Spanish / Bilingual* → writes `show_keys.language`
  (`null | 'en' | 'es' | 'bilingual'`).

### Translate route (`app/api/episodes/[id]/translate/route.ts`)

- No functional change required. Optionally include the effective language in the
  usage-log metadata instead of the raw `language` field (already does
  `language: transcript.language ?? 'es'`).

## 8. Seeding known Spanish shows

After the migration, set `language` for the obviously-Spanish programs so staff
don't tag 193 shows by hand. Candidate keys (confirm against `show_keys` before
running): `perspectiva`, `radioinsurgencia`, `sendede…` (Oaxaca), `casc`,
plus any others identified from `show_name`/`category`.

```sql
update show_keys
   set language = 'es', updated_at = now()
 where station_id = <kpfk>
   and key in ( /* curated list */ );
```

Delivered as a reviewable list, **not** auto-applied by the migration. Everything
left `NULL` falls back to majority-vote auto-detection — strictly better than
today's first-chunk behaviour.

## 9. Edge cases & decisions

- **Untagged show (`NULL`)** → behaves like today but with majority-vote instead
  of first-chunk detection. Pure improvement, no regression.
- **`bilingual`** → always offers translation; no mismatch warning is raised
  against it.
- **Whisper reports a third language** (e.g. `fr`) → stored in
  `detected_language`; effective falls through to it if the show is untagged.
  Translate button still appears (unknown/non-en branch), but the Spanish→English
  prompt may translate imperfectly — acceptable, rare, and visible via the badge.
- **Re-transcription** overwrites `detected_language` from fresh audio; the
  curated `show_keys.language` is untouched.
- **Per-episode override (deferred):** a show that flips language week to week is
  not handled by per-show tagging. If this proves real, add
  `episode_log.language_override` consulted ahead of `show_keys.language` in §5.
  Out of scope for v1.

## 10. Backward compatibility

- `transcripts.language` keeps its name and meaning to readers ("the language to
  show / gate on"); only its *source* improves. All existing consumers
  (`types.ts`, episode page badge, translate metadata) keep working unchanged.
- New columns are additive and nullable; no data migration required.

## 11. Testing

- **Unit:** `majority()` — empty, single, tie (earliest wins), mixed.
- **Resolution:** show=es / detected=en ⇒ effective es + mismatch flagged;
  show=null / detected=es ⇒ effective es, no flag; show=bilingual ⇒ effective
  bilingual, translate offered, no flag.
- **Worker (integration, throwaway Postgres):** transcribe a 2-chunk fixture
  where chunk 0 = en and chunk 1 = es; assert `detected_language` reflects the
  majority and `language` reflects the show tag when present.
- **UI:** translate button visible for es / bilingual / null-with-text; hidden
  only for confirmed en.

## 12. Rollout

1. Ship `019_show_language.sql`.
2. Deploy worker + UI changes (additive; safe with un-tagged shows).
3. Apply the curated Spanish-show seed (§8).
4. Optional: a one-off backfill recomputing `language`/`detected_language` for
   existing transcripts is **not** required — values self-heal on next
   (re-)transcription, and the curated show tags take effect immediately for the
   UI gate via the resolution in §5.
