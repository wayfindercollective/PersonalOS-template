import {
  searchMemories,
  getRecentMemories,
  touchMemory,
  insertMemory,
  decayAndPruneMemories,
  insertMemoryEmbedding,
  getMemoriesWithEmbeddings,
} from './db.js'
import { embed, cosineSim } from './embeddings.js'
import { logger } from './logger.js'

const SEMANTIC_PATTERN =
  /\b(my|i am|i'm|i prefer|remember|always|never|i like|i hate|i use|i want|i need)\b/i

/** Per-line clip so a single huge document memory can't blow local context. */
export const MEMORY_LINE_MAX = 400
/** Hard cap on the whole [Memory context] block. */
export const MEMORY_BLOCK_MAX = 2200
/** Cap when writing a user turn into long-term memory. */
export const MEMORY_STORE_MAX = 1500

export type MemoryInjectMode = 'full' | 'fresh' | 'none'

export interface BuildMemoryOptions {
  /**
   * full  — normal retrieval (semantic + FTS + recent)
   * fresh — post-/newchat: no "recent" dump, tighter caps, only on substantive msgs
   * none  — skip entirely (first turn after /newchat, or explicit quiet)
   */
  mode?: MemoryInjectMode
}

// Fire-and-forget background embed for a freshly-inserted memory. Failures
// are logged but never thrown to the caller — the memory itself is already
// persisted and remains searchable via FTS as a fallback.
function embedInBackground(memoryId: number, content: string): void {
  embed(content).then((res) => {
    if (!res) return
    try {
      insertMemoryEmbedding(memoryId, res.embedding, res.model)
    } catch (err) {
      logger.warn({ err, memoryId }, '[Embed] failed to store embedding row')
    }
  }).catch((err) => {
    logger.warn({ err, memoryId }, '[Embed] background embed threw')
  })
}

export function clipMemoryContent(content: string, max = MEMORY_LINE_MAX): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return oneLine.slice(0, max - 1) + '…'
}

export function formatMemoryBlock(
  items: Array<{ content: string; sector: string }>,
  blockMax = MEMORY_BLOCK_MAX,
): string {
  if (items.length === 0) return ''
  const lines: string[] = []
  let used = '[Memory context]\n'.length
  for (const m of items) {
    const line = `- ${clipMemoryContent(m.content)} (${m.sector})`
    if (used + line.length + 1 > blockMax) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ''
  return `[Memory context]\n${lines.join('\n')}`
}

// Semantic search via cosine on stored embeddings. Returns top K with id +
// content + sector + a recency-boosted score so newer memories tie-break.
async function semanticSearchMemories(
  chatId: string,
  query: string,
  limit = 5,
  minScore = 0.3,
): Promise<Array<{ id: number; content: string; sector: string; score: number }>> {
  const queryEmb = await embed(query)
  if (!queryEmb) return []
  const candidates = getMemoriesWithEmbeddings(chatId)
  if (candidates.length === 0) return []
  const nowSec = Math.floor(Date.now() / 1000)
  const scored = candidates.map((m) => {
    const sim = cosineSim(queryEmb.embedding, m.embedding)
    const ageDays = (nowSec - m.created_at) / 86_400
    // Mild recency boost: full weight at <30 days, halved over a year.
    const recency = Math.exp(-ageDays / 365)
    const score = sim * (1 + 0.1 * Math.log(Math.max(m.salience, 0.01))) * (0.7 + 0.3 * recency)
    return { id: m.id, content: m.content, sector: m.sector, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.filter((s) => s.score > minScore).slice(0, limit)
}

export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
  options: BuildMemoryOptions = {},
): Promise<string> {
  const mode: MemoryInjectMode = options.mode ?? 'full'
  if (mode === 'none') return ''

  // Fresh sessions after /newchat: only pull on substantive messages, no "recent" dump.
  const minQueryLen = mode === 'fresh' ? 40 : 15
  const ftsLimit = mode === 'fresh' ? 2 : 3
  const semLimit = mode === 'fresh' ? 2 : 4
  const semMinScore = mode === 'fresh' ? 0.4 : 0.3
  const maxItems = mode === 'fresh' ? 3 : 6
  const includeRecent = mode === 'full'

  const ftsResults = userMessage.length >= minQueryLen
    ? searchMemories(chatId, userMessage, ftsLimit)
    : []
  const recentResults = includeRecent ? getRecentMemories(chatId, 2) : []

  const semanticResults = userMessage.length >= minQueryLen
    ? await semanticSearchMemories(chatId, userMessage, semLimit, semMinScore)
    : []

  // Deduplicate by id; preserve order: semantic first (most relevant), then FTS, then recent
  const seen = new Set<number>()
  const all: Array<{ id: number; content: string; sector: string }> = []

  for (const m of [...semanticResults, ...ftsResults, ...recentResults]) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    all.push(m)
    if (all.length >= maxItems) break
  }

  if (all.length === 0) return ''

  for (const m of all) {
    touchMemory(m.id)
  }

  const block = formatMemoryBlock(all)
  logger.info(
    {
      chatId,
      mode,
      count: all.length,
      ftsCount: ftsResults.length,
      semCount: semanticResults.length,
      ids: all.map((m) => m.id),
      blockLen: block.length,
    },
    'Memory context injected'
  )
  return block
}

export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  // Skip short or command messages
  if (userMsg.length <= 20 || userMsg.startsWith('/')) return

  // Don't memorize pure transfer / disregard dumps
  if (/^\s*(disregard this|ignore this|for transfer)\b/i.test(userMsg)) return

  const isSemantic = SEMANTIC_PATTERN.test(userMsg)
  const sector = isSemantic ? 'semantic' : 'episodic'

  // Cap stored user text so document pastes don't become 80KB memory landmines
  const storedUser = userMsg.length > MEMORY_STORE_MAX
    ? userMsg.slice(0, MEMORY_STORE_MAX) + '…'
    : userMsg

  const userId = insertMemory(chatId, storedUser, sector)
  embedInBackground(userId, storedUser)

  // Save assistant response as episodic — skip noise (errors, footers, short tool output)
  const isNoise = assistantMsg.length < 150
    || /^Error running agent/.test(assistantMsg)
    || /^\(Agent hit an error/.test(assistantMsg)
    || /^⚠️/.test(assistantMsg)
    || /^\[Escalat/.test(assistantMsg)
    || (/\[(?:claude|opus|sonnet|haiku|lmstudio|qwen)[^\]]*--\s*[\d.]+s\]/.test(assistantMsg) && assistantMsg.length < 300)
  if (!isNoise) {
    const summary = assistantMsg.length > 400 ? assistantMsg.slice(0, 400) + '...' : assistantMsg
    const aId = insertMemory(chatId, summary, 'episodic')
    embedInBackground(aId, summary)
  }

  logger.debug({ chatId, sector }, 'Saved conversation turn')
}

export function runDecaySweep(): void {
  decayAndPruneMemories()
}
