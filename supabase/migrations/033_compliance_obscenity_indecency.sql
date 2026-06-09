-- Correct the FCC content-category taxonomy in the compliance system.
--
-- The original design conflated the three distinct FCC categories. This migration
-- separates them per the actual federal framework:
--
--   OBSCENITY  — patently offensive DESCRIPTIONS of sexual acts (Miller v. CA).
--                NOT protected by the First Amendment. Prohibited 24/7 — there is
--                NO safe harbor. (Was mislabeled "indecency" + AI-detected.)
--   INDECENCY  — the "seven dirty words" (FCC v. Pacifica / Carlin). Protected
--                speech; permitted only in the 10pm-6am safe harbor.
--   PROFANITY  — the amorphous set of grossly-offensive words BEYOND the Carlin
--                list (never crisply defined in court). Also safe-harbor-restricted.
--
-- So: obscenity = always critical (24/7); indecency + profanity = safe-harbor-aware.
--
-- Changes:
--   1. compliance_wordlist gains a `category` ('indecency' | 'profanity') so the
--      worker can emit the right flag_type per word. The Carlin words become
--      'indecency'; everything else (slurs, the amorphous extras) stays 'profanity'.
--   2. Existing compliance_flags of type 'indecency' (which were the AI sexual-
--      content check) are migrated to 'obscenity'.
--   3. The global default compliance_prompt + compliance_checks_enabled in
--      qir_settings are rewritten for the corrected taxonomy.

-- 1. Per-word category on the wordlist (default 'profanity' — the catch-all bucket).
alter table public.compliance_wordlist
  add column if not exists category text not null default 'profanity';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'compliance_wordlist_category_check'
  ) then
    alter table public.compliance_wordlist
      add constraint compliance_wordlist_category_check
      check (category in ('indecency', 'profanity'));
  end if;
end$$;

-- Promote the Carlin words (and their inflections) to 'indecency'. Everything
-- else — asshole(s), the slurs, any station-local additions — stays 'profanity'.
update public.compliance_wordlist
  set category = 'indecency'
  where word in (
    'shit', 'fuck', 'cunt', 'cocksucker', 'motherfucker', 'tits',
    'fucking', 'fucked', 'fucker', 'fucks', 'shitty', 'shitting',
    'bullshit', 'horseshit', 'dipshit', 'motherfucking', 'motherfuckers',
    'cocksucking'
  );

-- 2. Existing 'indecency' flags were produced by the old AI sexual-content check,
--    which is obscenity under the corrected taxonomy. Re-label them.
update public.compliance_flags
  set flag_type = 'obscenity'
  where flag_type = 'indecency';

-- 3a. Default check toggles: split the wordlist into indecency + profanity, and
--     replace the old AI 'indecency' toggle with 'obscenity'.
update public.qir_settings
  set value = '{"profanity": true, "indecency": true, "station_id_missing": true, "technical": true, "payola_plugola": true, "sponsor_id": true, "obscenity": true}'::jsonb,
      updated_at = now()
  where key = 'compliance_checks_enabled';

-- 3b. Rewrite the global default AI prompt: section 3 is now OBSCENITY (never
--     protected, prohibited at all times — no safe-harbor framing) and emits
--     flag type "obscenity".
update public.qir_settings
  set value = to_jsonb($prompt$You are an FCC compliance reviewer for {{STATION_NAME}}, a noncommercial community radio station.

Review the following transcript for potential compliance issues. Look for:

1. PAYOLA/PLUGOLA: Undisclosed commercial promotion. Flag if a host promotes a product, service, or business without disclosure. Do NOT flag: pledge drive fundraising, promoting station events, journalistic discussion of books/films/music, or interviews where guests mention their own work in context.

2. SPONSOR IDENTIFICATION: Segments that sound like sponsored or paid content without proper FCC disclosure.

3. OBSCENITY: Patently offensive DESCRIPTIONS of sexual acts (the Miller standard) — appealing to the prurient interest and lacking serious literary, artistic, political, or scientific value. Obscenity is NOT protected by the First Amendment and is prohibited at ALL hours; there is no safe harbor, so always flag it as "critical". Do NOT flag: clinical/medical terminology in health education, age-appropriate sex education, news reporting on sexual assault, or academic/documentary context that serves a clear informational purpose. (Note: isolated curse words are handled separately as indecency/profanity — only flag graphic descriptions of sexual conduct here.)

Return ONLY valid JSON. If no issues found, return empty flags array.
{
  "flags": [
    {
      "type": "payola_plugola" | "sponsor_id" | "obscenity",
      "excerpt": "relevant quote from transcript (under 200 chars)",
      "details": "brief explanation of the concern",
      "severity": "warning" | "critical"
    }
  ]
}$prompt$::text),
      updated_at = now()
  where key = 'compliance_prompt';
