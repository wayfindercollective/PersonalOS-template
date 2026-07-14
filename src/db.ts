import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(STORE_DIR, { recursive: true })
    db = new Database(resolve(STORE_DIR, 'personalos.db'))
    db.pragma('journal_mode = WAL')
  }
  return db
}

export function initDatabase(): void {
  const d = getDb()

  // Sessions
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Memories (full dual-sector)
  d.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content_rowid='id'
    )
  `)

  // FTS sync triggers
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      UPDATE memories_fts SET content = new.content WHERE rowid = new.id;
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.id;
    END
  `)

  // Scheduled tasks
  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run)
  `)

  // Migration: add model column to scheduled_tasks (safe to run repeatedly)
  try {
    d.exec(`ALTER TABLE scheduled_tasks ADD COLUMN model TEXT DEFAULT NULL`)
  } catch {
    // Column already exists -- ignore
  }

  // Migration: add one_shot column. Tasks with one_shot=1 auto-pause after a successful run.
  try {
    d.exec(`ALTER TABLE scheduled_tasks ADD COLUMN one_shot INTEGER NOT NULL DEFAULT 0`)
  } catch {
    // Column already exists -- ignore
  }

  // Migration: track the timestamp of the last *successful* run, distinct from
  // last_run (which marks the last attempt of any kind). Lets us preserve
  // last_result across failures and still answer "when did this last work?".
  try {
    d.exec(`ALTER TABLE scheduled_tasks ADD COLUMN last_success_at INTEGER`)
  } catch {
    // Column already exists -- ignore
  }

  // Migration: task_type lets the scheduler skip the LLM and just execSync the
  // prompt as a shell command. Values: 'llm' (default), 'raw'.
  try {
    d.exec(`ALTER TABLE scheduled_tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'llm'`)
  } catch {
    // Column already exists -- ignore
  }
  // raw_output_mode: 'chat' (default) sends stdout/stderr to chat_id; 'log' is
  // silent (only journal). Null on llm tasks.
  try {
    d.exec(`ALTER TABLE scheduled_tasks ADD COLUMN raw_output_mode TEXT`)
  } catch {
    // Column already exists -- ignore
  }

  // Semantic memory: vector embeddings per memory. Embedding stored as JSON
  // float array. Cosine similarity computed in JS at search time.
  d.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id INTEGER PRIMARY KEY,
      embedding TEXT NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    )
  `)

  // Scheduled task failure log (for weekly digest)
  d.exec(`
    CREATE TABLE IF NOT EXISTS task_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      task_prompt TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      error_message TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      reported INTEGER NOT NULL DEFAULT 0
    )
  `)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_failures_reported ON task_failures(reported, occurred_at)`)

  // WhatsApp tables
  d.exec(`
    CREATE TABLE IF NOT EXISTS wa_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_chat_id TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )
  `)
  d.exec(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_chat_id TEXT NOT NULL,
      wa_chat_name TEXT,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0
    )
  `)
  d.exec(`
    CREATE TABLE IF NOT EXISTS wa_message_map (
      wa_chat_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL
    )
  `)


  // Cross-model conversation log (ordered turn history for context sharing on model switch)
  d.exec(`
    CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'unknown',
      created_at INTEGER NOT NULL
    )
  `)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_conv_log_chat ON conversation_log(chat_id, id)`)

  // LM Studio chat history persistence (survives restarts)
  d.exec(`
    CREATE TABLE IF NOT EXISTS lmstudio_history (
      chat_id TEXT PRIMARY KEY,
      messages TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )
  `)

  // Generic per-chat settings (voice mode, preferences, etc.)
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      chat_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (chat_id, key)
    )
  `)

    logger.info('Database initialized')
}

// --- Session functions ---

export function getSession(chatId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string } | undefined
  return row?.session_id
}

export function setSession(chatId: string, sessionId: string): void {
  getDb()
    .prepare(
      'INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at'
    )
    .run(chatId, sessionId, Math.floor(Date.now() / 1000))
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Settings functions ---

export function getSetting(chatId: string, key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE chat_id = ? AND key = ?')
    .get(chatId, key) as { value: string } | undefined
  return row?.value
}

export function setSetting(chatId: string, key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (chat_id, key, value) VALUES (?, ?, ?) ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value')
    .run(chatId, key, value)
}

export function deleteSetting(chatId: string, key: string): void {
  getDb().prepare('DELETE FROM settings WHERE chat_id = ? AND key = ?').run(chatId, key)
}

export function getSettingsByKey(key: string): Array<{ chat_id: string; value: string }> {
  return getDb()
    .prepare('SELECT chat_id, value FROM settings WHERE key = ?')
    .all(key) as Array<{ chat_id: string; value: string }>
}

// --- Memory functions ---

export function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string,
  salience = 1.0
): number {
  const now = Math.floor(Date.now() / 1000)
  const result = getDb()
    .prepare(
      'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(chatId, topicKey ?? null, content, sector, salience, now, now)
  return Number(result.lastInsertRowid)
}

// --- Memory embeddings (semantic search) ---

export function insertMemoryEmbedding(
  memoryId: number,
  embedding: number[],
  model: string,
): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model, dim, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(memoryId, JSON.stringify(embedding), model, embedding.length, Math.floor(Date.now() / 1000))
}

export function getMemoriesWithEmbeddings(chatId: string): Array<{
  id: number
  content: string
  sector: string
  salience: number
  created_at: number
  embedding: number[]
}> {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.content, m.sector, m.salience, m.created_at, e.embedding
       FROM memories m
       JOIN memory_embeddings e ON e.memory_id = m.id
       WHERE m.chat_id = ?`
    )
    .all(chatId) as Array<{ id: number; content: string; sector: string; salience: number; created_at: number; embedding: string }>
  return rows.map(r => {
    let emb: number[] = []
    try { emb = JSON.parse(r.embedding) } catch { /* skip */ }
    return { id: r.id, content: r.content, sector: r.sector, salience: r.salience, created_at: r.created_at, embedding: emb }
  })
}

export function getMemoriesMissingEmbeddings(limit = 100): Array<{ id: number; content: string }> {
  return getDb()
    .prepare(
      `SELECT m.id, m.content FROM memories m
       LEFT JOIN memory_embeddings e ON e.memory_id = m.id
       WHERE e.memory_id IS NULL
       ORDER BY m.id DESC
       LIMIT ?`
    )
    .all(limit) as Array<{ id: number; content: string }>
}

export function searchMemories(
  chatId: string,
  query: string,
  limit = 3
): Array<{ id: number; content: string; sector: string; salience: number }> {
  const FTS5_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR'])
  // Common words that match too broadly and shouldn't drive FTS retrieval
  const STOPWORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'is','it','its','be','was','are','were','been','have','has','had',
    'do','does','did','will','would','could','should','may','might','shall',
    'i','my','me','we','our','you','your','he','his','she','her','they',
    'this','that','these','those','what','how','when','where','why','which',
    'can','via','into','from','by','up','out','if','so','as','about','just',
    'not','no','any','all','some','more','also','then','than','get','got',
    'there','here','now','still','even','back','over','after','before',
    'only','like','make','made','use','used','see','new','way','know',
    'go','going','went','come','came','take','took','give','gave','let',
    'want','need','one','two','first','last','ssh','hi','hey'
  ])

  const sanitized = query.replace(/[^\w\s]/g, '').trim()
  if (!sanitized) return []

  const terms = sanitized
    .split(/\s+/)
    .filter((t) => t.length > 2 && !FTS5_RESERVED.has(t.toUpperCase()) && !STOPWORDS.has(t.toLowerCase()))
    .map((t) => `"${t}"*`)
    .join(' OR ')

  if (!terms) return []

  return getDb()
    .prepare(
      // rank is FTS5 BM25 (negative: more negative = stronger match).
      // Order by rank only — absolute thresholds break on small DBs.
      `SELECT m.id, m.content, m.sector, m.salience
       FROM memories m
       JOIN memories_fts f ON f.rowid = m.id
       WHERE memories_fts MATCH ? AND m.chat_id = ? AND m.created_at >= ?
       ORDER BY f.rank
       LIMIT ?`
    )
    .all(terms, chatId, Math.floor(Date.now() / 1000) - 30 * 24 * 3600, limit) as Array<{
    id: number
    content: string
    sector: string
    salience: number
  }>
}

export function getRecentMemories(
  chatId: string,
  limit = 2
): Array<{ id: number; content: string; sector: string; salience: number }> {
  return getDb()
    .prepare(
      `SELECT id, content, sector, salience
       FROM memories
       WHERE chat_id = ?
       ORDER BY accessed_at DESC
       LIMIT ?`
    )
    .all(chatId, limit) as Array<{
    id: number
    content: string
    sector: string
    salience: number
  }>
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .prepare(
      'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?'
    )
    .run(now, id)
}

export function decayAndPruneMemories(): void {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400
  const d = getDb()
  const decayed = d
    .prepare(
      'UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?'
    )
    .run(oneDayAgo)
  const pruned = d
    .prepare('DELETE FROM memories WHERE salience < 0.1')
    .run()
  logger.info(
    { decayed: decayed.changes, pruned: pruned.changes },
    'Memory decay sweep'
  )
}

export function getMemoryCount(chatId?: string): number {
  if (chatId) {
    const row = getDb()
      .prepare('SELECT COUNT(*) as count FROM memories WHERE chat_id = ?')
      .get(chatId) as { count: number }
    return row.count
  }
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM memories')
    .get() as { count: number }
  return row.count
}

// --- Scheduler functions ---

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: string
  created_at: number
  model: string | null
  one_shot: number
  last_success_at: number | null
  task_type: string  // 'llm' (default) or 'raw'
  raw_output_mode: string | null  // 'chat' | 'log' | null
}

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number,
  model?: string,
  oneShot = false,
  taskType: 'llm' | 'raw' = 'llm',
  rawOutputMode: 'chat' | 'log' | null = null,
): void {
  // Validate chat_id is a numeric Telegram/Discord ID (not a flag or placeholder)
  if (!/^\d{5,}$/.test(chatId) && !chatId.startsWith('discord-')) {
    throw new Error(`Invalid chat_id: "${chatId}" -- must be a numeric chat ID`)
  }

  // Reject empty prompts
  if (!prompt.trim()) {
    throw new Error('Task prompt cannot be empty')
  }

  getDb()
    .prepare(
      'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at, model, one_shot, task_type, raw_output_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, chatId, prompt, schedule, nextRun, Math.floor(Date.now() / 1000), model ?? null, oneShot ? 1 : 0, taskType, rawOutputMode)
}

export function setTaskOneShot(id: string, oneShot: boolean): void {
  getDb()
    .prepare('UPDATE scheduled_tasks SET one_shot = ? WHERE id = ?')
    .run(oneShot ? 1 : 0, id)
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000)
  return getDb()
    .prepare(
      "SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?"
    )
    .all(now) as ScheduledTask[]
}

export function getAllTasks(): ScheduledTask[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string
): void {
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .prepare(
      'UPDATE scheduled_tasks SET last_run = ?, last_result = ?, next_run = ? WHERE id = ?'
    )
    .run(now, result, nextRun, id)
}

// Success update: stamps last_run AND last_success_at, plus next_run + result.
// Use this on the success path so we can answer "when did this task last work?".
export function updateTaskAfterSuccess(
  id: string,
  nextRun: number,
  result: string
): void {
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .prepare(
      'UPDATE scheduled_tasks SET last_run = ?, last_success_at = ?, last_result = ?, next_run = ? WHERE id = ?'
    )
    .run(now, now, result, nextRun, id)
}

// Failure-side update: bumps next_run and last_run only. Preserves last_result
// so the prior successful output isn't destroyed by an ERROR string. The
// failure detail lives in the task_failures table for the weekly digest.
export function bumpTaskNextRun(id: string, nextRun: number): void {
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .prepare('UPDATE scheduled_tasks SET last_run = ?, next_run = ? WHERE id = ?')
    .run(now, nextRun, id)
}

export function setTaskStatus(id: string, status: 'active' | 'paused'): void {
  getDb()
    .prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?')
    .run(status, id)
}

export function setTaskModel(id: string, model: string | null): void {
  getDb()
    .prepare('UPDATE scheduled_tasks SET model = ? WHERE id = ?')
    .run(model, id)
}

export function deleteTask(id: string): void {
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
}

// --- Task failure log (weekly digest) ---

export interface TaskFailure {
  id: number
  task_id: string
  task_prompt: string
  chat_id: string
  error_message: string
  occurred_at: number
}

export function recordTaskFailure(
  taskId: string,
  taskPrompt: string,
  chatId: string,
  errorMessage: string
): void {
  getDb()
    .prepare(
      'INSERT INTO task_failures (task_id, task_prompt, chat_id, error_message, occurred_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(taskId, taskPrompt, chatId, errorMessage, Math.floor(Date.now() / 1000))
}

export function getUnreportedFailures(): TaskFailure[] {
  return getDb()
    .prepare(
      'SELECT id, task_id, task_prompt, chat_id, error_message, occurred_at FROM task_failures WHERE reported = 0 ORDER BY occurred_at'
    )
    .all() as TaskFailure[]
}

export function markFailuresReported(ids: number[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  getDb()
    .prepare(`UPDATE task_failures SET reported = 1 WHERE id IN (${placeholders})`)
    .run(...ids)
}

// --- WhatsApp functions ---

export function queueWaMessage(waChatId: string, message: string): void {
  getDb()
    .prepare(
      'INSERT INTO wa_outbox (wa_chat_id, message, created_at) VALUES (?, ?, ?)'
    )
    .run(waChatId, message, Math.floor(Date.now() / 1000))
}

export function getPendingWaMessages(): Array<{
  id: number
  wa_chat_id: string
  message: string
}> {
  return getDb()
    .prepare(
      "SELECT id, wa_chat_id, message FROM wa_outbox WHERE status = 'pending' ORDER BY created_at"
    )
    .all() as Array<{ id: number; wa_chat_id: string; message: string }>
}

export function markWaSent(id: number): void {
  getDb()
    .prepare("UPDATE wa_outbox SET status = 'sent' WHERE id = ?")
    .run(id)
}

export function saveWaMessage(
  waChatId: string,
  chatName: string | null,
  sender: string,
  content: string,
  timestamp: number
): void {
  getDb()
    .prepare(
      'INSERT INTO wa_messages (wa_chat_id, wa_chat_name, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    )
    .run(waChatId, chatName, sender, content, timestamp)
}

export function getUnnotifiedWaMessages(): Array<{
  id: number
  wa_chat_id: string
  wa_chat_name: string | null
  sender: string
  content: string
  timestamp: number
}> {
  return getDb()
    .prepare(
      'SELECT id, wa_chat_id, wa_chat_name, sender, content, timestamp FROM wa_messages WHERE notified = 0 ORDER BY timestamp'
    )
    .all() as Array<{
    id: number
    wa_chat_id: string
    wa_chat_name: string | null
    sender: string
    content: string
    timestamp: number
  }>
}

export function markWaNotified(ids: number[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  getDb()
    .prepare(`UPDATE wa_messages SET notified = 1 WHERE id IN (${placeholders})`)
    .run(...ids)
}

export function getRecentWaChats(
  limit = 10
): Array<{ wa_chat_id: string; wa_chat_name: string | null; last_msg: number }> {
  return getDb()
    .prepare(
      `SELECT wa_chat_id, wa_chat_name, MAX(timestamp) as last_msg
       FROM wa_messages
       GROUP BY wa_chat_id
       ORDER BY last_msg DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    wa_chat_id: string
    wa_chat_name: string | null
    last_msg: number
  }>
}

export function getWaChatMessages(
  waChatId: string,
  limit = 20
): Array<{ sender: string; content: string; timestamp: number }> {
  return getDb()
    .prepare(
      'SELECT sender, content, timestamp FROM wa_messages WHERE wa_chat_id = ? ORDER BY timestamp DESC LIMIT ?'
    )
    .all(waChatId, limit) as Array<{
    sender: string
    content: string
    timestamp: number
  }>
}

// --- Cross-model conversation log ---

export interface ConversationEntry {
  role: 'user' | 'assistant'
  content: string
  model: string
}

export function logConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string,
  model: string
): void {
  if (userMsg.startsWith('/')) return // skip commands
  const now = Math.floor(Date.now() / 1000)
  const d = getDb()
  d.prepare('INSERT INTO conversation_log (chat_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, 'user', userMsg.slice(0, 4000), model, now)
  d.prepare('INSERT INTO conversation_log (chat_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, 'assistant', assistantMsg.slice(0, 4000), model, now)
  // Keep last 60 entries per chat (30 exchanges)
  d.prepare(
    `DELETE FROM conversation_log WHERE chat_id = ? AND id NOT IN (
      SELECT id FROM conversation_log WHERE chat_id = ? ORDER BY id DESC LIMIT 60
    )`
  ).run(chatId, chatId)
}

export function getRecentConversationLog(chatId: string, limit = 20): ConversationEntry[] {
  const rows = getDb()
    .prepare(
      'SELECT role, content, model FROM conversation_log WHERE chat_id = ? ORDER BY id DESC LIMIT ?'
    )
    .all(chatId, limit) as ConversationEntry[]
  return rows.reverse() // return in chronological order
}

// --- LM Studio history persistence ---

export function saveLMStudioHistory(chatId: string, messages: unknown[]): void {
  const json = JSON.stringify(messages)
  getDb()
    .prepare(
      'INSERT INTO lmstudio_history (chat_id, messages, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at'
    )
    .run(chatId, json, Math.floor(Date.now() / 1000))
}

export function loadLMStudioHistory(chatId: string): unknown[] | null {
  const row = getDb()
    .prepare('SELECT messages FROM lmstudio_history WHERE chat_id = ?')
    .get(chatId) as { messages: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.messages)
  } catch {
    return null
  }
}

export function loadAllLMStudioHistories(): Map<string, unknown[]> {
  const rows = getDb()
    .prepare('SELECT chat_id, messages FROM lmstudio_history')
    .all() as Array<{ chat_id: string; messages: string }>
  const result = new Map<string, unknown[]>()
  for (const row of rows) {
    try {
      result.set(row.chat_id, JSON.parse(row.messages))
    } catch { /* skip corrupt rows */ }
  }
  return result
}

export function clearLMStudioHistoryDb(chatId: string): void {
  getDb().prepare('DELETE FROM lmstudio_history WHERE chat_id = ?').run(chatId)
}
