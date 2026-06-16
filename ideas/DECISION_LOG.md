# Decision Log

A reconstructed, append-mostly record of the **deliberate** design and product
decisions made on QIR.KPFK.ORG, mined from git history (commits `bae830f` …
`3eacabe`, 2026-03-08 → 2026-06-09). It captures the *why* behind choices that
the mechanical `audit_log` (migration 028) records only as *what changed*.

Scope of this document is **both**:

- **§A — Project decisions:** the architectural/product calls across the whole
  codebase, grouped by theme. Reference material; explains how we got here.
- **§B — Show & tag governance subset:** the lineage that will feed the
  donor-facing tag export. These entries are written to map 1:1 onto the future
  `decision_log` table (`subject_type`, `subject_id`, `decision`, `rationale`,
  `decided_at`, commit refs) so they can be seeded once the table lands.

Each entry: **what was decided**, **why**, **when**, and the **commit refs** that
are the primary evidence. Rationale is grounded in the commit message and
`CLAUDE.md`; where a commit only implies the reason it is marked *(inferred)*.

> Conventions: dates are commit author dates (YYYY-MM-DD). A decision that was
> later reversed or superseded carries a **Superseded by** pointer rather than
> being deleted — the log is append-mostly, like the audit trail it complements.

---

## §A — Project Decisions

### A1. Pipeline & processing control

- **A1.1 — Derive air date/time from the MP3 filename, not the RSS `pubDate`.**
  *Why:* the archive's `pubDate` proved unreliable; the MP3 URL encodes the true
  broadcast slot deterministically, making it ground truth that never needs to go
  through the summarizer. *When:* 2026-03-09. *Commits:* `e33a853`, `aa6f5ef`
  (`fix-dates` re-derive action), `8c620e6`, `c9061c5` (moved to Settings with a
  date-range picker), `09…` backfill (migration 009). Reinforced by **A1.2**.

- **A1.2 — Keep air date *out* of the summarization prompt (final position).**
  *Why:* first we *added* air date to the prompt to kill false-positive
  "discrepancy" flags (`db88006`, 2026-03-09); once dates were authoritative from
  the filename (A1.1) we **dropped it again** so the summarizer isn't re-deriving
  ground-truth metadata. *When:* 2026-05-30. *Commit:* `4d2b0b4`. *Supersedes:*
  `db88006`.

- **A1.3 — Atomic per-stage episode claim (status-guarded UPDATE).**
  *Why:* overlapping worker runs were double-processing episodes; claiming with a
  `.eq('status', <prev>)` guard makes the claim a compare-and-swap so only one run
  wins. *When:* 2026-05-29. *Commit:* `a03d5e0`. Related fix: per-job temp-dir to
  stop ffmpeg ENOENT collisions (`dc314c5`).

- **A1.4 — Auto-chaining between stages: removed, then restored.**
  *Why:* manual-only control was introduced to stop a summarize infinite-loop /
  batch stall (`71a39ca`, 2026-03-10). Once the stall bugs and timeouts were
  fixed, auto-chaining was restored as the default with a redesigned Jobs board
  (`2989ba4`, 2026-05-30) because hourly hands-off operation is the product goal.
  *Net position:* ingest→transcribe→summarize auto-chains; QIR stays manual.
  *Supersedes:* `71a39ca`.

- **A1.5 — Job timeouts to prevent zombie jobs.** *Why:* a hung job blocked the
  shared pool indefinitely. *When:* 2026-03-19. *Commits:* `7d88276`, `a35ac03`
  (removed an invalid queue-level timeout — timeout belongs on the worker).

- **A1.6 — Global pipeline pause/resume.** *Why:* operators need a kill-switch
  during incidents/cost spikes. *When:* 2026-03-10. *Commit:* `867b388`. The
  pause flag is read **uncached** (`fa352d3`, `24c0427`) because a control signal
  must take effect immediately, not after the 60s settings TTL.

- **A1.7 — Concurrency model "Layer A": fixed concurrency + KPFK priority +
  per-(station,stage) chain lock.** *Why:* a shared worker pool can't be paused
  per-station, so fairness/priority is enforced one level up via tiering and chain
  locks. *When:* 2026-06-02. *Commits:* `4aa16a4`, `b5bba3e`, `ff04341`,
  `4092e4b` (Master Control glance/cockpit). Spec: `d7f9110`, `2cbfa53`.

### A2. Multi-station (multi-tenancy)

- **A2.1 — One codebase / one DB / one deployment, isolated by `station_id` +
  RLS (defense in depth).** *Why:* serve all Pacifica stations without per-station
  forks; RLS is the hard backstop and app code *also* filters by `station_id`.
  *When:* 2026-05-29. *Commits:* `9c3acc1` (012 tables), `04e245a` (013 columns),
  `a010729` (014 RLS), `a43bb63` (015 seed peers). Plan: `cda0ff4`…`b0dac58`.

- **A2.2 — `qir_settings` stays global; `station_settings` is the override
  layer.** *Why:* most config is shared; per-station overrides are the exception,
  resolved `station_settings → qir_settings → hard-coded default`. *When:*
  2026-05-29. *Commit:* `3194d47`, `e0fc482`-era settings work.

- **A2.3 — Server never defaults an active station; the client switcher picks
  it.** *Why:* a wrong server-side default would leak cross-tenant data; the
  active station comes from the `qir_station` cookie / `x-station-slug` header.
  *When:* 2026-05-29. *Commit:* `a1d218d`, scoping `435bdbd`/`7fd2790`.

- **A2.4 — Path-based public reports `/[station]/[year]/q[quarter]`; legacy
  `/[year]/...` 308-redirects to `/kpfk/...`.** *Why:* multi-tenant public URLs
  while keeping already-filed FCC links resolving. *When:* 2026-05-29. *Commit:*
  `85ac7cb`.

- **A2.5 — Workers run service-role (RLS bypassed); the `station_id` filter is
  the only guard, threaded through every job.** *Why:* workers have no JWT; a
  cron *dispatcher* fans out one job per station. *When:* 2026-05-29. *Commits:*
  `a7289a2`, `c0b1c6e` (close cross-station bleeds).

### A3. Compliance

- **A3.1 — Triage workflow replaces a binary "resolved" flag.** *Why:* a single
  boolean couldn't express dismissed-vs-pending-vs-resolved; reviewers need a real
  state machine, and re-surfaced flags must preserve prior triage. *When:*
  2026-05-31. *Commits:* `aa328ef`, `81834b1` (preserve triage on re-surface),
  migration 025. UX: `3da1d1b`, `b69beac`.

- **A3.2 — Compliance config is centralized (master-level), blocking is a real
  QIR gate.** *Why:* FCC rules are federal/uniform, so `compliance_prompt` and the
  `compliance_blocking` gate are global-only; an unresolved **critical** flag
  holds an episode out of the QIR draft (warnings never block). *When:*
  2026-06-03. *Commits:* `9086888`, `f8605e7` (two follow-up bug fixes).

- **A3.3 — Two-layer compliance wordlist (global base + per-station additions).**
  *Why:* every station shares an FCC base list but may add local terms; the worker
  flags on the union, super-admins own the base. *When:* 2026-06-04. *Commits:*
  `44a166e`, migrations 030/032.

- **A3.4 — Compliance Grid report (heatmap + show×period matrix).** *Why:*
  operators needed to see offense concentration by day/time and by show. *When:*
  2026-05-30. *Commits:* `3596703`, `0dcdd44` (drill-through). Spec: `90db1ef`,
  `06f8d40`.

### A4. Transcript search

- **A4.1 — Phased search: lexical FTS first, semantic/pgvector hybrid second.**
  *Why:* ship explainable exact-match search immediately (Postgres FTS, migration
  022), then layer semantic recall (embeddings, migration 023) without blocking
  v1. *When:* 2026-05-30. *Commits:* `868694b` (Phase 1), `01ca1e1` (Phase 2).
  Spec: `26605bf`, `bc3d730`, `fa8fd58`.

- **A4.2 — Embed transcripts during the summarize pass (best-effort).** *Why:*
  the transcript is already loaded there; an embedding failure must never fail a
  successfully-summarized episode (search degrades to lexical). *When:*
  2026-05-30. *Commit:* `01ca1e1`. (This is the hook the tag feature will reuse.)

### A5. Audit & observability

- **A5.1 — Hybrid, append-only audit log; permanent retention.** *Why:* DB
  triggers catch every mutation (can't be forgotten, auto-attributed via
  `auth.uid()`), app-layer `logAuditEvent` catches what triggers can't (reads,
  auth, exports). The DB is the complete record (FCC context) so there is **no**
  TTL — the UI shows a trailing 30-day window only. *When:* 2026-06-01. *Commits:*
  `faecaa0`, spec `9522998`/`927f05e`. **This decision log complements it by
  adding the human *why* the trigger can't capture.**

### A6. Cost / spend governance

- **A6.1 — Don't count spend-limit blocks against the 3-strikes retry budget.**
  *Why:* an org-wide billing block isn't an episode's fault; counting it would
  eventually mark the whole backlog dead during a billing outage. *When:*
  2026-05-29. *Commit:* `b3f9843`.

- **A6.2 — Super-admin spend caps with auto-pause; per-station + universal
  ceiling.** *Why:* protect against runaway AI cost; a station cap plus an
  all-stations ceiling. Cost/spend metrics are restricted to super-admins. *When:*
  2026-06-04. *Commits:* `3653076`, `329541f`, `bdfe897`, `ea51115`, `caf632b`.

### A7. Auth & user management

- **A7.1 — Admin-set passwords (no email invite flow); super-admin Users page.**
  *Why:* the deployment has no transactional-email dependency for onboarding;
  admins set passwords directly, with reset + passphrase generator. *When:*
  2026-06-09. *Commits:* `43d26ab`, `902d44d`, `2ac2be4`. *Supersedes* the earlier
  "invite" wording (`61ae246`).

### A8. QIR report & notifications

- **A8.1 — QIR customization: show selection, community-service rating,
  regeneration guidance.** *When:* 2026-03-08. *Commit:* `78d002e`.
- **A8.2 — Defer email; in-browser notifications only for bundle downloads.**
  *Why:* avoid an email-provider dependency for v1; a dashboard ping + tab-title
  badge + permission-gated Web Notification covers it. *When:* 2026-06-02.
  *Commits:* `5891dba`, `366274f`. *Supersedes* the Resend decision (`3e2d3df`,
  `781aa73`) — Resend was locked in, then dropped for v1.

---

## §B — Show & Tag Governance Decision Subset

These are the decisions whose lineage flows into the donor-facing tags. Written
to seed the future `decision_log` table. Suggested mapping:
`subject_type` · `subject_id` · `decision` · `rationale` · `decided_at` · `commits`.

| # | subject_type | subject_id | decision | rationale | decided_at | commits |
|---|---|---|---|---|---|---|
| B1 | show_identity | (all) | **Identity (grouping) is kept strictly separate from display name.** | A logical show spans multiple feeds/keys and carries alternate name spellings across systems; merging on name is unreliable. | 2026-05-31 | `cf8f5a7`, `645c12a` |
| B2 | show_group | `coalesce(show_group,key)` | **Group by the explicit `show_group` column, never the name.** | The reliable merge key must be independent of spelling; null `show_group` ⇒ the feed's own key is its group. | 2026-05-31 | `cf8f5a7`; migration 026 |
| B3 | show_name | resolution order | **Display name resolves `display_name → feed_name → show_name → key`; group name prefers the human `show_group` label.** | Curated override wins; RSS-derived names vary across sibling feeds, so a human group label beats an arbitrary feed title. | 2026-06-01 | `943b1a2`; migration 026/027 |
| B4 | show_name | strip prefixes | **Strip station-configured prefixes (e.g. "KPFK -") + a leading "the" from auto-derived names.** | Auto RSS titles carry station boilerplate that shouldn't show; prefixes are station config, not hard-coded. | 2026-06-01 | `943b1a2`; migration 027 |
| B5 | show_language | `primary_language` | **Soft-default show language to English; store null, apply default at read time.** | Staff only record a language for non-English shows, so null means "English unless specced." | 2026-06-01 | `7a4b6b0`; migration 021. Spec `3be53f6` |
| B6 | show_category | exclusion list | **Exclude shows by the feed's plain `<category>` (e.g. Español/Music), config-driven, per-key.** | The ingest exclusion must match the archive feed's real category shape (not `<itunes:category>`); per-key so one feed of a group can differ. | 2026-06-02 / 06-04 | `ed137a3`, `e0fc482`, `06dffc6`, `563116c` |
| B7 | show_onboarding | discovery-sync | **New shows onboard opt-out: discovery sync inserts them `active = false` for review.** | Every program lands for review; nothing pulls until a human activates it (drop Music/Español/dupes). | 2026-06-03 | `50ff8c6`, `8e874a7` |
| B8 | show_onboarding | archive discover | **One-click "Discover from archive" enumerates the station's full program dropdown; "Look up" resolves bare keys.** | Read-only previews that fail visibly if `rss_base_url` is unset; verified identical markup across KPFK/KPFA/WPFW/KPFT. | 2026-06-01 / 06-02 | `78a234c`, `194da3f`, `850355f`, `f41ff55` |
| B9 | show_keys | uniqueness | **Show keys are unique per-station (`station_id,key`).** | The same key can exist at different stations; uniqueness must be tenant-scoped. | 2026-05-29 | `1f7a08e`; migration 018 |

### Open governance gaps (to close with the tag feature)

- **No rationale field on `show_keys`.** Grouping/category/active edits are
  audited mechanically (migration 028 trigger) but carry no human "why." *Plan:*
  add `show_keys.notes` (mirroring `transcript_corrections.notes`) + a
  `decision_log` table so deliberate calls (e.g. "merged these two feeds because
  same host, alternate airing") are captured at the source.
- **No tag justification yet.** `episode_tags.source ('llm'|'manual')` is the
  start; donor-facing tags should also keep the model's one-line justification
  (LLM) or a curator note (manual) so a public tag has explainable lineage.

---

## How this log is maintained going forward

Once the `decision_log` table ships, **new** governance decisions are entered
there at the time they're made (not reconstructed). This document remains the
historical backfill (§A reference + §B seed). The companion **maintenance log**
(`maintenance_log` table) records *operational* events — tag backfills,
re-extractions after a prompt change, taxonomy prunes, regrouping fixes — with
counts/cost and actor; it answers "what ran," whereas this answers "what we chose
and why." Both sit above the immutable `audit_log`, which answers "what changed."
