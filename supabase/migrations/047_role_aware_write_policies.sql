-- 047_role_aware_write_policies.sql
--
-- Make the database enforce the same roles the app does
-- (docs/bug-sweep-2026-11.md §2). Until now every *_write policy checked only
-- station MEMBERSHIP (station_id IN user_station_ids()), while viewer/editor/
-- admin lived only in lib/auth.ts#requireRole. A viewer could therefore call
-- PostgREST directly with their own login token and finalize or rewrite a QIR
-- draft, dismiss compliance flags, change their station's spend cap or pause
-- flag, or delete usage_log cost rows.
--
-- After this migration:
--   * writes to station content need EDITOR (or admin / super-admin), matching
--     every API route's requireRole(…, 'editor');
--   * the per-station pause flag and spend caps in station_settings are
--     super-admin only (Master Control already writes them via the service role);
--   * usage_log is written only by the service role (lib/usage.ts).
-- Reads are unchanged (the *_select policies stay membership-scoped).
--
-- Workers and the service role bypass RLS, so the pipeline is unaffected.
-- Idempotent: safe to re-run.

-- ── Role helper (mirrors lib/auth.ts ROLE_RANK: viewer < editor < admin;
--    super-admins outrank everyone). SECURITY DEFINER like user_station_ids()
--    so it can read station_users/super_admins regardless of the caller's RLS.
create or replace function public.user_has_station_role(st uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.super_admins sa where sa.user_id = auth.uid())
      or exists (
        select 1 from public.station_users su
        where su.user_id = auth.uid()
          and su.station_id = st
          and (case su.role when 'admin' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end)
              >= (case min_role when 'admin' then 3 when 'editor' then 2 when 'viewer' then 1 else 99 end)
      );
$$;

revoke all on function public.user_has_station_role(uuid, text) from public;
grant execute on function public.user_has_station_role(uuid, text) to anon, authenticated, service_role;

-- ── Tables scoped by their own station_id: editor to write.
drop policy if exists episode_log_write on public.episode_log;
create policy episode_log_write on public.episode_log for all
  using (public.user_has_station_role(station_id, 'editor'))
  with check (public.user_has_station_role(station_id, 'editor'));

drop policy if exists qir_drafts_write on public.qir_drafts;
create policy qir_drafts_write on public.qir_drafts for all
  using (public.user_has_station_role(station_id, 'editor'))
  with check (public.user_has_station_role(station_id, 'editor'));

drop policy if exists show_keys_write on public.show_keys;
create policy show_keys_write on public.show_keys for all
  using (public.user_has_station_role(station_id, 'editor'))
  with check (public.user_has_station_role(station_id, 'editor'));

drop policy if exists corrections_write on public.transcript_corrections;
create policy corrections_write on public.transcript_corrections for all
  using (public.user_has_station_role(station_id, 'editor'))
  with check (public.user_has_station_role(station_id, 'editor'));

-- Station rows of the compliance word list (global rows stay super-admin only
-- via wordlist_write_global, unchanged).
drop policy if exists wordlist_write_station on public.compliance_wordlist;
create policy wordlist_write_station on public.compliance_wordlist for all
  using (station_id is not null and public.user_has_station_role(station_id, 'editor'))
  with check (station_id is not null and public.user_has_station_role(station_id, 'editor'));

-- ── Tables scoped through their episode: editor on the episode's station.
drop policy if exists compliance_flags_write on public.compliance_flags;
create policy compliance_flags_write on public.compliance_flags for all
  using (exists (select 1 from public.episode_log e
                 where e.id = compliance_flags.episode_id
                   and public.user_has_station_role(e.station_id, 'editor')))
  with check (exists (select 1 from public.episode_log e
                      where e.id = compliance_flags.episode_id
                        and public.user_has_station_role(e.station_id, 'editor')));

drop policy if exists transcripts_write on public.transcripts;
create policy transcripts_write on public.transcripts for all
  using (exists (select 1 from public.episode_log e
                 where e.id = transcripts.episode_id
                   and public.user_has_station_role(e.station_id, 'editor')))
  with check (exists (select 1 from public.episode_log e
                      where e.id = transcripts.episode_id
                        and public.user_has_station_role(e.station_id, 'editor')));

do $$
begin
  if to_regclass('public.transcript_chunks') is not null then
    execute 'drop policy if exists transcript_chunks_write on public.transcript_chunks';
    execute $p$create policy transcript_chunks_write on public.transcript_chunks for all
      using (exists (select 1 from public.episode_log e
                     where e.id = transcript_chunks.episode_id
                       and public.user_has_station_role(e.station_id, 'editor')))
      with check (exists (select 1 from public.episode_log e
                          where e.id = transcript_chunks.episode_id
                            and public.user_has_station_role(e.station_id, 'editor')))$p$;
  end if;
  if to_regclass('public.transcript_cues') is not null then
    execute 'drop policy if exists transcript_cues_write on public.transcript_cues';
    execute $p$create policy transcript_cues_write on public.transcript_cues for all
      using (exists (select 1 from public.episode_log e
                     where e.id = transcript_cues.episode_id
                       and public.user_has_station_role(e.station_id, 'editor')))
      with check (exists (select 1 from public.episode_log e
                          where e.id = transcript_cues.episode_id
                            and public.user_has_station_role(e.station_id, 'editor')))$p$;
  end if;
end $$;

-- ── station_settings: editor for ordinary overrides (prompts, batch sizes, …);
--    the per-station pause flag and spend caps are super-admin only. A station
--    editor could otherwise un-park a paused station or lift its cap.
drop policy if exists station_settings_write on public.station_settings;
create policy station_settings_write on public.station_settings for all
  using (
    public.user_has_station_role(station_id, 'editor')
    and (key not in ('pipeline_paused', 'spend_limit_monthly', 'spend_limit_quarterly') or public.is_super_admin())
  )
  with check (
    public.user_has_station_role(station_id, 'editor')
    and (key not in ('pipeline_paused', 'spend_limit_monthly', 'spend_limit_quarterly') or public.is_super_admin())
  );

-- ── usage_log: cost rows are written only by the service role (lib/usage.ts).
--    No user may insert, edit or delete them. Reads stay membership-scoped.
drop policy if exists usage_log_write on public.usage_log;
