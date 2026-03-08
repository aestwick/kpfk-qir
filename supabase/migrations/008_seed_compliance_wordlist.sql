-- Seed compliance_wordlist with FCC-actionable profanity
-- Based on FCC enforcement actions and the "seven dirty words" (FCC v. Pacifica)
-- Only includes terms the FCC has actually enforced or would likely action
-- Severity: critical = FCC-actionable during restricted hours (6am-10pm)
--           warning  = contextual, flagged for review but less likely to trigger enforcement

insert into compliance_wordlist (word, severity) values
  -- George Carlin's "seven dirty words" — core FCC indecency standard
  ('shit',          'critical'),
  ('fuck',          'critical'),
  ('cunt',          'critical'),
  ('cocksucker',    'critical'),
  ('motherfucker',  'critical'),
  ('tits',          'critical'),

  -- Common inflections
  ('fucking',       'critical'),
  ('fucked',        'critical'),
  ('fucker',        'critical'),
  ('fucks',         'critical'),
  ('shitty',        'critical'),
  ('shitting',      'critical'),
  ('bullshit',      'critical'),
  ('horseshit',     'critical'),
  ('dipshit',       'critical'),
  ('motherfucking', 'critical'),
  ('motherfuckers', 'critical'),
  ('cocksucking',   'critical'),

  -- FCC-actioned terms
  ('asshole',       'critical'),
  ('assholes',      'critical'),

  -- Slurs — FCC has actioned these in broadcast complaints
  ('nigger',        'critical'),
  ('niggers',       'critical'),
  ('nigga',         'critical'),
  ('niggas',        'critical'),
  ('faggot',        'critical'),
  ('faggots',       'critical'),
  ('kike',          'critical'),
  ('spic',          'critical'),
  ('wetback',       'critical'),
  ('chink',         'critical'),
  ('raghead',       'critical'),
  ('towelhead',     'critical')

  -- Sexual/explicit terms (blowjob, handjob, etc.) are intentionally excluded
  -- from the wordlist — they are context-dependent and better handled by the
  -- AI compliance prompt which can distinguish health education from indecency

on conflict do nothing;
