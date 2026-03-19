import { supabaseAdmin } from './supabase'

const settingsCache = new Map<string, { value: unknown; fetchedAt: number }>()
const CACHE_TTL_MS = 60_000 // 1 minute

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const cached = settingsCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value as T
  }

  const { data } = await supabaseAdmin
    .from('qir_settings')
    .select('value')
    .eq('key', key)
    .single()

  if (data) {
    let parsed: unknown = data.value
    if (typeof data.value === 'string') {
      try {
        parsed = JSON.parse(data.value)
      } catch {
        // keep as string if not valid JSON
      }
    }
    settingsCache.set(key, { value: parsed, fetchedAt: Date.now() })
    return parsed as T
  }

  return null
}

export async function getExcludedCategories(): Promise<string[]> {
  return (await getSetting<string[]>('excluded_categories')) ?? ['Music', 'Español']
}

export async function getTranscribeBatchSize(): Promise<number> {
  return (await getSetting<number>('transcribe_batch_size')) ?? 5
}

export async function getSummarizeBatchSize(): Promise<number> {
  return (await getSetting<number>('summarize_batch_size')) ?? 10
}

export async function getComplianceChecksEnabled(): Promise<Record<string, boolean>> {
  return (await getSetting<Record<string, boolean>>('compliance_checks_enabled')) ?? {
    profanity: true,
    station_id_missing: true,
    technical: true,
    payola_plugola: true,
    sponsor_id: true,
    indecency: true,
  }
}

export async function getCompliancePrompt(): Promise<string> {
  return (await getSetting<string>('compliance_prompt')) ?? ''
}

export async function isComplianceBlocking(): Promise<boolean> {
  return (await getSetting<boolean>('compliance_blocking')) ?? false
}

export async function isPipelinePaused(): Promise<boolean> {
  return (await getSetting<boolean>('pipeline_paused')) ?? false
}

export async function getIssueCategories(): Promise<string[]> {
  return (await getSetting<string[]>('issue_categories')) ?? [
    'Civil Rights / Social Justice',
    'Immigration',
    'Economy / Labor',
    'Environment / Climate',
    'Government / Politics',
    'Health',
    'International Affairs / War & Peace',
    'Arts & Culture',
  ]
}
