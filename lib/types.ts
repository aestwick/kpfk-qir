export type StationRole = 'viewer' | 'editor' | 'admin'

export interface Station {
  id: string
  slug: string
  name: string
  timezone: string | null
  rss_base_url: string | null
  mp3_filename_prefix: string | null
  station_id_patterns: string[] | null
  created_at: string
}

export interface StationUser {
  id: number
  station_id: string
  user_id: string
  role: StationRole
  created_at: string
}

// A station member as returned by /api/members — the station_users row joined
// with the user's email and a flag marking the current caller's own row.
export interface StationMember {
  user_id: string
  email: string | null
  role: StationRole
  created_at: string
  is_self: boolean
}

export interface StationSetting {
  id: number
  station_id: string
  key: string
  value: unknown
  updated_at: string
}

export interface EpisodeLog {
  id: number
  station_id: string
  show_key: string
  show_name: string | null
  category: string | null
  date: string | null
  start_time: string | null
  end_time: string | null
  duration: number | null
  title: string | null
  mp3_url: string
  status: 'pending' | 'transcribing' | 'transcribed' | 'summarizing' | 'summarized' | 'compliance_checked' | 'failed' | 'unavailable' | 'dead' | 'transcript_missing'
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
  station_id: string
  key: string
  show_name: string
  category: string | null
  default_category: string | null
  primary_language: string | null
  active: boolean
  email: string | null
  created_at: string
  updated_at: string | null
}

export interface ShowKeyWithCount extends ShowKey {
  episode_count: number
}

export interface Transcript {
  id: number
  episode_id: number
  transcript: string | null
  vtt: string | null
  language: string | null
  english_transcript: string | null
  english_vtt: string | null
  created_at: string
}

export interface UsageLog {
  id: number
  station_id: string
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
  station_id: string
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
  flag_type: 'profanity' | 'station_id_missing' | 'technical' | 'payola_plugola' | 'sponsor_id' | 'indecency'
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
  station_id: string
  word: string
  severity: 'warning' | 'critical'
  active: boolean
  created_at: string
}

export interface TranscriptCorrection {
  id: number
  station_id: string
  wrong: string
  correct: string
  case_sensitive: boolean
  is_regex: boolean
  active: boolean
  notes: string | null
  episode_id: number | null
  created_at: string
}

export interface ComplianceFlagWithEpisode extends ComplianceFlag {
  episode_log: {
    show_name: string | null
    show_key: string
    air_date: string | null
    headline: string | null
  }
}

export interface QualityFlag {
  id: number
  show_name: string | null
  headline: string | null
  air_date: string | null
  reason: string
}

// --- Compliance Grid Report (see ideas/COMPLIANCE_GRID_REPORT_SPEC.md) --------

// One concrete airing reduced to what the grid needs: when it aired and how
// many offenses it carried (unresolved flags + 0/1 summary discrepancy).
export interface GridAiring {
  show_key: string
  show_name: string | null
  air_date: string // YYYY-MM-DD (Pacific)
  air_start: string | null // HH:MM:SS (Pacific), null when unknown
  offenses: number
}

// 7 days (Sun..Sat) × N time rows of offense counts.
export type Heatmap = number[][]

// A column of the show × period matrix (a week or a calendar month).
export interface GridColumn {
  key: string
  label: string
  start: string // YYYY-MM-DD inclusive
  end: string // YYYY-MM-DD inclusive
  weeks: number // for the avg/week metric within the column
}

export interface MatrixRow {
  show_key: string
  show_name: string
  total: number
  cells: number[] // aligned to the columns array
}

// One window's worth of grid data returned by /api/compliance/grid.
export interface GridWindow {
  start: string
  end: string
  rangeDays: number
  weeks: number
  heatmap: Heatmap // 7×48 half-hour resolution; client collapses to hourly
  columns: GridColumn[]
  matrix: MatrixRow[]
  totalOffenses: number
  airingsCounted: number
  unplacedOffenses: number // offenses on airings with no air_start
}

export interface GridResponse {
  meta: {
    includeResolved: boolean
    includeDiscrepancies: boolean
    flagTypes: string[]
    severities: string[]
  }
  // Single-window response carries `window`; comparison carries `a` and `b`.
  window?: GridWindow
  a?: GridWindow
  b?: GridWindow
}

