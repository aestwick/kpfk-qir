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
    settingsCache.set(key, { value: data.value, fetchedAt: Date.now() })
    return data.value as T
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
