-- Per-station tier: the sharing-policy class that sets scheduling priority (and,
-- in Layer B, the demo allowance). Replaces the implicit "test = no rss_base_url"
-- signal with an explicit flag. See "Spec: Multi-Station Sharing & Tenancy" §2.
--
--   production — KPFK: priority, unmetered
--   paying     — subscribed peer station: fair-share, unmetered
--   demo       — prospect on a time-boxed trial: capped (Layer B)
--   test       — internal/manual trial: lowest priority, not customer-facing
--
-- stations already carries RLS (migration 014); a new column inherits those
-- policies, so no policy change is needed here.

alter table public.stations
  add column if not exists tier text not null default 'test'
    check (tier in ('production', 'paying', 'demo', 'test'));

-- KPFK is the production station; everything else stays 'test' until promoted.
update public.stations set tier = 'production' where slug = 'kpfk';
