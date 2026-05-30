# Spec: Show Groups

## 1. Problem & Motivation

Some programs are ingested as **several `show_keys` (feeds)** that are really
**one logical show**:

- A 6-hour program split across **6 archive keys**, each with a *slightly
  different* `show_name` (e.g. "Morning Magazine Hr 1", "… Hr 2", …). They do
  **not** share a name, so they can't be auto-grouped by name.
- A program with multiple airings under near-identical names.

Today the dashboard, the QIR report, and the pipeline treat each key as its own
show. Staff need to manage and report these as **one show**.

**Goal:** a first-class, persistent **Show Group** that bundles multiple
`show_keys` into one logical show with its own show-like attributes — each
attribute either **inherited** from the member feeds or **set manually** — and
have that identity take effect across the **Shows management UI**, the **QIR
report + public pages**, the **processing pipeline**, and **dashboard views**.

This **replaces** the temporary auto name-matching grouping added in commit
`e0fc482` (which collapsed rows by exact `show_name` and therefore can't handle
differently-named hours).

## 2. Concepts

- **Show key / feed** — a `show_keys` row: one RSS feed (`key`), with
  `show_name`, `category`, `default_category`, `active`, `email`.
- **Show group** — a named, station-scoped entity that owns a set of show keys
  and carries the same attribute set as a show.
- **Membership** — each show key belongs to **at most one** group
  (`show_keys.group_id`, nullable). Ungrouped keys behave exactly as today.
- **Effective attribute** — the value used by the app for a grouped key/episode,
  after applying the inherit-vs-manual resolution rules (§4).

## 3. Data Model

### 3.1 New table `show_groups` (migration `020_show_groups.sql`)

Station-scoped, mirrors the conventions in `012`–`014`.

```sql
create table public.show_groups (
  id               uuid primary key default gen_random_uuid(),
  station_id       uuid not null references public.stations(id) on delete cascade,
  name             text not null,                 -- the group's display name (always manual)
  category         text,                          -- null = inherit from members
  default_category text,                          -- null = inherit from members
  email            text,                          -- null = inherit from members
  active           boolean not null default true, -- group-level on/off switch
  created_at       timestamptz not null default now(),
  updated_at       timestamptz
);

-- One group name per station.
create unique index show_groups_station_name_unique
  on public.show_groups (station_id, lower(name));

create index idx_show_groups_station on public.show_groups (station_id);
```

### 3.2 `show_keys.group_id`

```sql
alter table public.show_keys
  add column if not exists group_id uuid
  references public.show_groups(id) on delete set null;

create index if not exists idx_show_keys_group on public.show_keys (group_id);
```

- `on delete set null`: deleting a group **un-groups** its members (no data
  loss; the feeds keep running standalone).
- App code must enforce that a key's `group_id` references a group in the **same
  `station_id`** (RLS + an explicit check in the API; see §6).

### 3.3 RLS (in the same migration, mirroring `014_rls.sql`)

```sql
alter table public.show_groups enable row level security;

create policy show_groups_select on public.show_groups
  for select using (station_id in (select user_station_ids()));
create policy show_groups_write on public.show_groups
  for all using (station_id in (select user_station_ids()))
  with check (station_id in (select user_station_ids()));
```

No public-read policy: groups are internal. Public reports read a **snapshot**
(`qir_drafts.curated_entries`), so they never query `show_groups` (§7).

Workers use the service-role client (RLS bypassed) and **must** filter
`show_groups`/`show_keys` by `station_id` explicitly, per the project's
defense-in-depth rule.

### 3.4 No change to `qir_drafts`

`curated_entries` already snapshots `show_name` per entry. Group identity is
resolved into that snapshot **at generation time** (§7), so finalized reports
stay stable even if a group is later renamed or disbanded.

## 4. Attribute Resolution (inherit vs. manual)

Decision: **manual override wins; blank inherits; "mixed" surfaces, never
guesses.** Applied per attribute.

Let a group `G` have members `M = {m1…mn}` (its show keys).

### 4.1 `name`
- **Always the group's own `name`.** This is the whole point — differently-named
  member feeds collapse to one name. No inheritance.

### 4.2 `category`, `default_category`, `email`
Two distinct resolutions, because one is a single group-level display value and
the other is the value applied to an individual feed/episode:

- **Group display value** (shown in the Shows UI group row, used where one value
  represents the whole group):
  - if `G.<attr>` is non-null → that value (manual override);
  - else if all members share one non-null value → that value (clean inherit);
  - else → **`(mixed)`** (UI shows this; treated as "no group-level value").
- **Per-feed effective value** (used by the pipeline for a specific member key
  `m`, e.g. when stamping an episode):
  - `G.<attr> ?? m.<attr>` — the group override if set, otherwise the member's
    own value passes through unchanged.

So a blank group attribute never erases per-feed data; it just declines to
override. `(mixed)` is an editor signal to set the value explicitly if a single
group-level value is wanted.

### 4.3 `active`
- **Per-feed effective active** = `G.active && m.active`.
  - `G.active = false` → **every** member feed is treated inactive (skipped at
    ingest), regardless of each feed's own flag.
  - `G.active = true` → each member's own `active` still applies (a single feed
    can be turned off without disabling the group).

### 4.4 Helpers (`lib/show-groups.ts`, new)
- `getShowGroups(stationId)` → groups + their member keys.
- `resolveGroupDisplay(group, members)` → `{ name, category, default_category,
  email, active }` with `'(mixed)'` markers for the UI.
- `effectiveForKey(key, group)` → `{ show_name, category, default_category,
  email, active }` used by pipeline/report read paths.
- A `Map<showKey, group>` builder for O(1) lookups in batch paths (ingest,
  generate-qir).

## 5. Types (`lib/types.ts`)
- Add `group_id: string | null` to `ShowKey`.
- Add:
  ```ts
  export interface ShowGroup {
    id: string
    station_id: string
    name: string
    category: string | null
    default_category: string | null
    email: string | null
    active: boolean
    created_at: string
    updated_at: string | null
  }
  export interface ShowGroupWithMembers extends ShowGroup {
    members: ShowKey[]              // member show_keys (with episode_count)
    // resolved display attrs incl. '(mixed)' markers, computed server-side
    display: {
      category: string | null
      default_category: string | null
      email: string | null
      active: boolean
      mixed: Partial<Record<'category' | 'default_category' | 'email', true>>
    }
  }
  ```

## 6. API

### 6.1 New route `app/api/show-groups/route.ts`
Uses `getStationContext(request)` (RLS client + `stationId`) like other routes;
every query also `.eq('station_id', stationId)`. Per the per-station roles added
in migration `019_member_management.sql`, all **write** handlers (POST/PATCH/
DELETE) must gate on `requireRole(result.context, 'editor')` — matching the
guards now on `app/api/settings/route.ts` PUT/PATCH.

- **GET** → `{ groups: ShowGroupWithMembers[] }` — groups for the active
  station, each with member keys + per-show episode counts + resolved `display`.
  A group's episode count is the **sum** of its members' counts from the
  existing `get_episode_counts_by_show` RPC — no new per-group RPC needed.
- **POST** `{ name }` → create an empty group (attrs null, active true).
- **PATCH** `{ id, name?, category?, default_category?, email?, active? }` →
  update group attrs (allowlist; `null` clears → inherit). Sets `updated_at`.
- **DELETE** `{ id }` → delete group (members auto-ungrouped via FK).

### 6.2 Membership assignment (extend `app/api/settings/route.ts`)
- Add `group_id` to the `resource: 'show'` PATCH allowlist (currently
  `['show_name','category','default_category','active','email']`). This handler
  already enforces `requireRole(..., 'editor')` on main — unchanged.
- Validate that a non-null `group_id` belongs to a group in the **same
  station** before assigning (defense in depth alongside RLS).
- The existing `GET ?resource=shows` response gains each show's `group_id` so
  the Shows UI can render membership.

## 7. QIR Report & Public Pages

Source of truth for the report is built in `workers/generate-qir.ts`; the public
page (`app/[station]/[year]/q[quarter]/page.tsx`) just renders the stored
`curated_entries` snapshot.

Changes (generation only — **no schema, no public-page change**):
1. Load the station's groups + `show_keys.group_id` once; build a
   `Map<show_key, group>`.
2. In `episodeToQirEntry` (or a wrapper in generate-qir), when an episode's
   `show_key` is in a group, set the entry's **`show_name` = group.name**
   (effective). Ungrouped episodes keep their own `show_name`.
3. This flows automatically into:
   - the AI curation prompt (entries already use `e.show_name`),
   - `formatFullReport` / `formatCuratedReport` (`lib/qir-format.ts`),
   - the stored `curated_entries[].show_name` snapshot,
   - the public page (reads the snapshot — renders the group name).
4. **Curation variety:** the curation prompt asks the model to favor a "variety
   of shows." Today it keys off `show_name`; after step 2 all member episodes
   share the group name, so they're correctly treated as one show for variety —
   a desirable side effect.
5. **`includedShows` filter:** stays key-based in the job
   (`GenerateQirOptions.includedShows: string[]`). The generate UI
   (`app/dashboard/generate/page.tsx`, which lists shows via
   `app/api/qir/shows/route.ts`) expands a selected group to its member keys
   when building the request, and presents groups as single selectable rows.

Note: episodes are grouped in the report by `issue_category` (the AI-assigned
QIR category), which is unchanged. Show grouping only affects the **label**
(`show_name`) and curation variety, not which category section an entry lands in.

> **Design note — why no `episode_log.group_id`.** A tempting alternative is to
> denormalize the group onto each episode at ingest (faster group filters). We
> deliberately **don't**: membership and group names are resolved at read time
> from the live `show_keys.group_id`, so reassigning a key to another group or
> renaming a group never requires rewriting historical `episode_log` rows.
> Group filters expand the group to its *current* member keys and filter by
> `show_key` — always correct, no stale denormalized column.

## 8. Processing Pipeline

### 8.1 Ingest (`workers/ingest.ts`)
When selecting/active-filtering shows for a station:
- Load groups for the station; build the key→group map.
- A member key is **skipped** if its group's `active = false` (in addition to
  the existing per-key `active` filter and the `excluded_show_keys` blocklist).
- When inserting an episode, stamp `episode_log.category` with the **per-feed
  effective category** (`group.category ?? show.category`) so downstream
  exclusion/labeling is consistent. (`show_name` is **not** overwritten — it
  stays the per-feed name; the group name is resolved at read time, §7/§9, so
  renaming a group never requires rewriting episode rows.)

### 8.2 Summarize / Transcribe (`workers/summarize.ts`, `workers/transcribe.ts`)
- Both read the **cached** `episode_log.category` for their excluded-category
  guard (`ep.category?.includes(exc)`), which now carries the effective category
  stamped at ingest — **no change needed** beyond confirming behavior.
- No change to AI `issue_category` assignment.

### 8.3 Effective-attribute changes are forward-looking
Changing a group's `category`/`active` affects **future** ingests. Existing
`episode_log` rows keep their stamped values. (Optional future: a "re-apply
group attributes to existing episodes" admin action — out of scope here.)

## 9. Dashboard Views

Resolve the group name at read time via the key→group relationship (client-side
using the shows+groups already fetched, or server-side joins where the API
already aggregates).

- **Settings → Shows tab** (`app/dashboard/settings/page.tsx`): primary surface
  (§10).
- **Episodes list** (`app/dashboard/episodes/page.tsx` + `app/api/episodes`):
  - Display the **group name** for grouped episodes (fall back to per-feed
    `show_name` when ungrouped).
  - The "show" filter offers groups (selecting a group filters to its member
    keys).
- **Overview** (`app/dashboard/page.tsx`): "Show Coverage Gaps" and the
  Broadcast Log group by group name where a key is grouped (a group with any
  summarized member is "covered").
- **Shows audit** (`app/dashboard/shows/audit/page.tsx`): allow auditing by
  group (expands to member keys).

These are **label/aggregation** changes; no schema impact. Lower-risk views
(activity feed cosmetics) can land after the core.

## 10. Settings UI — Shows tab (`app/dashboard/settings/page.tsx`)

Replace the auto name-matching `groupedShows` (rowSpan-by-name) added in
`e0fc482` with **explicit groups**:

- **Rendering:** list each show group as a header row showing the group name +
  resolved attributes (with `(mixed)` where members disagree), with its member
  keys nested beneath. Ungrouped keys render in an "Ungrouped" section exactly
  as today. Each member row keeps its own Key / Active / **Exclude** (per-key,
  `excluded_show_keys`) / episode-count controls.
- **Create group:** a "New group" control (name input) → `POST /api/show-groups`.
- **Edit group attributes:** inline-editable `name`, `category` (dropdown,
  blank = Inherit), `default_category`, `email`, and an `active` toggle →
  `PATCH /api/show-groups`. Blank/Inherit clears the field (null); UI shows the
  resolved/`(mixed)` value as placeholder.
- **Assign membership:** on each show row, a "Group" selector (None / existing
  groups) → `PATCH /api/settings {resource:'show', id, group_id}`. (A
  multi-select "add to group" affordance is a nice-to-have.)
- **Delete group:** confirm → `DELETE /api/show-groups` (members fall back to
  Ungrouped).
- Keep the existing per-key **Exclude** checkbox and the Pipeline-tab
  `excluded_show_keys` field unchanged — exclusion stays per-feed and is
  orthogonal to grouping.

## 11. Backward Compatibility & Cleanup
- Remove the `groupedShows` name-matching derivation and rowSpan rendering from
  `e0fc482`; replace with explicit-group rendering (§10).
- `excluded_show_keys` (per-key exclusion) and the per-key `active` toggle are
  unchanged and continue to work for ungrouped and grouped feeds alike.
- KPFK and existing stations start with **zero** groups; everything behaves as
  today until a group is created. No data migration/backfill required.

## 12. Edge Cases & Rules
- **Most-restrictive wins:** a feed is ingested only if it is *not* excluded
  (`excluded_show_keys`), *its own* `active` is true, *and* its group (if any)
  `active` is true.
- **Mixed attribute + blank group value:** UI shows `(mixed)`; pipeline passes
  each member's own value through (no override). The report's group label still
  uses the group `name` regardless.
- **Cross-station safety:** assignment validates the group's `station_id`
  matches the show's; RLS backstops it.
- **Renaming/disbanding a group** never rewrites `episode_log` or finalized
  `qir_drafts` (read-time resolution + snapshot).
- **Group with no members:** allowed (e.g. created before assigning); ignored by
  pipeline/report until it has members.

## 13. Out of Scope (future)
- Re-stamping existing `episode_log` rows when a group's category changes.
- Group-level bulk actions (retry/re-summarize all members) beyond what per-show
  actions already allow.
- Nested groups / a key in multiple groups.
- A provisioning UI for groups across stations (super-admin).

## 14. Implementation Plan (phased, each phase independently verifiable)

1. **Schema** — `supabase/migrations/020_show_groups.sql`: `show_groups` table,
   `show_keys.group_id`, indexes, RLS policies.
2. **Types & helpers** — `lib/types.ts` (`ShowGroup`, `ShowGroupWithMembers`,
   `ShowKey.group_id`); new `lib/show-groups.ts` (fetch + resolution helpers).
3. **API** — new `app/api/show-groups/route.ts` (CRUD); extend
   `app/api/settings/route.ts` (`group_id` in show PATCH allowlist + same-station
   validation; `group_id` in `?resource=shows`).
4. **Settings UI** — `app/dashboard/settings/page.tsx`: replace name-matching
   with explicit groups; create/edit/assign/delete; nested members.
5. **Pipeline** — `workers/ingest.ts` (group active skip + effective category
   stamp); confirm `workers/summarize.ts`.
6. **QIR report** — `workers/generate-qir.ts` (resolve group name into entries);
   `app/dashboard/generate/page.tsx` (group selection expands to keys). Public
   page needs no change.
7. **Dashboard views** — episodes list/filter, coverage gaps, audit.

Verify each phase with `npx tsc --noEmit` and `npm run build`; manually exercise
the Shows tab and a dry-run QIR generation against a grouped show.

## 15. Open Questions (please confirm before build)
1. **Group `active` semantics:** confirm `G.active=false` should hard-skip all
   members at ingest (this spec assumes yes).
2. **Generate UI:** are groups shown as a single selectable row that expands to
   member keys (assumed), or do you also want to pick individual member keys?
3. **Effective category at ingest:** OK to stamp `episode_log.category` with the
   group override at ingest (forward-looking only, no backfill)?
