-- 046_lockdown_public_exposure.sql
--
-- Close what the public ("anon") browser key could reach in the shared
-- Supabase project (docs/bug-sweep-2026-11.md §1; the kpfk-web handoff
-- docs/plans/qir-rls-remediation.md). The anon key ships in every browser
-- bundle, so anything it can read or write is effectively public.
--
-- What legitimately uses the anon key today (pg_stat_statements on the live
-- project, since 2025-12-29), and is kept working on purpose:
--   * The public site's episode player (aestwick/cms snippets/886_episode-player.html,
--     ~41k calls) reads episode_log mp3_url, headline, host, guest, summary
--     (and transcript_url) filtered by mp3_url.
--   * The public site's show-tag chips (aestwick/cms snippets/891_show-tags) read
--     show_tags joined to tags(name, slug, category).
-- Nothing else reads these tables with the anon or a user key: QIR reaches
-- qir_settings only through the service role, and the CMS (kpfk-web/apps/cms)
-- reads episode_log through its service role. Workers, scripts/migrate.sh
-- (postgres) and the service role bypass RLS, so they're unaffected.
--
-- Idempotent: safe to re-run. Tables QIR doesn't own are guarded with
-- to_regclass so the file still applies if one is ever dropped.

-- ── 1. qir_settings: global config incl. every prompt and compliance_blocking.
--       Was RLS-off with full anon/authenticated write. Service role only.
alter table public.qir_settings enable row level security;
revoke all on table public.qir_settings from anon, authenticated;

-- ── 2. schema_migrations: QIR's migration ledger. A writable ledger means a
--       deleted row makes the next deploy replay that migration. Postgres
--       (migrate.sh) only.
alter table public.schema_migrations enable row level security;
revoke all on table public.schema_migrations from anon, authenticated;

-- ── 3. episode_log: drop the hand-added "Public read access" USING (true)
--       policy. It OR'd with episode_log_select and let anyone — and every
--       signed-in user of every station — read every station's episodes, incl.
--       unreviewed summaries, compliance results and error text.
drop policy if exists "Public read access" on public.episode_log;

--       Replace it with exactly what the public episode player needs:
--       published episodes only, and only the columns it selects.
drop policy if exists episode_log_public_published on public.episode_log;
create policy episode_log_public_published on public.episode_log
  for select to anon
  using (status in ('summarized', 'compliance_checked'));

revoke all on table public.episode_log from anon;
grant select (mp3_url, headline, host, guest, summary, transcript_url) on public.episode_log to anon;

-- ── 4. Legacy zero-arg get_episode_counts_by_show(): counts across ALL
--       stations. The app calls only the station-scoped overload (016).
--       Keep it for the service role in case something stale still calls it.
revoke execute on function public.get_episode_counts_by_show() from public, anon, authenticated;

-- ── 5. Tables in the shared database that QIR's code never touches, but that
--       were left RLS-off with full anon write (see the kpfk-web handoff).
do $$
begin
  -- contacts / show_contacts: real people's names, emails, phones. No
  -- legitimate anon/user-key reader exists → service role only.
  if to_regclass('public.contacts') is not null then
    execute 'alter table public.contacts enable row level security';
    execute 'revoke all on table public.contacts from anon, authenticated';
  end if;
  if to_regclass('public.show_contacts') is not null then
    execute 'alter table public.show_contacts enable row level security';
    execute 'revoke all on table public.show_contacts from anon, authenticated';
  end if;

  -- show_page_generations + the show_pages_current view over it: no
  -- anon/user-key reader. The view ran as its owner (security_invoker off),
  -- reading around base-table RLS.
  if to_regclass('public.show_page_generations') is not null then
    execute 'alter table public.show_page_generations enable row level security';
    execute 'revoke all on table public.show_page_generations from anon, authenticated';
  end if;
  if to_regclass('public.show_pages_current') is not null then
    execute 'alter view public.show_pages_current set (security_invoker = on)';
    execute 'revoke all on table public.show_pages_current from anon, authenticated';
  end if;

  -- tags / show_tags: public catalogue the site's tag chips read. Keep public
  -- READ, remove every write.
  if to_regclass('public.tags') is not null then
    execute 'alter table public.tags enable row level security';
    execute 'drop policy if exists tags_public_read on public.tags';
    execute 'create policy tags_public_read on public.tags for select to anon, authenticated using (true)';
    execute 'revoke insert, update, delete, truncate, references, trigger on table public.tags from anon, authenticated';
  end if;
  if to_regclass('public.show_tags') is not null then
    execute 'alter table public.show_tags enable row level security';
    execute 'drop policy if exists show_tags_public_read on public.show_tags';
    execute 'create policy show_tags_public_read on public.show_tags for select to anon, authenticated using (true)';
    execute 'revoke insert, update, delete, truncate, references, trigger on table public.show_tags from anon, authenticated';
  end if;
end $$;
