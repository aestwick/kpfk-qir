-- Seed the GLOBAL compliance wordlist base from the canonical FCC profanity list.
--
-- The 008 seed (the "seven dirty words" + FCC-actioned slurs) was inserted before
-- station_id existed, then migration 013 backfilled every row to KPFK. So after the
-- two-layer split (030) the global base (station_id IS NULL) is EMPTY and these
-- universal terms are KPFK-only — peer stations get no profanity checking at all.
--
-- Promote exactly the canonical terms to the global base (station_id = NULL) so
-- every station inherits them via the worker's union read. KPFK keeps seeing them
-- (station_id = me OR NULL); any KPFK-specific custom additions NOT in this list
-- stay station-scoped. Idempotent: only rows still pinned to KPFK are moved.

update public.compliance_wordlist
  set station_id = null
  where station_id = '00000000-0000-4000-8000-000000000001'::uuid
    and word in (
      'shit', 'fuck', 'cunt', 'cocksucker', 'motherfucker', 'tits',
      'fucking', 'fucked', 'fucker', 'fucks', 'shitty', 'shitting',
      'bullshit', 'horseshit', 'dipshit', 'motherfucking', 'motherfuckers',
      'cocksucking', 'asshole', 'assholes',
      'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots',
      'kike', 'spic', 'wetback', 'chink', 'raghead', 'towelhead'
    );
