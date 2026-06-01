-- Audit Log — a single append-only table recording every user and system action
-- across the multi-tenant app. See ideas/AUDIT_LOG_SPEC.md.
--
-- Hybrid capture:
--   * DB triggers (this migration) record every INSERT/UPDATE/DELETE on tenant
--     tables. user attribution is automatic via auth.uid(); worker writes (no JWT)
--     are recorded as actor_type='system'. Triggers structurally cannot see reads.
--   * App-layer lib/audit.ts#logAuditEvent records the rest (reads, auth events,
--     exports/downloads, semantic system events from workers).
--
-- Retention: PERMANENT. There is intentionally NO TTL, cron cleanup, or
-- partition-drop here or anywhere else — the DB is the complete system of record
-- (FCC/compliance context). The dashboard shows a trailing window only.

-- ---------------------------------------------------------------------------
-- 3.1 Table
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id            bigserial primary key,
  -- Null for non-tenant events (e.g. a login before a station is chosen, or a
  -- super_admins table change). Set whenever the row/event is station-scoped.
  station_id    uuid references public.stations(id) on delete set null,
  -- Null when the actor is the system (worker / service-role, no JWT) or anonymous.
  actor_id      uuid,                  -- references auth.users(id); no FK so user deletion never blocks audit writes
  actor_type    text not null default 'user'
                  check (actor_type in ('user', 'system', 'anonymous')),
  -- Dotted semantic action, e.g. 'episode.update', 'auth.login', 'report.export'.
  action        text not null,
  resource_type text,                  -- 'episode', 'qir_draft', 'show_key', 'session', ...
  resource_id   text,                  -- text so it holds bigints and uuids alike
  operation     text not null          -- low-level verb
                  check (operation in ('insert','update','delete','read','login','logout','export','login_failed','station_switch')),
  old_data      jsonb,                 -- pre-image (update/delete); null otherwise
  new_data      jsonb,                 -- post-image (insert/update); null otherwise
  changed_fields text[],               -- keys that differ between old/new (updates)
  metadata      jsonb not null default '{}'::jsonb,  -- free-form context
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);

comment on table public.audit_log is 'Append-only audit trail of every user and system action. Written by the audit_row_change() trigger (data mutations) and lib/audit.ts logAuditEvent() (reads, auth, exports, system events). Readable by super-admins only.';

-- ---------------------------------------------------------------------------
-- 3.2 Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_audit_log_station_time on public.audit_log (station_id, created_at desc);
create index if not exists idx_audit_log_actor_time   on public.audit_log (actor_id, created_at desc);
create index if not exists idx_audit_log_resource     on public.audit_log (resource_type, resource_id);
create index if not exists idx_audit_log_time         on public.audit_log (created_at desc);
create index if not exists idx_audit_log_action       on public.audit_log (action);

-- ---------------------------------------------------------------------------
-- 3.3 Heavy-field redactor — replace oversized string values with a length-marked
-- placeholder so the permanent audit image stays small and self-describing
-- (transcript text, VTT, embeddings would otherwise bloat every row). Applied to
-- old/new before insert.
-- ---------------------------------------------------------------------------
create or replace function public.audit_redact(j jsonb)
returns jsonb
language sql
immutable
as $$
  select case when j is null then null else (
    select coalesce(jsonb_object_agg(
             key,
             case
               when jsonb_typeof(value) = 'string' and length(value #>> '{}') > 2000
                 then to_jsonb('<redacted: ' || length(value #>> '{}') || ' chars>')
               else value
             end), '{}'::jsonb)
    from jsonb_each(j)
  ) end;
$$;

-- ---------------------------------------------------------------------------
-- 3.3 Generic trigger function. station_id is read from the changed row when that
-- column exists; for episode-scoped tables without it (transcripts,
-- compliance_flags) it is resolved via episode_id; tables with neither record null.
-- ---------------------------------------------------------------------------
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old        jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end;
  v_new        jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end;
  v_station    uuid;
  v_resource   text;
  v_changed    text[];
  v_actor      uuid := auth.uid();
begin
  -- station_id: direct column, else episode_id lookup, else null
  if (v_new ? 'station_id') then
    v_station := (v_new ->> 'station_id')::uuid;
  elsif (v_old ? 'station_id') then
    v_station := (v_old ->> 'station_id')::uuid;
  elsif (coalesce(v_new, v_old) ? 'episode_id') then
    select e.station_id into v_station
    from public.episode_log e
    where e.id = (coalesce(v_new, v_old) ->> 'episode_id')::bigint;
  end if;

  -- resource id: prefer 'id'
  v_resource := coalesce(v_new ->> 'id', v_old ->> 'id');

  -- changed fields on update (computed from raw images, before redaction)
  if tg_op = 'UPDATE' then
    select array_agg(key)
    into v_changed
    from jsonb_each(v_new) n
    where n.value is distinct from (v_old -> n.key);
  end if;

  insert into public.audit_log
    (station_id, actor_id, actor_type, action, resource_type, resource_id,
     operation, old_data, new_data, changed_fields)
  values
    (v_station,
     v_actor,
     case when v_actor is null then 'system' else 'user' end,
     tg_table_name || '.' || lower(tg_op),
     tg_table_name,
     v_resource,
     lower(tg_op),
     public.audit_redact(v_old),   -- heavy strings replaced with length markers
     public.audit_redact(v_new),
     v_changed);

  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3.4 Attach the trigger to every tenant / membership table. Adding a NEW table
-- to the app? Add its name here so its mutations are audited too. (App-layer
-- action/operation types live in lib/audit.ts#AUDIT_ACTIONS — keep both in sync.)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'episode_log','transcripts','show_keys','qir_drafts',
    'transcript_corrections','compliance_flags','compliance_wordlist',
    'station_users','station_settings','stations','super_admins','qir_settings'
  ]
  loop
    -- Skip any table that doesn't exist in this database rather than failing the
    -- whole migration (keeps it portable across environments).
    if to_regclass('public.' || t) is null then
      raise notice 'audit: skipping missing table %', t;
      continue;
    end if;
    execute format('drop trigger if exists trg_audit on public.%I;', t);
    execute format(
      'create trigger trg_audit after insert or update or delete on public.%I
         for each row execute function public.audit_row_change();', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3.5 RLS — append-only, super-admin read.
-- No INSERT/UPDATE/DELETE policies => no client (anon/authenticated) can write or
-- mutate. Writes happen only via the SECURITY DEFINER trigger function (runs as
-- the function owner) and the service-role key (bypasses RLS) used by
-- lib/audit.ts. This makes the log immutable from the app's perspective.
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;

drop policy if exists audit_log_select_superadmin on public.audit_log;
create policy audit_log_select_superadmin on public.audit_log
  for select
  using (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()));
