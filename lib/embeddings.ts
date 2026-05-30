// OpenAI embedding helpers shared by the corpus-embed path (summarize worker +
// backfill) and the search-query path (lib/transcript-search.ts). Thin wrapper
// over the OpenAI embeddings endpoint with the same transient-error retry the
// summarize worker uses. No DB here.
//
// Dimension is pinned to 1536 (text-embedding-3-small) to match the
// transcript_chunks.embedding vector(1536) column. Switching to a model with a
// different dimension requires altering that column AND re-embedding the corpus.

import OpenAI from 'openai'

export const EMBEDDING_DIMENSIONS = 1536
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'

let sharedClient: OpenAI | null = null

/** Lazily-built default client; callers may also pass their own (the summarize
 *  worker reuses the one it already created). */
export function getEmbeddingClient(): OpenAI {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set')
  if (!sharedClient) sharedClient = new OpenAI({ apiKey: key, timeout: 60_000 })
  return sharedClient
}

/** pgvector's text input form: `[0.1,0.2,...]`. We send this string so PostgREST
 *  never has to coerce a JSON array into a vector column / argument. */
export function toPgVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface EmbedResult {
  embeddings: number[][]
  tokens: number
}

/** Embed a batch of texts in one request. Retries transient 429/5xx with
 *  exponential backoff (mirrors workers/summarize.ts). */
export async function embedTexts(
  texts: string[],
  model: string = DEFAULT_EMBEDDING_MODEL,
  openai: OpenAI = getEmbeddingClient()
): Promise<EmbedResult> {
  if (!texts.length) return { embeddings: [], tokens: 0 }

  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await openai.embeddings.create({ model, input: texts })
      return {
        embeddings: res.data.map((d) => d.embedding as number[]),
        tokens: res.usage?.total_tokens ?? 0,
      }
    } catch (err: unknown) {
      lastError = err
      const status = (err as { status?: number })?.status
      if (status && [429, 500, 502, 503].includes(status)) {
        await sleep(Math.pow(2, attempt + 1) * 1000)
        continue
      }
      throw err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('embedTexts failed after retries')
}

/** Embed a single search query. */
export async function embedQuery(
  text: string,
  model: string = DEFAULT_EMBEDDING_MODEL
): Promise<{ embedding: number[]; tokens: number }> {
  const { embeddings, tokens } = await embedTexts([text], model)
  return { embedding: embeddings[0], tokens }
}
