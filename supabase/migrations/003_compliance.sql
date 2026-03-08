-- Compliance flagging tables for FCC compliance checking

create table if not exists public.compliance_flags (
  id serial primary key,
  episode_id integer not null references episode_log(id) on delete cascade,
  flag_type text not null,           -- profanity | station_id_missing | technical | payola_plugola | sponsor_id
  severity text default 'warning',   -- info | warning | critical
  excerpt text,                      -- relevant text from transcript
  timestamp_seconds integer,         -- where in episode (from VTT)
  details text,                      -- explanation
  resolved boolean default false,
  resolved_by text,                  -- who reviewed it
  resolved_notes text,               -- "Reviewed - legitimate book discussion, not plugola"
  created_at timestamptz default now()
);

create index if not exists idx_compliance_episode on compliance_flags(episode_id);
create index if not exists idx_compliance_unresolved on compliance_flags(resolved) where resolved = false;
create index if not exists idx_compliance_type on compliance_flags(flag_type);

create table if not exists public.compliance_wordlist (
  id serial primary key,
  word text not null,
  severity text default 'critical',  -- warning (mild) | critical (FCC-actionable)
  active boolean default true,
  created_at timestamptz default now()
);

-- Add compliance_checked to the status flow
-- Episodes go: pending -> transcribed -> summarized -> compliance_checked
-- compliance_checked means fully processed including compliance scan

-- Default compliance settings
insert into qir_settings (key, value) values
  ('compliance_prompt', '"You are an FCC compliance reviewer for KPFK, a noncommercial community radio station.\n\nReview the following transcript for potential compliance issues. Look for:\n\n1. PAYOLA/PLUGOLA: Undisclosed commercial promotion. Flag if a host promotes a product, service, or business without disclosure. Do NOT flag: pledge drive fundraising, promoting KPFK station events, journalistic discussion of books/films/music, or interviews where guests mention their own work in context.\n\n2. SPONSOR IDENTIFICATION: Segments that sound like sponsored or paid content without proper FCC disclosure (e.g. \"This program is brought to you by...\" or \"Sponsored by...\").\n\nReturn ONLY valid JSON. If no issues found, return empty flags array.\n{\n  \"flags\": [\n    {\n      \"type\": \"payola_plugola\" | \"sponsor_id\",\n      \"excerpt\": \"relevant quote from transcript (under 200 chars)\",\n      \"details\": \"brief explanation of the concern\",\n      \"severity\": \"warning\"\n    }\n  ]\n}"'),
  ('compliance_checks_enabled', '{"profanity": true, "station_id_missing": true, "technical": true, "payola_plugola": true, "sponsor_id": true}'),
  ('compliance_blocking', 'false')
on conflict (key) do nothing;
