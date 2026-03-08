import { Job } from 'bullmq'
import OpenAI from 'openai'
import { supabaseAdmin } from '../lib/supabase'
import { logComplianceUsage } from '../lib/usage'
import { getComplianceChecksEnabled, getCompliancePrompt, getSummarizeBatchSize } from '../lib/settings'

interface ComplianceFlagInsert {
  episode_id: number
  flag_type: string
  severity: string
  excerpt: string | null
  timestamp_seconds: number | null
  details: string | null
}

interface VttCue {
  startSeconds: number
  endSeconds: number
  text: string
}

function parseVttTimestamp(ts: string): number {
  const parts = ts.split(':')
  if (parts.length === 3) {
    const [h, m, s] = parts
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)
  }
  if (parts.length === 2) {
    const [m, s] = parts
    return parseInt(m) * 60 + parseFloat(s)
  }
  return 0
}

function parseVtt(vtt: string): VttCue[] {
  const cues: VttCue[] = []
  const blocks = vtt.split(/\n\n+/)
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    const timeLine = lines.find((l) => l.includes('-->'))
    if (!timeLine) continue
    const [startStr, endStr] = timeLine.split('-->').map((s) => s.trim())
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(' ').trim()
    if (text) {
      cues.push({
        startSeconds: parseVttTimestamp(startStr),
        endSeconds: parseVttTimestamp(endStr),
        text,
      })
    }
  }
  return cues
}

function getCurrentQuarterBounds(): { start: string; end: string } {
  const now = new Date()
  const year = now.getFullYear()
  const quarter = Math.floor(now.getMonth() / 3)
  const startMonth = quarter * 3
  const start = new Date(year, startMonth, 1).toISOString().split('T')[0]
  const end = new Date(year, startMonth + 3, 0).toISOString().split('T')[0]
  return { start, end }
}

// Check if episode airs during FCC restricted hours (6am-10pm local)
function isDuringRestrictedHours(airStart: string | null): boolean {
  if (!airStart) return true // assume restricted if unknown
  const hour = parseInt(airStart.split(':')[0])
  return hour >= 6 && hour < 22
}

function runProfanityCheck(
  episodeId: number,
  transcript: string,
  wordlist: { word: string; severity: string }[],
  restricted: boolean
): ComplianceFlagInsert[] {
  const flags: ComplianceFlagInsert[] = []
  const lower = transcript.toLowerCase()

  for (const { word, severity: wordSeverity } of wordlist) {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(lower)) !== null) {
      const start = Math.max(0, match.index - 50)
      const end = Math.min(transcript.length, match.index + word.length + 50)
      const excerpt = transcript.slice(start, end)

      flags.push({
        episode_id: episodeId,
        flag_type: 'profanity',
        severity: restricted ? wordSeverity : 'warning',
        excerpt,
        timestamp_seconds: null,
        details: restricted
          ? `"${word}" detected during FCC restricted hours (6am-10pm)`
          : `"${word}" detected during safe harbor hours (10pm-6am)`,
      })
      // Only flag first occurrence of each word
      break
    }
  }

  return flags
}

function runStationIdCheck(
  episodeId: number,
  vttCues: VttCue[],
  duration: number | null
): ComplianceFlagInsert[] {
  if (!vttCues.length || !duration) return []

  // Find hour boundaries within the episode
  const durationSecs = (duration ?? 60) * 60
  const hourMarks: number[] = []
  for (let t = 3600; t < durationSecs; t += 3600) {
    hourMarks.push(t)
  }
  // Also check the start of the episode (top of hour)
  hourMarks.unshift(0)

  const flags: ComplianceFlagInsert[] = []
  const stationPattern = /kpfk|90\.7|ninety point seven/i

  for (const mark of hourMarks) {
    const windowStart = Math.max(0, mark - 300) // 5 min before
    const windowEnd = mark + 300 // 5 min after

    const nearCues = vttCues.filter(
      (c) => c.startSeconds >= windowStart && c.startSeconds <= windowEnd
    )
    const found = nearCues.some((c) => stationPattern.test(c.text))

    if (!found && mark > 0) {
      // Only flag interior hour marks, not the very start
      flags.push({
        episode_id: episodeId,
        flag_type: 'station_id_missing',
        severity: 'warning',
        excerpt: null,
        timestamp_seconds: mark,
        details: `No station ID ("KPFK" or "90.7") detected near ${Math.floor(mark / 3600)}:00:00 mark`,
      })
    }
  }

  return flags
}

function runTechnicalCheck(
  episodeId: number,
  transcript: string,
  duration: number | null
): ComplianceFlagInsert[] {
  const flags: ComplianceFlagInsert[] = []

  // Short transcript for long show
  if (duration && duration >= 30 && transcript.length < 500) {
    flags.push({
      episode_id: episodeId,
      flag_type: 'technical',
      severity: 'info',
      excerpt: null,
      timestamp_seconds: null,
      details: `Very short transcript (${transcript.length} chars) for a ${duration}-min show. Possible dead air or audio issues.`,
    })
  }

  // Repeated text detection (simple: check if any 100-char block appears 3+ times)
  if (transcript.length > 500) {
    const blockSize = 100
    const seen = new Map<string, number>()
    for (let i = 0; i <= transcript.length - blockSize; i += 50) {
      const block = transcript.slice(i, i + blockSize).toLowerCase().trim()
      seen.set(block, (seen.get(block) ?? 0) + 1)
    }
    const repeats = Array.from(seen.entries()).filter(([, count]) => count >= 3)
    if (repeats.length > 0) {
      flags.push({
        episode_id: episodeId,
        flag_type: 'technical',
        severity: 'info',
        excerpt: repeats[0][0].slice(0, 100),
        timestamp_seconds: null,
        details: `Repeated text blocks detected (${repeats.length} patterns repeated 3+ times). Possible audio loop.`,
      })
    }
  }

  // Technical difficulty keywords
  const techPattern = /technical difficult|dead air|off the air|lost (the )?signal/i
  const techMatch = transcript.match(techPattern)
  if (techMatch) {
    const idx = techMatch.index ?? 0
    const excerpt = transcript.slice(Math.max(0, idx - 30), Math.min(transcript.length, idx + 80))
    flags.push({
      episode_id: episodeId,
      flag_type: 'technical',
      severity: 'info',
      excerpt,
      timestamp_seconds: null,
      details: 'Transcript mentions possible technical issues',
    })
  }

  return flags
}

async function runAiComplianceCheck(
  openai: OpenAI,
  episodeId: number,
  transcript: string,
  compliancePrompt: string
): Promise<{ flags: ComplianceFlagInsert[]; inputTokens: number; outputTokens: number }> {
  // Truncate very long transcripts to save tokens
  const maxChars = 15000
  const truncated = transcript.length > maxChars
    ? transcript.slice(0, maxChars) + '\n\n[TRANSCRIPT TRUNCATED]'
    : transcript

  let response: OpenAI.Chat.Completions.ChatCompletion | null = null
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: compliancePrompt },
          { role: 'user', content: truncated },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      })
      break
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const status = (err as { status?: number })?.status
      if (status && [429, 500, 502, 503].includes(status)) {
        const delay = Math.pow(2, attempt + 1) * 1000
        console.warn(`[compliance] ep ${episodeId} OpenAI error ${status}, retrying in ${delay}ms...`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }

  if (!response) throw lastError ?? new Error('OpenAI compliance check failed after retries')

  const content = response.choices[0]?.message?.content
  if (!content) return { flags: [], inputTokens: 0, outputTokens: 0 }

  let parsed: { flags?: Array<{ type: string; excerpt?: string; details?: string; severity?: string }> }
  try {
    parsed = JSON.parse(content)
  } catch {
    console.warn(`[compliance] ep ${episodeId} invalid JSON from OpenAI: ${content.slice(0, 200)}`)
    return { flags: [], inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 }
  }

  const aiFlags: ComplianceFlagInsert[] = (parsed.flags ?? []).map((f) => ({
    episode_id: episodeId,
    flag_type: f.type === 'payola_plugola' || f.type === 'sponsor_id' ? f.type : 'payola_plugola',
    severity: f.severity ?? 'warning',
    excerpt: f.excerpt?.slice(0, 200) ?? null,
    timestamp_seconds: null,
    details: f.details ?? null,
  }))

  return {
    flags: aiFlags,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  }
}

export async function processCompliance(job: Job) {
  console.log('[compliance] starting batch...')

  const checksEnabled = await getComplianceChecksEnabled()
  const compliancePrompt = await getCompliancePrompt()
  const batchSize = await getSummarizeBatchSize()
  const { start, end } = getCurrentQuarterBounds()

  // Get summarized episodes that haven't been compliance checked
  const { data: episodes, error } = await supabaseAdmin
    .from('episode_log')
    .select('*')
    .eq('status', 'summarized')
    .gte('air_date', start)
    .lte('air_date', end)
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)
  if (!episodes?.length) {
    console.log('[compliance] no summarized episodes to check')
    return { checked: 0 }
  }

  // Batch-fetch transcripts + VTT
  const epIds = episodes.map((ep) => ep.id)
  const { data: transcriptsData } = await supabaseAdmin
    .from('transcripts')
    .select('episode_id, transcript, vtt')
    .in('episode_id', epIds)

  const transcriptMap = new Map(
    (transcriptsData ?? []).map((t) => [t.episode_id, { transcript: t.transcript, vtt: t.vtt }])
  )

  // Load profanity wordlist
  const { data: wordlistData } = await supabaseAdmin
    .from('compliance_wordlist')
    .select('word, severity')
    .eq('active', true)

  const wordlist = (wordlistData ?? []).map((w) => ({ word: w.word, severity: w.severity }))

  // Set up OpenAI if AI checks are enabled
  const needsAi = checksEnabled.payola_plugola || checksEnabled.sponsor_id
  let openai: OpenAI | null = null
  if (needsAi) {
    const openaiKey = process.env.OPENAI_API_KEY
    if (!openaiKey) {
      console.warn('[compliance] OPENAI_API_KEY not set, skipping AI checks')
    } else {
      openai = new OpenAI({ apiKey: openaiKey })
    }
  }

  let checked = 0

  for (const episode of episodes) {
    try {
      const data = transcriptMap.get(episode.id)
      if (!data?.transcript) {
        console.warn(`[compliance] no transcript for episode ${episode.id}, skipping`)
        // Still mark as checked - no transcript means nothing to check
        await supabaseAdmin
          .from('episode_log')
          .update({ status: 'compliance_checked' })
          .eq('id', episode.id)
        checked++
        continue
      }

      const allFlags: ComplianceFlagInsert[] = []
      const restricted = isDuringRestrictedHours(episode.air_start)

      // 1. Profanity check
      if (checksEnabled.profanity && wordlist.length > 0) {
        allFlags.push(...runProfanityCheck(episode.id, data.transcript, wordlist, restricted))
      }

      // 2. Station ID check
      if (checksEnabled.station_id_missing && data.vtt) {
        const cues = parseVtt(data.vtt)
        allFlags.push(...runStationIdCheck(episode.id, cues, episode.duration))
      }

      // 3. Technical check
      if (checksEnabled.technical) {
        allFlags.push(...runTechnicalCheck(episode.id, data.transcript, episode.duration))
      }

      // 4. AI checks (payola + sponsor)
      if (openai && needsAi && compliancePrompt) {
        const aiResult = await runAiComplianceCheck(openai, episode.id, data.transcript, compliancePrompt)
        allFlags.push(...aiResult.flags)

        if (aiResult.inputTokens > 0) {
          await logComplianceUsage(episode.id, aiResult.inputTokens, aiResult.outputTokens)
        }
      }

      // Clear old flags for this episode before inserting new ones
      await supabaseAdmin
        .from('compliance_flags')
        .delete()
        .eq('episode_id', episode.id)

      // Insert new flags
      if (allFlags.length > 0) {
        await supabaseAdmin.from('compliance_flags').insert(allFlags)
      }

      // Update status
      await supabaseAdmin
        .from('episode_log')
        .update({ status: 'compliance_checked', error_message: null })
        .eq('id', episode.id)

      checked++
      console.log(`[compliance] ep ${episode.id} done: ${allFlags.length} flags`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[compliance] ep ${episode.id} failed:`, errMsg)
      // Don't block - leave as summarized, still usable for QIR
      // Just log the error on the episode
      await supabaseAdmin
        .from('episode_log')
        .update({
          error_message: `Compliance check failed: ${errMsg.slice(0, 500)}`,
        })
        .eq('id', episode.id)
    }
  }

  return { checked }
}
