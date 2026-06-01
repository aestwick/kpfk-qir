# Audit Log — Implementation Spec

Status: **approved for build** (this is a spec; no code shipped yet).
Owner decisions captured: **hybrid capture** (DB triggers + app-layer helper),
log **data mutations + auth events + reads/views + exports/downloads**, view
access **super-admins only** with a dashboard UI.

Target branch: `claude/great-clarke-I8QDw`.

---

## 1. Goal

A single append-only `audit_log` table that records **every action**, attributed
to **who did it** (a user) or marked **system** (workers / service-role), across
the multi-tenant app. Super-admins can review it in the dashboard.

"Every action" is captured two ways because Postgres triggers can see writes but
not reads, and Supabase Auth events happen client-side:

| Source of truth | Mechanism | Catches |
| --- | --- | --- |
| Data mutations (INSERT/UPDATE/DELETE) | **DB triggers** on every tenant table | Can't be forgotten; user attribution is automatic via `auth.uid()`; worker writes log as `system` |
| Reads/views, auth events, exports/downloads, semantic system events | **App-layer `logAuditEvent()`** (mirrors `lib/usage.ts`) | The things triggers structurally cannot see |

---

## 2. Why this design fits the codebase

- API routes use a **request-scoped RLS client** bound to the caller's JWT
  (`lib/auth.ts#getStationContext` → `createServerClient(token)` in
  `lib/supabase.ts`). Inside a trigger, `auth.uid()` therefore returns the acting
  user with **zero call-site changes**. This is the standard Supabase pattern.
- Workers use `supabaseAdmin` (service-role, no JWT) → `auth.uid()` is null →
  those writes are recorded as `actor_type = 'system'`. Specific system context
  (which job, which episode) is added by app-layer `logAuditEvent` calls.
- Existing logging precedent: `lib/usage.ts` inserts immutable rows into
  `usage_log` via `supabaseAdmin`. `audit_log` follows the same shape.
- Migrations are idempotent, commented, indexed; RLS helpers `user_station_ids()`
  (migration 014) and the `super_admins` table already exist.

---

## 3. Database migration — `supabase/migrations/028_audit_log.sql`

Next migration number is **028** (025_compliance_review_status →
026_show_grouping_and_names → 027_station_show_name_strip_prefixes are the latest).

### 3.1 Table

```sql
create table if not exists public.audit_log (
  id            bigserial primary key,
  -- Null for non-tenant events (e.g. a login before a station is chosen,
  -- or a super_admins table change). Set whenever the row/event is station-scoped.
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
```

### 3.2 Indexes

```sql
create index if not exists idx_audit_log_station_time on public.audit_log (station_id, created_at desc);
create index if not exists idx_audit_log_actor_time   on public.audit_log (actor_id, created_at desc);
create index if not exists idx_audit_log_resource      on public.audit_log (resource_type, resource_id);
create index if not exists idx_audit_log_time          on public.audit_log (created_at desc);
create index if not exists idx_audit_log_action        on public.audit_log (action);
```

### 3.3 Generic trigger function

`station_id` is read from the changed row when that column exists. For tables
that have **no** `station_id` column but are episode-scoped (`transcripts`,
`compliance_flags`), resolve it via the `episode_id`. Tables with neither
(`stations`, `super_admins`, `qir_settings`) record `station_id = null`.

```sql
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

  -- changed fields on update
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
     v_old,
     v_new,
     v_changed);

  return coalesce(new, old);
end;
$$;
```

> Note: `changed_fields` will include `updated_at` on most updates. That's fine
> (it's accurate). The UI can de-emphasize timestamp-only diffs if desired.

### 3.4 Attach triggers

```sql
do $$
declare t text;
begin
  foreach t in array array[
    'episode_log','transcripts','show_keys','qir_drafts',
    'transcript_corrections','compliance_flags','compliance_wordlist',
    'station_users','station_settings','stations','super_admins','qir_settings'
  ]
  loop
    execute format('drop trigger if exists trg_audit on public.%I;', t);
    execute format(
      'create trigger trg_audit after insert or update or delete on public.%I
         for each row execute function public.audit_row_change();', t);
  end loop;
end $$;
```

> Confirm each table name exists before running (all are referenced in CLAUDE.md
> / migrations 001–025). Drop any that don't apply.

### 3.5 RLS — append-only, super-admin read

```sql
alter table public.audit_log enable row level security;

-- Read: super-admins only.
create policy audit_log_select_superadmin on public.audit_log
  for select
  using (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()));

-- No INSERT/UPDATE/DELETE policies => no client (anon/authenticated) can write or
-- mutate. Writes happen only via:
--   * the SECURITY DEFINER trigger function (runs as function owner), and
--   * the service-role key (bypasses RLS) used by lib/audit.ts.
-- This makes the log immutable from the app's perspective.
```

> Make sure migration 028 runs as a role that owns the function so SECURITY
> DEFINER inserts succeed (same role that owns the other tables). Standard for
> Supabase migrations.

---

## 4. `lib/types.ts` — add interface

Add alongside `UsageLog`:

```typescript
export interface AuditLog {
  id: number
  station_id: string | null
  actor_id: string | null
  actor_type: 'user' | 'system' | 'anonymous'
  action: string
  resource_type: string | null
  resource_id: string | null
  operation: 'insert' | 'update' | 'delete' | 'read' | 'login' | 'logout' | 'export' | 'login_failed' | 'station_switch'
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  changed_fields: string[] | null
  metadata: Record<string, unknown>
  ip_address: string | null
  user_agent: string | null
  created_at: string
}
```

---

## 5. `lib/audit.ts` (new) — app-layer helper

Mirrors `lib/usage.ts`: service-role insert, **fire-and-forget**, must never
throw into the request path (wrap in try/catch, log to console on failure).

```typescript
import { NextRequest } from 'next/server'
import { supabaseAdmin } from './supabase'

export interface AuditEventInput {
  stationId?: string | null
  actorId?: string | null            // omit/null => system
  action: string                     // 'auth.login', 'episode.read', 'report.export'
  resourceType?: string | null
  resourceId?: string | number | null
  operation: 'read' | 'login' | 'logout' | 'export' | 'login_failed' | 'station_switch' | 'insert' | 'update' | 'delete'
  metadata?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}

export async function logAuditEvent(e: AuditEventInput): Promise<void> {
  try {
    await supabaseAdmin.from('audit_log').insert({
      station_id: e.stationId ?? null,
      actor_id: e.actorId ?? null,
      actor_type: e.actorId ? 'user' : 'system',
      action: e.action,
      resource_type: e.resourceType ?? null,
      resource_id: e.resourceId != null ? String(e.resourceId) : null,
      operation: e.operation,
      metadata: e.metadata ?? {},
      ip_address: e.ip ?? null,
      user_agent: e.userAgent ?? null,
    })
  } catch (err) {
    console.error('logAuditEvent failed:', err)
  }
}

/** Pull client IP + user-agent from a request for audit context. */
export function requestMeta(request: NextRequest): { ip: string | null; userAgent: string | null } {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null
  return { ip, userAgent: request.headers.get('user-agent') }
}
```

> Reads/auth/export events set `actor_type` from whether `actorId` is present.
> For an explicit system event from a worker, pass `actorId: null`.

---

## 6. App-layer instrumentation (the hybrid half)

DB triggers already cover all mutations. App-layer calls cover what they can't.
Keep these **selective** to avoid drowning the table.

### 6.1 Reads / views (instrument meaningful resource views, NOT every list)

Add a `logAuditEvent({ operation: 'read', ... })` after a successful fetch in:

- `app/api/episodes/[id]/route.ts` — GET (episode detail view). action `episode.read`.
- Transcript/VTT fetch path (episode detail loads transcript) — action `transcript.read`.
- `app/api/members/route.ts` — GET (who viewed the member list). action `members.read`.
- Public/finalized report view: `app/[station]/[year]/q[quarter]/page.tsx`
  (server component) — action `report.read`, `actor_type` may be `anonymous`
  for public viewers (no JWT). Pull IP/UA from `headers()`.

Do **not** instrument the paginated `episodes` list, dashboard stats, counts, or
job polling — too noisy, low value. (Revisit if broader read coverage is wanted.)

### 6.2 Exports / downloads

- `app/api/episodes/route.ts` — CSV export branch. action `episodes.export`,
  metadata `{ format: 'csv', count }`.
- `app/api/qir/export/route.ts` — action `report.export`, metadata `{ format }`.
- `app/api/downloads/route.ts` — action `downloads.export`, metadata describing
  what was bundled.

Pull `userId`/`stationId` from `getStationContext`, IP/UA from `requestMeta`.

### 6.3 Auth events (client-reported, since Supabase Auth runs in the browser)

New route **`app/api/audit/event/route.ts`** — `POST`, authed via
`getStationContext` **except** it must also accept a still-valid token for
`logout`. Accepts a small allowlisted set of auth/station actions and writes via
`logAuditEvent`. Reject any `operation`/`action` outside the allowlist so clients
can't forge arbitrary audit rows.

Allowed from client:
- `auth.login` (operation `login`) — posted by `app/login/page.tsx` on success.
- `auth.login_failed` (operation `login_failed`) — posted on failed sign-in
  (actor unknown → `anonymous`, include attempted email in metadata).
- `auth.logout` (operation `logout`) — posted before sign-out.
- `auth.station_switch` (operation `station_switch`) — posted by the station
  switcher; metadata `{ from, to }`.

`app/login/page.tsx` and the station switcher call this via `authedFetch`
(`lib/api-client.ts`) — login_failed will need an unauthed fetch since there's no
session yet (the route must allow an anonymous body for `login_failed` only).

### 6.4 System events from workers

In `workers/ingest.ts`, `transcribe.ts`, `summarize.ts`, `generate-qir.ts`, after
a stage completes, call `logAuditEvent({ actorId: null, stationId, operation:
'insert'|'update', action: 'ingest.complete' | 'transcribe.complete' | ... ,
resourceType: 'episode', resourceId, metadata })`. These add the *which job /
which counts* detail that the generic trigger can't express. Optional but
recommended for a readable system trail.

---

## 7. Read API — `app/api/audit/route.ts` (GET, super-admin only)

- Resolve `getStationContext`; **reject if `!context.isSuperAdmin`** (403).
- Use the request-scoped RLS `supabase` client — RLS already restricts rows to
  super-admins, so this is defense in depth.
- Query params: `page`, `pageSize` (cap ~100), `actorId`, `action`,
  `resourceType`, `operation`, `stationId`, `from`, `to` (date range), free-text
  `q` (ILIKE on action/resource_id). Order `created_at desc`.
- Return rows + total count for pagination.
- Resolve `actor_id` → email via `supabaseAdmin` against `auth.users` (same
  pattern as `app/api/members/route.ts`), since the table stores only UUIDs.

---

## 8. UI — `app/dashboard/audit/page.tsx` (super-admin only)

- `'use client'`, fetch via `authedFetch('/api/audit?...')`.
- Filter bar: actor (email dropdown), action, resource type, operation, station,
  date range. Paginated table: time, actor (email or "system"), action,
  resource (`type #id`), station. Expandable row → old→new diff (highlight
  `changed_fields`) + metadata + IP/UA.
- Use existing `app/components/skeleton.tsx` and `empty-state.tsx`.
- **Nav gating**: add a `{ href: '/dashboard/audit', label: 'Audit Log' }` entry
  in `app/dashboard/layout.tsx`, rendered **only when the current user is a
  super-admin**. The layout doesn't currently know `isSuperAdmin`; surface it by
  either (a) adding `isSuperAdmin` to the `app/api/dashboard` response and
  reading it in the layout, or (b) a tiny `GET /api/auth/me` returning
  `{ isSuperAdmin }`. Option (a) is least new surface.
- The page itself must also hard-gate: if the `/api/audit` call returns 403,
  render an "access denied" state (don't rely on nav hiding alone).

---

## 9. Build order (suggested)

1. Migration `028_audit_log.sql` (table, indexes, trigger fn, triggers, RLS).
   Apply to a throwaway/staging DB first; verify a manual UPDATE on `show_keys`
   via an authed client logs with the right `actor_id`, and a worker write logs
   as `system`.
2. `lib/types.ts` `AuditLog` + `lib/audit.ts` helper.
3. `GET /api/audit` + super-admin gate.
4. Dashboard page + nav gating.
5. App-layer instrumentation: exports → auth events → selective reads → worker
   system events.

Each step is independently shippable; 1–4 deliver the core (all mutations already
captured by triggers) and 5 fills in reads/auth/exports.

---

## 10. Verification checklist

- [ ] Authed PATCH (e.g. edit an episode summary) creates an `audit_log` row with
      `actor_id` = the editing user, `changed_fields` listing `summary`.
- [ ] A worker transcription writes a row with `actor_type='system'`,
      `actor_id` null.
- [ ] DELETE of a `qir_draft` logs `old_data` with the full pre-image.
- [ ] A non-super-admin gets 403 from `GET /api/audit` and cannot SELECT
      `audit_log` directly (RLS denies).
- [ ] A super-admin sees rows scoped correctly and the diff view renders.
- [ ] Login, failed login, logout, and station switch each produce a row.
- [ ] CSV export and report export each produce an `export` row with format/count.
- [ ] Episode-detail and report views produce `read` rows; list/poll endpoints do
      NOT (noise check).
- [ ] `audit_log` rows cannot be UPDATEd or DELETEd by any client (append-only).

---

## 11. Trade-offs / follow-ups (call out to owner)

- **Reads are selective**, not every SELECT (Postgres can't trigger on reads;
  full read logging would balloon the table). Broaden later if needed.
- **Worker writes log as generic `system`** via triggers; app-layer system events
  add specifics. There's no per-worker user identity to attribute.
- **Volume/retention**: no pruning yet. Consider a retention policy (archive or
  delete `created_at < now() - interval '18 months'`) as a fast follow; FCC-style
  compliance contexts often want long retention, so confirm before pruning.
- **`changed_fields` includes `updated_at`** on most updates — accurate but noisy;
  UI can de-emphasize.
- **Public report reads** are `anonymous` (no JWT); decide if you want to log
  those at all or only authenticated views.
- **PII in `old_data`/`new_data`**: the log stores full row images (incl. emails,
  transcripts could be large). Super-admin-only RLS mitigates exposure; consider
  excluding very large columns (e.g. `transcripts.transcript`) from the captured
  image if size becomes a problem (the trigger can strip heavy keys before insert).
