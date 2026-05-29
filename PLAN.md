# PLAN.md — Multi-Station (Multi-Tenant) Conversion for QIR

> **Status:** Specification, ready to execute. No code has been written yet.
> **Audience:** A Claude Code session (Opus 4.7 / 4.8) executing this plan in a fresh context.
> **Mission:** Convert the single-station KPFK QIR app into a multi-tenant app — **one codebase, one database, one deployment** — where multiple radio stations share the system and Supabase-auth gates each user to only their station(s)' data.

---

## 0. How to use this document (READ FIRST)

This plan is the source of truth. Execute it **phase by phase, in order**. Each phase has a Goal, the exact files to touch, the changes, a **Verification** step that must pass, and a **Commit** step. Do not start a phase before the previous phase's verification passes and is committed.

### Rule legend

- **🔒 HARD RULE** — Non-negotiable. Never violate, never "improve upon," never skip. If a hard rule blocks you, **stop and ask the user** — do not work around it.
- **🔧 FLEXIBLE** — Default guidance. Use judgment; deviate if you have a concrete, stated reason, and note the deviation in your commit message or your message to the user.

### Global rules (apply to every phase)

- 🔒 **HARD — Stay in scope.** Only make changes this plan calls for. Do not add features, refactor unrelated code, rename things, "clean up" surrounding code, add docstrings/comments/type annotations to code you didn't change, or build abstractions for hypothetical future needs. A change to one file does not license touching its neighbors. (This codebase has no test suite and limited review — drift here is expensive.)
- 🔒 **HARD — Read before you edit.** Never edit or describe a file you have not opened in this session. Never claim how code behaves without reading it first.
- 🔒 **HARD — Never weaken or delete verification to make it pass.** If a build, type-check, lint, or check fails, fix the cause. Do not comment out checks, loosen types to `any` to silence errors, or skip steps. If a check seems wrong, tell the user instead of working around it.
- 🔒 **HARD — Do not edit migrations that have already been committed/applied.** Postgres migrations are append-only. To change schema, add a new numbered migration. Never rewrite `001`–`011` or any migration from a prior phase.
- 🔒 **HARD — No destructive shortcuts.** No `git push --force`, no `--no-verify`, no dropping columns/tables that hold real data, no `git reset --hard` on shared work. The database has ~1,400 real KPFK episodes and filed FCC reports — treat all existing data as production. Backfill, never truncate.
- 🔒 **HARD — Preserve KPFK's existing data and public URLs.** Every existing episode, transcript, draft, and finalized report must remain intact and reachable after migration. Filed FCC report links (`/2025/q1` style) must keep resolving (via redirect is fine).
- 🔒 **HARD — Verify with evidence, not assertion.** End each phase by running the verification commands and showing their actual output. "Looks done" is not done. Never declare a phase complete without showing the check passing.
- 🔧 **FLEXIBLE — Decisiveness.** Pick the approach this plan specifies and commit to it. Don't re-litigate decided architecture mid-task. If you hit genuinely new information that contradicts the plan, surface it to the user rather than silently changing course.
- 🔧 **FLEXIBLE — Commit granularity.** One commit per phase is the default. Split a phase into 2–3 commits if it genuinely helps reviewability. Don't bundle multiple phases into one commit.

### Working branch

- 🔒 **HARD — Develop on `claude/zealous-mayer-XuATX`.** Do not push to `main` or any other branch without explicit permission. Create a PR only if the user explicitly asks.

### Recommended harness enforcement (optional, do once before starting)

The research is clear that prose rules in a plan are *advisory* (~followed most of the time), while **hooks are deterministic**. If the user wants the hard rules above enforced at 100%, set up:
- A **PreToolUse hook** that blocks `Edit`/`Write` to `supabase/migrations/0*.sql` files older than the current phase's new migration (protects landed migrations).
- A **Stop hook** that runs `npm run build` and refuses to finish if it fails (gates "done" on a real check).

These are suggested, not required by this plan. Mention them to the user; don't build them unless asked.

---

## 1. Architecture decisions (DECIDED — do not redesign)

These were chosen by the product owner. 🔒 **HARD — implement exactly these; do not substitute alternatives.**

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Isolation** | **RLS + app-layer filtering (defense in depth).** Postgres Row Level Security is the hard backstop; app code *also* filters every query by `station_id`. A forgotten app-layer filter must not be able to leak cross-station data. |
| 2 | **Public URL** | **Path-based: `/[station]/[year]/q[quarter]`** (e.g. `/kpfk/2025/q1`). The legacy `/[year]/q[quarter]` route 301-redirects to the KPFK-slugged URL so filed FCC links keep working. |
| 3 | **User → station** | **Many-to-many with roles.** A `station_users` table maps each `auth.users` row to one or more stations with a role (`viewer` / `editor` / `admin`), plus an optional global `super_admin` who can access all stations. |
| 4 | **Tenant key** | A `stations` table with a UUID `id` and a URL-safe `slug` (e.g. `kpfk`). All tenant-scoped tables carry `station_id UUID REFERENCES stations(id)`. |

### Client strategy (how isolation is actually wired)

- **Server-side reads/writes that represent a user action** (API routes serving the dashboard) use a **request-scoped Supabase client bound to the caller's access token**, so RLS applies. Add this as a new helper (Phase 2). Also add the explicit `.eq('station_id', stationId)` filter — belt and suspenders.
- **Background workers** have no user JWT. They keep using the **service-role client** (`supabaseAdmin`, which bypasses RLS) but **must** carry `station_id` in their job payload and filter every query by it. For workers, the app-layer filter *is* the only guard, so it is mandatory and must be reviewed carefully.
- **Public finalized-report pages** read with the service-role or anon client but filter by the station resolved from the URL slug, and only ever read `status = 'final'` drafts.

---

## 2. Out of scope (DO NOT BUILD)

🔒 **HARD — Do not do any of the following as part of this work:**
- A station self-signup / onboarding flow, billing, or org management UI beyond what Phase 2 specifies. Stations are provisioned by SQL/admin for now.
- Per-station theming/branding assets (logos, colors) beyond substituting the station **name/slug** into existing text.
- Subdomain routing or DNS/Traefik changes (decision was path-based).
- Migrating to a different auth provider, queue, or DB.
- Rewriting the pipeline, the AI prompts' content (beyond parameterizing the station name), or the worker chaining logic.
- Adding a test framework (the repo has none; do not introduce one unless the user asks). Verification is via `npm run build`, type-check, and targeted manual/SQL checks described per phase.
- Performance optimization, caching changes, or "while I'm here" refactors.

If you believe something out-of-scope is genuinely required to make an in-scope item work, **stop and ask the user** before doing it.

---

## 3. Current-state facts (verified against the codebase — trust these, but re-read files before editing)

- **Migrations** live in `supabase/migrations/`, currently `001`–`011`. The next new file is `012`. `001` seeds `qir_settings` including `('station_id', '"KPFK, Los Angeles"')`. `qir_drafts` has a unique partial index `idx_qir_draft_active` on `(year, quarter) WHERE status='final'` (in `001`). `show_keys` has **no** unique constraint on `key` in these migrations (table predates them).
- **Supabase clients** are in `lib/supabase.ts`: `supabaseAdmin` (service-role, RLS-bypassing, lazy Proxy) and `createBrowserClient()` (anon key). There is **no** request-scoped user client yet.
- **All ~22 API routes under `app/api/` use `supabaseAdmin`** and filter by `year`/`quarter`/`status`/`show` — **none filter by station.** Routes include: `qir`, `qir/export`, `qir/shows`, `episodes`, `episodes/[id]`, `episodes/[id]/translate`, `episodes/counts`, `jobs`, `settings`, `compliance`, `compliance/report`, `compliance/wordlist`, `corrections`, `dashboard`, `downloads`, `events`, `feeds`, `feeds/[showKey]`, `health`, `usage`, `shows/audit`, `shows/audit/process`.
- **Workers** in `workers/`: `index.ts` (queue + cron setup), `ingest.ts`, `transcribe.ts`, `summarize.ts`, `compliance.ts`, `generate-qir.ts`, `auto-retry.ts`. Queues: `ingest`, `transcribe`, `summarize`, `compliance`, `generate-qir`, `auto-retry`. Cron: ingest `'2 * * * *'`, auto-retry `'17 */4 * * *'`. Workers now **atomically claim** episodes via a candidate-select then a guarded `.update({status}).in('id', ids).eq('status', <prev>)` (see `transcribe.ts:~170-208`, `summarize.ts:~58-79`). Multi-station filtering must be added to **both** the candidate query and the claim.
- **Auth**: `app/dashboard/layout.tsx` (~lines 87-109) checks for a Supabase session client-side and redirects to `/login` if absent; `app/login/page.tsx` does email/password sign-in. There is **no `middleware.ts`** and **no per-station/RLS isolation** today. (Note: project `CLAUDE.md` mentions an "auth bypass lines 34-38" — verify whether that still exists when you open the file; the file may have changed. Reconcile reality vs. the doc and tell the user if they diverge.)
- **Hardcoded station references** to handle (re-grep `-i kpfk` to confirm before editing; do not assume this list is exhaustive):
  - `supabase/migrations/001_*.sql:26` — `station_id` seed `"KPFK, Los Angeles"`.
  - `supabase/migrations/004_compliance.sql:~35` — compliance prompt says "for KPFK".
  - `lib/settings.ts:~69` — `DEFAULT_SUMMARIZATION_PROMPT` says "for KPFK".
  - `lib/qir-format.ts:~64` — report header `"KPFK, Los Angeles - Quarterly Issues Report"`.
  - `lib/parse-mp3-url.ts:~11` — regex `/kpfk_(\d{6})_(\d{6})([a-zA-Z]+)\.mp3/` (filename prefix is station-specific).
  - `workers/ingest.ts:~64` — `https://archive.kpfk.org/getrss.php?id=${show.key}` (RSS base URL).
  - `workers/compliance.ts:~124` & `~143` — station-ID detection regex `/kpfk|90\.7|.../i` and the flag message.
  - `app/[year]/q[quarter]/page.tsx:~16,17,103` — metadata + `<h1>KPFK, Los Angeles</h1>`.
  - `app/compliance-report/page.tsx` — "KPFK 90.7 FM — Compliance Report".
  - `app/api/feeds/route.ts:~17` & `app/api/feeds/[showKey]/route.ts:~45,72-77` — base URL fallback `https://qir.kpfk.org` and "KPFK 90.7FM" feed branding.
  - `app/dashboard/layout.tsx:~136,174` & `app/login/page.tsx:~38` & `app/layout.tsx` (title) — UI branding "QIR / KPFK", "KPFK 90.7 FM".
- **Types** in `lib/types.ts`: `EpisodeLog`, `ShowKey`, `ShowKeyWithCount`, `Transcript`, `UsageLog`, `QirSetting`, `QirDraft`, `ComplianceFlag`, `ComplianceWord`, `TranscriptCorrection`, `ComplianceFlagWithEpisode`, `QualityFlag`.

🔧 **FLEXIBLE** — Line numbers above are from a prior scan and may have shifted; treat them as starting points, re-grep to confirm exact locations.

---

## 4. Phases

> Sequencing principle: the **schema + backfill + RLS foundation must land together** (Phases A–C, ideally one PR) so the database is never in a half-scoped, leaky state. The **code-threading** work (Phases D–H) is broken into reviewable chunks. Within each phase, keep individual edits small.

### Phase A — Tenancy schema: `stations`, `station_users`, `station_settings`

**Goal:** Introduce the tenant tables and seed KPFK as the first station. No behavior change yet.

**Files:** new `supabase/migrations/012_stations.sql`.

**Changes:**
1. `CREATE TABLE stations (id uuid pk default gen_random_uuid(), slug text unique not null, name text not null, timezone text default 'America/Los_Angeles', rss_base_url text, mp3_filename_prefix text, station_id_patterns text[], created_at timestamptz default now())`.
   - `rss_base_url` replaces the hardcoded `archive.kpfk.org` base (store the part before `?id=` or the full template — document the exact format you choose in a SQL comment).
   - `mp3_filename_prefix` replaces the hardcoded `kpfk_` in the filename regex.
   - `station_id_patterns` replaces the hardcoded compliance station-ID regex alternation.
2. `CREATE TABLE station_users (id bigserial pk, station_id uuid not null references stations(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade, role text not null default 'viewer' check (role in ('viewer','editor','admin')), created_at timestamptz default now(), unique(station_id, user_id))`.
   - Add a `super_admins (user_id uuid pk references auth.users(id))` table OR a boolean — 🔧 FLEXIBLE: pick one, document it. (Recommended: a `super_admins` table; cleaner to query in RLS.)
3. `CREATE TABLE station_settings (id bigserial pk, station_id uuid not null references stations(id) on delete cascade, key text not null, value jsonb not null, updated_at timestamptz default now(), unique(station_id, key))`. This will hold per-station overrides; global `qir_settings` remains the fallback (Phase G).
4. **Seed KPFK**: insert one `stations` row with `slug='kpfk'`, `name='KPFK, Los Angeles'`, `rss_base_url` = the existing archive base, `mp3_filename_prefix='kpfk'`, `station_id_patterns=ARRAY['kpfk','90.7','ninety point seven']`. Capture its id (use a fixed UUID literal in the migration so later migrations/backfills can reference it deterministically).

**Verification:**
- `npm run build` passes.
- Apply the migration against a dev/branch DB (use the Supabase tooling the user prefers) and confirm the three tables exist and the KPFK row is present: `select slug,name from stations;`.
- Show the SQL output.

**Commit:** `Add stations, station_users, station_settings tables + seed KPFK`.

---

### Phase B — Add `station_id` to tenant tables + backfill existing data

**Goal:** Every tenant-scoped row gets a `station_id`, all existing rows assigned to KPFK, and uniqueness constraints made per-station.

**Files:** new `supabase/migrations/013_station_id_columns.sql`.

🔒 **HARD — Backfill before enforcing NOT NULL.** Order each table: `ADD COLUMN station_id uuid REFERENCES stations(id)` → `UPDATE ... SET station_id = '<kpfk-uuid>'` → `ALTER COLUMN station_id SET NOT NULL`. Never add a NOT NULL column to a populated table without a default/backfill first.

**Tables to alter (add `station_id`, backfill to KPFK, set NOT NULL):**
- `episode_log`
- `show_keys`
- `qir_drafts`
- `qir_settings` → 🔧 FLEXIBLE: instead of altering, treat `qir_settings` as the **global default layer** and let `station_settings` (Phase A) hold overrides. Recommended: **do not** add `station_id` to `qir_settings`; keep it global. Document the decision.
- `transcript_corrections`
- `compliance_wordlist`
- `usage_log` — add `station_id` directly (denormalized) for fast per-station cost rollups; backfill via its `episode_id → episode_log.station_id`.

**Tables that inherit scope via FK (no column needed — confirm and document):**
- `transcripts` (via `episode_id`)
- `compliance_flags` (via `episode_id`)

**Constraint changes:**
- Add `UNIQUE(station_id, key)` on `show_keys` (a show key is only unique within a station). If a global unique constraint on `show_keys.key` exists at apply time, drop it first; if none exists, just add the composite one.
- Drop `idx_qir_draft_active` and recreate it as `UNIQUE (station_id, year, quarter) WHERE status='final'` (one final report per station per quarter).
- Add indexes for the new access pattern: `(station_id, status)` on `episode_log`, `(station_id, year, quarter)` on `qir_drafts`, `(station_id, active)` on `show_keys`.

**Verification:**
- `npm run build` passes.
- Apply migration; confirm **zero** NULL station_ids: `select count(*) from episode_log where station_id is null;` (must be 0) for each altered table.
- Confirm KPFK row counts match pre-migration counts (no data loss): compare `select count(*) from episode_log;` before/after.
- Show output.

**Commit:** `Add station_id to tenant tables, backfill KPFK, per-station uniqueness`.

---

### Phase C — Row Level Security (the hard backstop)

**Goal:** RLS makes cross-station reads/writes impossible at the database level, regardless of app-code bugs.

**Files:** new `supabase/migrations/014_rls.sql`.

**Changes:**
1. Create a SQL helper, e.g. `function user_station_ids() returns setof uuid` that returns the station_ids the current `auth.uid()` belongs to (union of `station_users` and, if super_admin, all stations). Mark it `security definer` and `stable`.
2. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on every tenant-scoped table.
3. Add policies:
   - **SELECT**: `station_id in (select user_station_ids())`.
   - **INSERT/UPDATE/DELETE**: same membership check, optionally gated on role (`editor`/`admin`) for writes. 🔧 FLEXIBLE: role-gating writes can be a follow-up; at minimum gate by station membership.
   - For `transcripts`/`compliance_flags` (no `station_id` column), write policies that check membership through the `episode_log` join.
   - `station_users` / `super_admins`: a user may select their own rows; only super_admins manage them.
4. 🔒 **HARD — Confirm the service-role key still bypasses RLS** (it does by design) so workers keep functioning. RLS must not break background processing. Verify a worker query still returns rows when run with the service role.
5. **Public read path**: finalized reports are public. Either add a policy allowing anonymous SELECT on `qir_drafts WHERE status='final'`, OR keep the public page on the service-role client and filter in code. 🔧 FLEXIBLE: pick one; if you allow anon SELECT of finals, scope it tightly to `status='final'` only.

**Verification (this is the security-critical phase — test it for real):**
- With a user JWT belonging to a **second, throwaway test station** (create it + a test user via SQL in the migration's verification, not in the migration itself), confirm a SELECT on `episode_log` returns **only** that station's rows and **zero** KPFK rows.
- Confirm the service-role client still sees all rows (workers depend on this).
- Confirm anonymous client can read a `final` draft but not a `draft` one.
- Show the query outputs proving isolation.

**Commit:** `Enable RLS with per-station membership policies`.

> 🔧 FLEXIBLE — Phases A, B, C may be opened as a single PR (the "foundation"). Keep them as separate commits/migrations within it.

---

### Phase D — Auth & station context resolution

**Goal:** Resolve the caller's identity → allowed stations → active station, and give routes a request-scoped, RLS-enforcing client.

**Files:** new `lib/auth.ts`; edit `lib/supabase.ts`; edit `app/dashboard/layout.tsx`; new station-switcher UI; possibly new `middleware.ts`.

**Changes:**
1. In `lib/supabase.ts`, add `createServerClient(accessToken: string)` that builds a client with the **anon key** plus the user's `Authorization: Bearer <token>` so RLS applies. 🔒 HARD — do not change the existing `supabaseAdmin` or `createBrowserClient` signatures; only add.
2. In `lib/auth.ts`, add `getStationContext(request)` that: reads the Supabase session/JWT from the request, looks up the user's `station_users` rows (+ super_admin), determines the **active station** (from a header, cookie, or path param — 🔧 FLEXIBLE, pick one and document; recommended: a `x-station-slug` header or a `station` cookie set by the switcher), and returns `{ userId, role, stationId, stationSlug, allowedStationIds, supabase }`. Return a clear 401/403 shape when the user lacks access to the requested station.
3. Dashboard: add a **station switcher** (only shown if the user has >1 station or is super_admin). Persist the active station (cookie). On switch, refetch dashboard data. 🔧 FLEXIBLE — minimal dropdown in the existing sidebar/header is fine; do not build a settings page for it.
4. Reconcile the auth state in `app/dashboard/layout.tsx` with reality (see §3 note about the possible "bypass"). If a bypass `return` exists, the user wants real auth — but 🔒 **HARD: do not remove or change auth behavior beyond what's needed for station-gating without asking**, since changing login flow is outward-facing.

**Verification:**
- `npm run build` passes.
- Manually (or via a script) confirm `getStationContext` returns the KPFK station for a KPFK user and 403 for a station the user doesn't belong to.

**Commit:** `Add station context resolution + request-scoped RLS client + station switcher`.

---

### Phase E — Thread `station_id` through all API routes

**Goal:** Every route resolves station context, uses the request-scoped client, and filters every query by `station_id`.

**Files:** all route files under `app/api/` (checklist below).

🔒 **HARD — Apply to EVERY route in this list, not just the first few.** The model must not generalize from one route and skip the rest. Work through the list explicitly and check each off in your progress notes:

- [ ] `qir/route.ts` (GET/POST/PATCH/DELETE) — filter drafts by station; finalize/unfinalize scoped to station.
- [ ] `qir/export/route.ts`
- [ ] `qir/shows/route.ts`
- [ ] `episodes/route.ts` (GET list/CSV, POST bulk actions)
- [ ] `episodes/[id]/route.ts`
- [ ] `episodes/[id]/translate/route.ts`
- [ ] `episodes/counts/route.ts`
- [ ] `jobs/route.ts` — job triggers must enqueue with the active `stationId` (see Phase F).
- [ ] `settings/route.ts` — reads/writes per-station settings (Phase G) + show_keys scoped to station.
- [ ] `compliance/route.ts` (the `episode_log!inner` join must be station-filtered)
- [ ] `compliance/report/route.ts`
- [ ] `compliance/wordlist/route.ts`
- [ ] `corrections/route.ts`
- [ ] `dashboard/route.ts` — every one of its ~20 parallel queries gets the station filter.
- [ ] `downloads/route.ts`
- [ ] `events/route.ts`
- [ ] `feeds/route.ts` & `feeds/[showKey]/route.ts` — scope to station; branding from station name.
- [ ] `usage/route.ts`
- [ ] `shows/audit/route.ts` & `shows/audit/process/route.ts`
- [ ] `health/route.ts` — likely no change (liveness only); confirm and leave alone if so.

**Pattern for each route handler:** call `getStationContext(request)` first → on failure return 401/403 → use the returned request-scoped `supabase` client → add `.eq('station_id', stationId)` to every table query that has the column (and join-based filters for `transcripts`/`compliance_flags`).

🔒 **HARD — Do not change a route's response shape, status codes, query params, or business logic beyond adding station scoping.** Dashboard pages depend on these contracts.

**Verification:**
- `npm run build` passes.
- Spot-check 3–4 representative routes (`episodes`, `dashboard`, `qir`, `compliance`) by calling them as a KPFK user and confirming KPFK data returns; calling as a foreign-station user returns none.
- Show output.

**Commit:** `Scope all API routes to active station (RLS + explicit filter)`. (🔧 FLEXIBLE: split into 2 commits — read routes, then action routes — if large.)

---

### Phase F — Workers: per-station processing

**Goal:** Background jobs carry and filter by `station_id`; per-station RSS/regex config comes from the `stations` row.

**Files:** `workers/index.ts`, `workers/ingest.ts`, `workers/transcribe.ts`, `workers/summarize.ts`, `workers/compliance.ts`, `workers/generate-qir.ts`, `workers/auto-retry.ts`, `lib/queue.ts`, `lib/parse-mp3-url.ts`.

**Changes:**
1. 🔒 **HARD — Add `stationId` to every job's data payload** and filter every worker DB query by it — including **both** the candidate-select and the atomic `.update().eq('status', …)` claim guard (see `transcribe.ts:~170-208`, `summarize.ts:~58-79`). A claim that isn't station-filtered can let one station's worker grab another's episodes.
2. `workers/index.ts` cron: instead of one `ingest`/`auto-retry` job, **loop over active stations** and enqueue one job per station (keep the same single queue per stage; put `stationId` in job data — do **not** create per-station queues). Preserve the existing cron patterns and chaining behavior.
3. `ingest.ts`: build the RSS URL from `station.rss_base_url` instead of the hardcoded `archive.kpfk.org`. Insert new `episode_log` rows with the job's `station_id`.
4. `parse-mp3-url.ts`: parameterize the `kpfk_` prefix with the station's `mp3_filename_prefix`. 🔧 FLEXIBLE — keep `kpfk` as a default if no prefix is configured, to stay backward-compatible.
5. `compliance.ts`: build the station-ID detection regex from `station.station_id_patterns`; use the station name in the flag message instead of the hardcoded "KPFK"/"90.7".
6. `generate-qir.ts`: already takes `{year, quarter}` — add `stationId`; scope curation queries to it; write the draft with that `station_id`.

**Verification:**
- `npm run build` passes.
- Run the workers locally (`npm run workers`) against a dev DB with KPFK + a test station; confirm an ingest job for KPFK only touches KPFK shows, and the claim guard never crosses stations. Show logs.

**Commit:** `Thread station_id through all workers; per-station RSS and compliance config`.

---

### Phase G — Per-station settings & prompt parameterization

**Goal:** Settings resolve per-station (with global fallback); AI prompts use the station name instead of "KPFK".

**Files:** `lib/settings.ts`, `lib/qir-format.ts`, `app/api/settings/route.ts`.

**Changes:**
1. `lib/settings.ts`: change `getSetting(key)` → `getSetting(key, stationId)`. Resolution order: `station_settings(station_id, key)` → fall back to global `qir_settings(key)` → fall back to hardcoded default. 🔒 HARD — keep the existing 60s cache behavior but key the cache by `(stationId, key)` so stations don't read each other's values.
2. Parameterize `DEFAULT_SUMMARIZATION_PROMPT`, the curation prompt, and the compliance prompt to interpolate the station's `name` (e.g. replace literal "KPFK" with a `{{STATION_NAME}}` placeholder filled at call time). 🔧 FLEXIBLE — placeholder syntax is your call; keep it simple.
3. `lib/qir-format.ts:~64`: build the report header from the station name, not the literal `"KPFK, Los Angeles"`.
4. `settings/route.ts`: read/write `station_settings` for the active station; show the effective (merged) value in the dashboard.
5. 🔒 HARD — update **every caller** of `getSetting` to pass the correct `stationId` (search the codebase for `getSetting(` and the helper getters like `getExcludedCategories`, `getTranscribeBatchSize`, etc. — these getters also need a `stationId` param). Don't leave a caller passing nothing.

**Verification:**
- `npm run build` passes (a missed caller will surface as a type error — good).
- Confirm a per-station override of e.g. `max_entries_per_category` is read for that station and the global default for another. Show output.

**Commit:** `Per-station settings resolution + station-name prompt parameterization`.

---

### Phase H — Public pages, routing, and branding

**Goal:** Public reports live under `/[station]/...`; legacy KPFK links redirect; UI branding reflects the station.

**Files:** new `app/[station]/[year]/q[quarter]/page.tsx`; keep/redirect `app/[year]/q[quarter]/page.tsx`; `app/compliance-report/page.tsx`; `app/dashboard/layout.tsx`; `app/login/page.tsx`; `app/layout.tsx`.

**Changes:**
1. Create `app/[station]/[year]/q[quarter]/page.tsx`: resolve station by `slug`; query `qir_drafts` filtered by `station_id` + `year` + `quarter` + `status='final'`; render station name dynamically in `<h1>` and `generateMetadata`. 404 if the slug is unknown.
2. 🔒 **HARD — Preserve legacy URLs.** Make `app/[year]/q[quarter]/page.tsx` **301-redirect** to `/kpfk/[year]/q[quarter]` (KPFK is the legacy implicit station). Do not delete the route outright — filed FCC reports link to it.
3. `compliance-report/page.tsx`: scope to a station and use its name.
4. Dashboard/login/root-layout branding: replace hardcoded "KPFK 90.7 FM" / "QIR / KPFK" with the active station's name (dashboard) or a neutral product name (login/root, where no station context exists yet). 🔧 FLEXIBLE — for the pre-login screens, a generic "QIR" is fine; don't over-engineer a theming system.
5. `feeds` routes: branding from station name; base URL from env (leave the `qir.kpfk.org` env fallback, or make it neutral — 🔧 FLEXIBLE).

**Verification:**
- `npm run build` passes.
- `/kpfk/2025/q1` renders the existing KPFK final report; `/2025/q1` 301-redirects to it; an unknown slug 404s. Show evidence (curl/redirect check or a screenshot via the run skill).

**Commit:** `Path-based public reports under /[station]; redirect legacy URLs; dynamic branding`.

---

### Phase I — Documentation & final review

**Goal:** Reflect the new model in docs and do an adversarial self-review against this plan.

**Changes:**
1. Update `CLAUDE.md` and `IMPROVEMENTS.md` to describe the multi-station model (tenant tables, RLS, station context, provisioning a station via SQL). 🔧 FLEXIBLE — concise; don't bloat `CLAUDE.md`.
2. Add a short "Provisioning a new station" runbook (insert `stations` row, add `station_users`, set `station_settings` overrides, point `rss_base_url`).
3. 🔒 **HARD — Run an adversarial review in a fresh subagent**: "Review the full diff against PLAN.md. Verify every phase's requirements are implemented, every API route in the Phase E checklist is station-filtered, every worker query (including claim guards) is station-scoped, RLS isolation actually holds, and nothing outside this plan's scope was changed. Report only correctness/requirement gaps and out-of-scope changes — not style." Fix real gaps it finds; do not chase style nits into over-engineering.

**Verification:** `npm run build` passes; review report shows no outstanding correctness gaps.

**Commit:** `Document multi-station model; final review fixes`.

---

## 5. Definition of done (🔒 HARD — all must be true)

1. `npm run build` passes with no type errors.
2. RLS demonstrably isolates two stations (proven with real queries in Phase C, still true at the end).
3. All API routes in the Phase E checklist filter by station — confirmed by the Phase I review.
4. All workers (candidate selects **and** claim guards) filter by `station_id`.
5. KPFK's existing data is fully intact and its public reports resolve (legacy URL redirects work).
6. No hardcoded "KPFK"/"archive.kpfk.org"/"kpfk_" remains except as documented defaults; re-grep `-i kpfk` and justify any remaining hit.
7. No out-of-scope changes; no weakened/removed checks; no edited prior migrations.

---

## 6. When to STOP and ask the user (🔒 HARD)

- A hard rule blocks you.
- A required change is out of scope per §2.
- A migration would risk existing KPFK data in a way backfill can't cover.
- RLS isolation can't be made to hold without changing the agreed architecture.
- You've corrected the same problem twice and it keeps recurring (say so; propose options).
- Anything requires an outward-facing or hard-to-reverse action (force-push, DNS, deleting data, changing the login flow) beyond what a phase explicitly authorizes.

Default to **providing information and asking** over taking an irreversible action.
