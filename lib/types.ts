export interface EpisodeLog {
  id: number
  show_key: string
  show_name: string | null
  category: string | null
  date: string | null
  start_time: string | null
  end_time: string | null
  duration: number | null
  mp3_url: string
  status: 'pending' | 'transcribed' | 'summarized' | 'compliance_checked' | 'failed' | 'unavailable' | 'dead'
  headline: string | null
  host: string | null
  guest: string | null
  summary: string | null
  transcript_url: string | null
  compliance_status: string | null
  compliance_report: string | null
  air_date: string | null
  air_start: string | null
  air_end: string | null
  issue_category: string | null
  error_message: string | null
  retry_count: number
  created_at: string
  updated_at: string
}

export interface ShowKey {
  id: number
  key: string
  show_name: string
  category: string | null
  active: boolean
  email: string | null
  created_at: string
  updated_at: string | null
}

export interface Transcript {
  id: number
  episode_id: number
  transcript: string | null
  vtt: string | null
  created_at: string
}

export interface UsageLog {
  id: number
  episode_id: number | null
  service: 'groq' | 'openai'
  model: string
  operation: 'transcribe' | 'summarize' | 'curate' | 'compliance'
  input_tokens: number
  output_tokens: number
  duration_seconds: number | null
  estimated_cost: number | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface QirSetting {
  id: number
  key: string
  value: unknown
  updated_at: string
}

export interface QirDraft {
  id: number
  year: number
  quarter: number
  status: 'draft' | 'final'
  curated_entries: unknown
  settings_snapshot: unknown
  full_text: string | null
  curated_text: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface ComplianceFlag {
  id: number
  episode_id: number
  flag_type: 'profanity' | 'station_id_missing' | 'technical' | 'payola_plugola' | 'sponsor_id'
  severity: 'info' | 'warning' | 'critical'
  excerpt: string | null
  timestamp_seconds: number | null
  details: string | null
  resolved: boolean
  resolved_by: string | null
  resolved_notes: string | null
  created_at: string
}

export interface ComplianceWord {
  id: number
  word: string
  severity: 'warning' | 'critical'
  active: boolean
  created_at: string
}

export interface TranscriptCorrection {
  id: number
  wrong: string
  correct: string
  case_sensitive: boolean
  is_regex: boolean
  active: boolean
  notes: string | null
  created_at: string
}

