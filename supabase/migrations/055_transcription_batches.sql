-- 055: Groq Batch API for transcription backlogs (half price, up to 24h turnaround).
--
-- Backlogs only: when a station has a pile of pending episodes (default 20+),
-- the ones that have already waited a while (default 6h+) go to Groq's batch
-- endpoint instead of the synchronous path. Fresh episodes keep the fast path,
-- so the public episode feed and flag review stay same-day. Historical
-- (windowed) backfills always prefer batch. See lib/transcription/batch-policy.ts.
--
-- Episode flow:  pending → batch_queued → transcribed           (success)
--                pending → batch_queued → pending (sync only)   (item error / batch expired)
-- episode_log.status has no CHECK constraint, so 'batch_queued' needs no DDL there.
-- Idempotent: safe to re-run.

-- One row per Groq batch job.
create table if not exists public.transcription_batches (
  id               bigserial primary key,
  station_id       uuid not null references public.stations(id) on delete cascade,
  provider         text not null default 'groq',
  provider_batch_id text unique,               -- Groq's batch id (null until created)
  input_file_id    text,
  output_file_id   text,
  error_file_id    text,
  model            text not null,
  status           text not null default 'submitting'
                   check (status in ('submitting', 'submitted', 'collected', 'failed')),
  provider_status  text,                       -- Groq's own status string, last seen
  episode_ids      integer[] not null,
  job_window       jsonb,                      -- {start,end} for a windowed backfill; null = live
  prompts          jsonb,                      -- {"<episode id>": "<vocabulary hint>"} sent, for the echo guard
  prompt_station_terms text[],
  transcribed      integer not null default 0,
  returned_to_sync integer not null default 0,
  error            text,
  submitted_at     timestamptz not null default now(),
  collected_at     timestamptz,
  updated_at       timestamptz not null default now()
);

create index if not exists transcription_batches_open
  on public.transcription_batches (status) where status in ('submitting', 'submitted');
create index if not exists transcription_batches_station
  on public.transcription_batches (station_id, submitted_at desc);

-- Set when an episode is sent to batch. Non-null = never batch it again: an
-- episode that comes back from batch (item error, expiry) goes the sync route,
-- so a bad file can't loop through 24h batches forever.
alter table public.episode_log add column if not exists batch_attempted_at timestamptz;

-- RLS: members read their station's batches (dashboard); only the service role
-- (workers) writes — no write policy.
alter table public.transcription_batches enable row level security;
drop policy if exists transcription_batches_read on public.transcription_batches;
create policy transcription_batches_read on public.transcription_batches
  for select using (station_id in (select public.user_station_ids()));

-- Audit like every tenant table (migration 028's trigger function).
drop trigger if exists trg_audit on public.transcription_batches;
create trigger trg_audit after insert or update or delete on public.transcription_batches
  for each row execute function public.audit_row_change();
