-- Replace the binary `resolved` flag on compliance_flags with a triage
-- workflow so reviewers can filter the AI's noisy output:
--
--   suggested (new) -> investigating -> violation | dismissed
--
-- Only `investigating` + `violation` count as active compliance offenses;
-- raw `suggested` AI noise and `dismissed` false-positives drop out of the
-- dashboard badges, offense grid, per-show health, and public report.

alter table public.compliance_flags
  add column if not exists review_status text not null default 'suggested'
    check (review_status in ('suggested', 'investigating', 'violation', 'dismissed'));

-- Backfill from the old boolean. A previously-resolved flag was reviewed and
-- closed, so it maps to 'dismissed' (we can't know in hindsight whether it was
-- a real violation, and we don't want to retroactively assert one). Open flags
-- become 'suggested', i.e. awaiting triage.
update public.compliance_flags
  set review_status = case when resolved then 'dismissed' else 'suggested' end;

-- Drop the old open-flag partial indexes (004 + 006) and the boolean column.
drop index if exists idx_compliance_unresolved;
drop index if exists idx_compliance_flags_resolved;
alter table public.compliance_flags drop column if exists resolved;

-- Index the active-offense lookup used by stats, grid, health, and reports.
create index if not exists idx_compliance_active
  on public.compliance_flags (review_status)
  where review_status in ('investigating', 'violation');

-- `resolved_by` / `resolved_notes` are kept as the generic reviewer audit
-- trail (who last set the status, and why).
