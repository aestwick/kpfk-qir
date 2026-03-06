-- Usage tracking for API costs
create table if not exists public.usage_log (
  id serial primary key,
  episode_id integer references episode_log(id) on delete set null,
  service text not null,            -- 'groq' | 'openai'
  model text not null,              -- 'whisper-large-v3' | 'gpt-4o-mini'
  operation text not null,          -- 'transcribe' | 'summarize' | 'curate'
  input_tokens integer default 0,
  output_tokens integer default 0,
  duration_seconds numeric,         -- for audio transcription
  estimated_cost numeric(10, 6),
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

-- Key-value config for report generation
create table if not exists public.qir_settings (
  id serial primary key,
  key text unique not null,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- Default settings
insert into public.qir_settings (key, value) values
  ('station_id', '"KPFK, Los Angeles"'),
  ('max_entries_per_category', '12'),
  ('issue_categories', '["Civil Rights / Social Justice", "Immigration", "Economy / Labor", "Environment / Climate", "Government / Politics", "Health", "International Affairs / War & Peace", "Arts & Culture"]'),
  ('excluded_categories', '["Music", "Español"]'),
  ('summarization_model', '"gpt-4o-mini"'),
  ('transcription_model', '"whisper-large-v3"'),
  ('transcribe_batch_size', '5'),
  ('summarize_batch_size', '10')
on conflict (key) do nothing;

-- QIR draft storage
create table if not exists public.qir_drafts (
  id serial primary key,
  year integer not null,
  quarter integer not null,
  status text default 'draft',
  curated_entries jsonb not null,
  settings_snapshot jsonb,
  full_text text,
  curated_text text,
  version integer default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists idx_qir_draft_active
  on public.qir_drafts(year, quarter) where status = 'final';

-- Transcript corrections dictionary
create table if not exists public.transcript_corrections (
  id serial primary key,
  wrong text not null,
  correct text not null,
  case_sensitive boolean default false,
  is_regex boolean default false,
  active boolean default true,
  notes text,
  created_at timestamptz default now()
);

-- Add error tracking columns to episode_log
alter table public.episode_log
  add column if not exists error_message text,
  add column if not exists retry_count integer default 0;
