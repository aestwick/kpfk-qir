-- KPFK: categorize shows that had no category (Q4 2026 review, confirmed by the GM).
-- 178 Q4 episodes / ~324 hours sat under a null category. Category drives the
-- ingest exclusion list (KPFK's is empty, so nothing stops being pulled) and how
-- the grid reads in reports.
--
-- Idempotent and non-clobbering: only rows whose category is still null are set,
-- so a later hand edit in Settings → Shows is never overwritten on re-run.
-- Still undecided (left null): allabove (music vs talk).

with kpfk as (select id from stations where slug = 'kpfk'),
mapping(key, category) as (
  values
    -- Music
    ('reggaecent',            'Music'),
    ('aliveandpicking',       'Music'),
    ('gv_derek',              'Music'),
    ('gv_tue',                'Music'),
    ('gv_yatrika',            'Music'),
    ('gv_john',               'Music'),
    ('gv_sergio',             'Music'),
    ('lstation',              'Music'),
    ('musicmix',              'Music'),
    ('potira',                'Music'),
    ('realrockriffsamprhyth', 'Music'),
    ('rhapsody',              'Music'),
    ('soundwaves',            'Music'),
    ('afrodicia',             'Music'),
    ('breakbeats',            'Music'),
    ('deepend',               'Music'),
    ('eastsidestoryradio',    'Music'),
    ('gospelclassics',        'Music'),
    ('awakenings',            'Music'),
    ('cantossin',             'Music'),
    ('cinemascore',           'Music'),
    -- Arts & Entertainment
    ('larb',                  'Arts & Entertainment'),
    ('rockprofile',           'Arts & Entertainment'),
    -- Español
    ('traveltips',            'Español'),
    -- Public Affairs
    ('codepinradio',          'Public Affairs - National+Syndicated'),
    ('swanapodcast',          'Public Affairs - Local')
)
update show_keys sk
set category = m.category
from mapping m, kpfk
where sk.station_id = kpfk.id
  and sk.key = m.key
  and sk.category is null;

-- Typo split one show out of its category ("Public Affairs- " vs "Public Affairs - ").
update show_keys
set category = 'Public Affairs - National+Syndicated'
where station_id = (select id from stations where slug = 'kpfk')
  and category = 'Public Affairs- National+Syndicated';
