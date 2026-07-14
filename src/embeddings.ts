/** Embeddings helper — uses LMSTUDIO_URL when set. */
import { logger } from './logger.js'
import { readEnvFile } from './env.js'

const env = readEnvFile()

const LMSTUDIO_URL = env['LMSTUDIO_URL'] ?? 'http://127.0.0.1:8080'
const LMSTUDIO_API_KEY = env['LMSTUDIO_API_KEY'] ?? ''
// Local embedding path. If EMBEDDING_URL is unset, defaults to the LiteLLM
// proxy at LMSTUDIO_URL. Set EMBEDDING_URL=http://mini-infinity:11434 (or
// similar) to hit Ollama directly. EMBEDDING_MODEL must be an actual
// embedding model — chat models like qwen3.6-27b refuse embedding requests
// at both Ollama and LiteLLM. Pull e.g. `ollama pull nomic-embed-text` on
// mini-infinity and set EMBEDDING_MODEL=nomic-embed-text. Until that's set
// up, embeddings fall through to Gemini.
const EMBEDDING_URL = env['EMBEDDING_URL'] ?? LMSTUDIO_URL
const EMBEDDING_MODEL = env['EMBEDDING_MODEL'] ?? ''
const GOOGLE_API_KEY = env['GOOGLE_API_KEY'] ?? ''
const GEMINI_EMBEDDING_MODEL = env['GEMINI_EMBEDDING_MODEL'] ?? 'gemini-embedding-001'

export interface EmbedResult {
  embedding: number[]
  model: string
}

async function embedViaLocal(text: string): Promise<EmbedResult | null> {
  // Skip entirely if no local embedding model is configured. Avoids spamming
  // warn logs every memory insert when only Gemini is wired up.
  if (!EMBEDDING_MODEL) return null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (LMSTUDIO_API_KEY) headers['Authorization'] = `Bearer ${LMSTUDIO_API_KEY}`
  try {
    const res = await fetch(`${EMBEDDING_URL}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      const body = await res.text()
      logger.warn({ status: res.status, body: body.slice(0, 200), url: EMBEDDING_URL, model: EMBEDDING_MODEL }, '[Embed] local call failed')
      return null
    }
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> }
    const emb = data.data?.[0]?.embedding
    if (!emb || emb.length === 0) {
      logger.warn({ data }, '[Embed] local returned no embedding')
      return null
    }
    return { embedding: emb, model: `local:${EMBEDDING_MODEL}` }
  } catch (err) {
    logger.warn({ err, url: EMBEDDING_URL }, '[Embed] local call threw')
    return null
  }
}

async function embedViaGemini(text: string): Promise<EmbedResult | null> {
  if (!GOOGLE_API_KEY) {
    logger.warn('[Embed] Gemini fallback unavailable: no GOOGLE_API_KEY')
    return null
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${GOOGLE_API_KEY}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      const body = await res.text()
      logger.warn({ status: res.status, body: body.slice(0, 200) }, '[Embed] Gemini call failed')
      return null
    }
    const data = await res.json() as { embedding?: { values?: number[] } }
    const emb = data.embedding?.values
    if (!emb || emb.length === 0) {
      logger.warn({ data }, '[Embed] Gemini returned no embedding')
      return null
    }
    return { embedding: emb, model: `gemini:${GEMINI_EMBEDDING_MODEL}` }
  } catch (err) {
    logger.warn({ err }, '[Embed] Gemini call threw')
    return null
  }
}

/** Embed a single text. Tries local (LiteLLM/Ollama) first if configured,
 *  falls back to Gemini. Set EMBEDDING_MODEL+EMBEDDING_URL in .env to enable
 *  the local path (e.g. EMBEDDING_URL=http://mini-infinity:11434 EMBEDDING_MODEL=nomic-embed-text).
 */
export async function embed(text: string): Promise<EmbedResult | null> {
  const trimmed = text.trim()
  if (!trimmed) return null
  const truncated = trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed
  const primary = await embedViaLocal(truncated)
  if (primary) return primary
  return await embedViaGemini(truncated)
}

/** Cosine similarity for two equal-length arrays. Returns -1..1. */
export function cosineSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
