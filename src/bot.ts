import { Bot, Context, InputFile } from 'grammy'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
  SCHEDULER_ENABLED,
  WA_ENABLED,
  UPLOADS_DIR,
} from './config.js'
import { getSession, setSession, clearSession, getMemoryCount, logConversationTurn, getRecentConversationLog, getSetting, setSetting, deleteSetting, getSettingsByKey } from './db.js'
import { runAgent } from './agent.js'
import {
  buildMemoryContext,
  saveConversationTurn,
  type MemoryInjectMode,
} from './memory.js'
import { transcribeAudio, voiceCapabilities } from './voice.js'
import {
  downloadMedia,
  buildPhotoMessage,
  buildDocumentMessage,
  buildVideoMessage,
} from './media.js'
import { computeNextRun } from './scheduler.js'
import { createTask, getAllTasks, deleteTask, setTaskStatus } from './db.js'
import { listRecentChats } from './whatsapp.js'
import {
  CLAUDE_SHORTCUTS,
  DEFAULT_CLAUDE_MODEL,
  normalizeClaudeModel,
  resolveTaskModel,
  claudeModelLabel,
  CLAUDE_MODEL_HELP,
} from './models.js'
import {
  queryOllama,
  listOllamaModels,
  getOllamaModel,
  setOllamaModel,
  clearOllamaHistory,
  getOllamaHistory,
  seedOllamaHistory,
  isOllamaAvailable,
  getEndpointNames,
  getActiveEndpoint,
  setActiveEndpoint,
  getOllamaStatus,
  isToolsEnabled,
  setToolsEnabled,
  evaluateConfidence,
  getConfidenceThreshold,
  AllEndpointsDownError,
  getEndpointsStatus,
  checkAllEndpoints,
  getEndpointPriority,
  setEndpointPriority,
  addEndpoint,
  removeEndpoint,
  setCooldownMinutes,
  getCooldownMinutes,
  resetEndpointHealth,
} from './ollama.js'
import {
  queryLMStudio,
  listLMStudioModels,
  getLMStudioModel,
  getSessionContextTokens,
  setLMStudioModel,
  clearLMStudioHistory,
  getLMStudioHistory,
  seedLMStudioHistory,
  isLMStudioAvailable,
  getLMStudioStatus,
  LM_ESCALATION_PREFIX,
} from './lmstudio.js'
import {
  queryGrok,
  getGrokModel,
  setGrokModel,
  clearGrokHistory,
  getGrokStatus,
  isGrokAvailable,
  listGrokModels,
  describeXaiAuth,
} from './grok.js'
import {
  startGrokDeviceLogin,
  pollGrokDeviceLoginUntilDone,
  refreshGrokAccessToken,
  getGrokAuthSnapshot,
} from './xai-auth.js'
import { createTelegramProgress } from './progress.js'
import {
  createGoogleAuthUrl,
  refreshAllGoogleAccounts,
  ensureGoogleAuth,
  getGoogleFunnelRedirectUri,
  expectedEmailForAccount,
  type AccountName,
} from './google.js'
import { logger } from './logger.js'
import { synthesizeVoice, cleanupTtsFile, ttsAvailable } from './tts.js'
import { randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import { createWebTask, decideWebApproval, pollWebTask } from './web-agent.js'
import { reviewWithCodex } from './codex.js'

// Voice mode toggle (DB-persisted, survives restarts)
const voiceMode = new Set<string>()

/** Used by Funnel OAuth callback to ping Telegram when Gmail re-auth completes. */
let botInstanceForNotify: Bot | null = null

export async function notifyGoogleAuthSuccess(chatId: string, account: string): Promise<void> {
  if (!botInstanceForNotify) return
  try {
    await botInstanceForNotify.api.sendMessage(
      chatId,
      `✅ Google "${account}" connected.\nAccess tokens auto-refresh while the refresh token is valid.\n\nTry: scan my inbox`
    )
  } catch (err) {
    logger.warn({ err, chatId }, 'notifyGoogleAuthSuccess failed')
  }
}

// Model lock (DB-persisted, survives restarts + /newchat)
const modelLocked = new Set<string>()

// Ignore / passthrough mode — bot swallows non-command messages (device-to-device transfer).
// DB-persisted so it survives restarts.
const ignoreMode = new Set<string>()

// After /newchat: first turn gets no memory inject; next few use "fresh" (no recent dump).
const sessionMemoryMode = new Map<string, { turnsLeft: number }>()

function loadVoiceModes(): void {
  for (const row of getSettingsByKey('voice_mode')) {
    if (row.value === '1') voiceMode.add(row.chat_id)
  }
}

function loadPersistedModels(): void {
  for (const row of getSettingsByKey('active_model')) {
    const v = row.value as 'claude' | 'ollama' | 'lmstudio' | 'grok'
    if (v === 'claude' || v === 'ollama' || v === 'lmstudio' || v === 'grok') {
      activeModel.set(row.chat_id, v)
    }
  }
  for (const row of getSettingsByKey('claude_model')) {
    // Migrate stale versioned pins (claude-opus-4-6, …) → family aliases
    const normalized = normalizeClaudeModel(row.value)
    claudeModel.set(row.chat_id, normalized)
    if (normalized !== row.value) {
      setSetting(row.chat_id, 'claude_model', normalized)
    }
  }
  for (const row of getSettingsByKey('model_locked')) {
    if (row.value === '1') modelLocked.add(row.chat_id)
  }
  for (const row of getSettingsByKey('ignore_mode')) {
    if (row.value === '1') ignoreMode.add(row.chat_id)
  }
}

function isModelLocked(chatId: string): boolean {
  return modelLocked.has(chatId)
}

function isIgnoreMode(chatId: string): boolean {
  return ignoreMode.has(chatId)
}

/** Reply text after /newchat or /forget — remind if ignore mode still active. */
function sessionClearedMessage(chatId: string): string {
  let msg = 'Session cleared. Starting fresh (light memory for a few turns).'
  if (isIgnoreMode(chatId)) {
    msg +=
      '\n\n⚠️ Ignore mode is still ON — plain messages (and media) will be swallowed.\n' +
      'Send /listen (or /unignore) to resume processing.'
  }
  return msg
}

/** Resolve memory inject mode for this turn; advances the post-/newchat quiet counter. */
function takeMemoryInjectMode(chatId: string): MemoryInjectMode {
  const state = sessionMemoryMode.get(chatId)
  if (!state) return 'full'
  // First turn after /newchat: complete quiet. Then a few "fresh" turns.
  const mode: MemoryInjectMode = state.turnsLeft >= 3 ? 'none' : 'fresh'
  state.turnsLeft -= 1
  if (state.turnsLeft <= 0) sessionMemoryMode.delete(chatId)
  else sessionMemoryMode.set(chatId, state)
  return mode
}

/** Mark session as freshly cleared — light memory inject for the next few turns. */
function markSessionFresh(chatId: string): void {
  // 3: first message → none; next two → fresh; then full
  sessionMemoryMode.set(chatId, { turnsLeft: 3 })
}

/**
 * When the user replies to a prior *text* message, wrap the quote so local models
 * see what he is responding to. Media replies are handled separately.
 */
export function buildTextReplyMessage(
  replyText: string | undefined,
  replyCaption: string | undefined,
  isBot: boolean | undefined,
  fromName: string | undefined,
  userText: string,
): string | null {
  const quote = (replyText ?? replyCaption ?? '').trim()
  if (!quote) return null
  const who = isBot ? 'PersonalOS' : (fromName || 'message')
  const clipped = quote.length > 1500 ? quote.slice(0, 1500) + '…' : quote
  return `[Replying to ${who}]:\n${clipped}\n\n${userText}`
}

// ── Debounce + Interrupt state ──────────────────────────────────────────────

const DEBOUNCE_MS = 3000
// Continuation window: a new message arriving this soon after your last one
// is treated as a follow-up that merges with the prior turn (abort + carry
// forward via chat history). Outside the window, the new message is a fresh
// independent request.
const MERGE_WINDOW_MS = 20_000
const MIN_GENERATION_MS = 2000  // don't interrupt if model just started
const MAX_INTERRUPTS_PER_MINUTE = 5

interface PendingBatch {
  texts: string[]
  ctx: Context  // updated to the most-recent message ctx for reply targeting
  timer: ReturnType<typeof setTimeout>
}
const pendingBatches = new Map<string, PendingBatch>()

interface ActiveGeneration {
  controller: AbortController
  startedAt: number
}
// Only populated for LM Studio — Claude/Ollama don't support clean mid-stream abort yet
const activeGenerations = new Map<string, ActiveGeneration>()

// Wall-clock of the last user message per chat, used to decide whether a new
// message is a continuation (merge) or a fresh request.
const lastMessageAt = new Map<string, number>()

// Chats currently executing inside handleMessage. Used by /btw to know when
// the current request finishes so a queued follow-up can dispatch.
const inFlight = new Set<string>()

// Queued /btw follow-ups per chat. Each item runs after the current request
// completes; multiple /btw messages stack in FIFO order.
interface BtwQueueItem { ctx: Context; text: string }
const btwPending = new Map<string, BtwQueueItem[]>()

const interruptCounts = new Map<string, { count: number; windowStart: number }>()

function canInterrupt(chatId: string): boolean {
  const now = Date.now()
  const t = interruptCounts.get(chatId)
  if (!t || now - t.windowStart > 60_000) {
    interruptCounts.set(chatId, { count: 0, windowStart: now })
    return true
  }
  return t.count < MAX_INTERRUPTS_PER_MINUTE
}

function recordInterrupt(chatId: string): void {
  const t = interruptCounts.get(chatId)
  if (t) t.count++
}

function fireBatch(chatId: string): void {
  const batch = pendingBatches.get(chatId)
  if (!batch) return
  pendingBatches.delete(chatId)
  const text = batch.texts.join('\n')
  const ctx = batch.ctx
  void runHandleMessage(ctx, text)
}

/**
 * Wrap handleMessage with inFlight tracking + /btw queue draining.
 * All paths that invoke handleMessage go through this so a single hook
 * fires when any kind of message (text, photo, voice, doc, video, /btw)
 * finishes.
 */
async function runHandleMessage(ctx: Context, text: string, voiceReply = false): Promise<void> {
  const chatId = String(ctx.chat!.id)
  inFlight.add(chatId)
  try {
    await handleMessage(ctx, text, voiceReply)
  } catch (err) {
    logger.error({ err, chatId }, 'Unhandled error in message handler')
    ctx.reply('Something went wrong. Try again.').catch(() => {})
  } finally {
    inFlight.delete(chatId)
    // Drain any /btw follow-ups queued during this turn.
    dispatchPendingBtw(chatId).catch((err) =>
      logger.error({ err, chatId }, '/btw dispatch after message failed')
    )
  }
}

/**
 * Queue a message with smart 20-second merge semantics.
 *
 * - Within MERGE_WINDOW_MS of your last message: treat as a continuation.
 *   If an LM Studio generation is in flight, abort it -- queryLMStudioInner's
 *   AbortError catch keeps the in-flight user entry in chat history, so the
 *   retry naturally merges the prior turn's context (including any photo
 *   vision description) with the new fragment. If a pending batch already
 *   exists, append to it.
 * - Outside the window: any stale pending batch fires immediately, then the
 *   new message starts a fresh independent batch -- no abort, no merge.
 *
 * The 3-second debounce inside the batch still groups rapid keystrokes.
 */
function queueMessage(ctx: Context, text: string): void {
  const chatId = String(ctx.chat!.id)
  const now = Date.now()
  const lastAt = lastMessageAt.get(chatId) ?? 0
  const withinMergeWindow = now - lastAt < MERGE_WINDOW_MS
  lastMessageAt.set(chatId, now)

  const model = activeModel.get(chatId) ?? 'claude'
  const active = activeGenerations.get(chatId)

  if (withinMergeWindow && active && model === 'lmstudio') {
    const elapsed = now - active.startedAt
    if (elapsed >= MIN_GENERATION_MS && canInterrupt(chatId)) {
      active.controller.abort()
      activeGenerations.delete(chatId)
      recordInterrupt(chatId)
      logger.info(
        { chatId, elapsedMs: elapsed, sinceLastMsgMs: now - lastAt },
        'Interrupted LM Studio generation (within merge window)'
      )
    }
  }

  const existing = pendingBatches.get(chatId)

  if (withinMergeWindow && existing) {
    clearTimeout(existing.timer)
    existing.texts.push(text)
    existing.ctx = ctx
    existing.timer = setTimeout(() => fireBatch(chatId), DEBOUNCE_MS)
    return
  }

  if (!withinMergeWindow && existing) {
    // Stale buffered text -- too long a gap to merge. Fire what we have so
    // it doesn't get glued onto the unrelated new message.
    clearTimeout(existing.timer)
    fireBatch(chatId)
  }

  ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {})
  const timer = setTimeout(() => fireBatch(chatId), DEBOUNCE_MS)
  pendingBatches.set(chatId, { texts: [text], ctx, timer })
}

// Legacy alias for non-text paths (voice, photo, document, video) that don't
// need debounce — they're single atomic messages. Still wraps through
// runHandleMessage so inFlight + /btw queue drain stay consistent.
function processMessage(ctx: Context, text: string, voiceReply = false): void {
  const chatId = String(ctx.chat?.id ?? '')
  if (chatId) lastMessageAt.set(chatId, Date.now())
  void runHandleMessage(ctx, text, voiceReply)
}

/**
 * Re-process the media in a Telegram reply.
 *
 * When the user replies to a previous voice/photo/document/video with text,
 * Telegram delivers a text-typed message that carries the original media in
 * `reply_to_message`. The typed handlers (`bot.on('message:voice')` etc.) only
 * fire on the *current* message's type, so without this the original media is
 * never re-read — the text falls into the agent loop which then tries to
 * improvise with shell tools.
 *
 * Pulls the media via its `file_id` (file_ids are long-lived; Telegram media
 * typically stays fetchable for at least a few weeks) and routes through the
 * same builder + processMessage path the original handler used, with the user's
 * follow-up text glued on. Returns true when the reply was consumed so the
 * caller can skip its default flow.
 */
async function handleMediaReply(ctx: Context, userText: string): Promise<boolean> {
  const replied = ctx.message?.reply_to_message
  if (!replied) return false

  // Voice notes and round video notes both arrive as audio for transcription.
  const voice = replied.voice ?? replied.video_note

  try {
    if (voice) {
      const localPath = await downloadMedia(voice.file_id, 'voice.oga')
      await ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {})
      const transcript = await transcribeAudio(localPath)
      const body = transcript
        ? `[Voice re-transcribed]: ${transcript}\n\nyour follow-up: ${userText}`
        : `[Voice could not be transcribed on retry]\n\nyour follow-up: ${userText}`
      processMessage(ctx, body)
      return true
    }
    if (replied.photo && replied.photo.length > 0) {
      const largest = replied.photo[replied.photo.length - 1]
      const localPath = await downloadMedia(largest.file_id, 'photo.jpg')
      processMessage(ctx, buildPhotoMessage(localPath, userText))
      return true
    }
    if (replied.document) {
      const name = replied.document.file_name ?? 'document'
      const localPath = await downloadMedia(replied.document.file_id, name)
      processMessage(ctx, buildDocumentMessage(localPath, name, userText))
      return true
    }
    if (replied.video) {
      const name = replied.video.file_name ?? 'video.mp4'
      const localPath = await downloadMedia(replied.video.file_id, name)
      processMessage(ctx, buildVideoMessage(localPath, userText))
      return true
    }
  } catch (err) {
    logger.error({ err }, 'Reply-to-media re-processing failed')
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`Couldn't re-fetch the original media (it may have expired): ${msg}`)
    return true
  }
  return false
}

/**
 * Queue a /btw follow-up. Never interrupts; waits for the current turn (and
 * any earlier queued /btw items) to finish, then runs as a normal message.
 */
function queueBtw(ctx: Context, text: string): void {
  const chatId = String(ctx.chat!.id)
  const trimmed = text.trim()
  if (!trimmed) {
    ctx.reply('/btw needs a message. Try: /btw also check the weather').catch(() => {})
    return
  }
  // /btw counts as a user message for the merge window -- if the user sends a
  // regular text right after, it should still treat the /btw as the "prior".
  lastMessageAt.set(chatId, Date.now())

  const list = btwPending.get(chatId) ?? []
  list.push({ ctx, text: trimmed })
  btwPending.set(chatId, list)
  logger.info({ chatId, queueDepth: list.length }, '/btw queued')

  // If nothing is in flight or pending, drain right away. Otherwise the
  // post-message hook in runHandleMessage will pick it up.
  if (!inFlight.has(chatId) && !pendingBatches.has(chatId)) {
    dispatchPendingBtw(chatId).catch((err) =>
      logger.error({ err, chatId }, '/btw immediate dispatch failed')
    )
  }
}

async function dispatchPendingBtw(chatId: string): Promise<void> {
  // Loop so several /btw items queued during one turn drain in order.
  // Stop if anything else takes over the chat (new normal msg, new batch).
  while (!inFlight.has(chatId) && !pendingBatches.has(chatId)) {
    const list = btwPending.get(chatId)
    if (!list || list.length === 0) {
      btwPending.delete(chatId)
      return
    }
    const next = list.shift()!
    if (list.length === 0) btwPending.delete(chatId)
    await runHandleMessage(next.ctx, next.text)
  }
}

// Active model per chat: 'claude' (default), 'ollama', 'lmstudio', or 'grok'
const activeModel = new Map<string, 'claude' | 'ollama' | 'lmstudio' | 'grok'>()

// Claude model per chat
const claudeModel = new Map<string, string>()

// Shared cross-provider conversation buffer (last N turns, provider-agnostic)
// Populated after every successful message regardless of which model answered.
// Used to seed a newly-switched provider with the recent conversation context.
const MAX_SHARED_TURNS = 10
const recentTurns = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>()

export function pushSharedTurn(chatId: string, role: 'user' | 'assistant', content: string): void {
  const turns = recentTurns.get(chatId) ?? []
  turns.push({ role, content })
  // Keep only the last MAX_SHARED_TURNS entries
  if (turns.length > MAX_SHARED_TURNS) turns.splice(0, turns.length - MAX_SHARED_TURNS)
  recentTurns.set(chatId, turns)
}

function getSharedTurns(chatId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  return recentTurns.get(chatId) ?? []
}

function clearSharedTurns(chatId: string): void {
  recentTurns.delete(chatId)
}

// Per-chat pending context injection: when switching back to Claude from another
// provider, we inject the recent cross-provider turns as a preamble on the next message.
const pendingContextInject = new Map<string, string>()
// Same mechanism for LM Studio: avoids seeding 10 separate history messages which
// can trip Qwen's Jinja template with "No user query found in messages."
const pendingLMContextInject = new Map<string, string>()

function buildContextPreamble(turns: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  if (turns.length === 0) return ''
  const lines = turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
  return `[Context from prior conversation -- another model was active]\n${lines.join('\n')}\n\n`
}

// Family aliases (opus/sonnet/haiku/…) auto-track the latest Claude model.
// See src/models.ts — never pin versioned IDs like claude-opus-4-6 here.
function getClaudeModel(chatId: string): string {
  return normalizeClaudeModel(claudeModel.get(chatId) ?? DEFAULT_CLAUDE_MODEL)
}

function getClaudeModelLabel(chatId: string): string {
  return claudeModelLabel(getClaudeModel(chatId))
}

// --- Formatting ---

export function formatForTelegram(text: string): string {
  // Extract code blocks and replace with placeholders
  const codeBlocks: string[] = []
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length
    const escaped = escapeHtml(code.trimEnd())
    codeBlocks.push(
      lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`
    )
    return `%%CODEBLOCK_${idx}%%`
  })

  // Inline code
  processed = processed.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`)

  // Now escape remaining HTML in non-code text
  processed = processed.replace(/%%CODEBLOCK_(\d+)%%/g, '!!CODEBLOCK_$1!!')
  processed = escapeHtmlExceptTags(processed)
  processed = processed.replace(/!!CODEBLOCK_(\d+)!!/g, '%%CODEBLOCK_$1%%')

  // Headings
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Bold
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic
  processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
  processed = processed.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')

  // Strikethrough
  processed = processed.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Checkboxes
  processed = processed.replace(/^- \[ \]/gm, '☐')
  processed = processed.replace(/^- \[x\]/gim, '☑')

  // Strip horizontal rules and raw HTML
  processed = processed.replace(/^---+$/gm, '')
  processed = processed.replace(/^\*\*\*+$/gm, '')

  // Restore code blocks
  processed = processed.replace(/%%CODEBLOCK_(\d+)%%/g, (_, idx) => codeBlocks[parseInt(idx)])

  return processed.trim()
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeHtmlExceptTags(text: string): string {
  // Only escape &, <, > that are NOT part of our generated HTML tags
  return text
    .replace(/&(?!amp;|lt;|gt;)/g, '&amp;')
    .replace(/<(?!\/?(?:b|i|s|u|code|pre|a)\b)/g, '&lt;')
    .replace(/(?<!<\/?\w[^>]*)>/g, (match, offset, str) => {
      // Check if this > closes an HTML tag we created
      const before = str.slice(Math.max(0, offset - 100), offset)
      if (/<(?:b|i|s|u|code|pre|a)\b[^>]*$/.test(before)) return match
      if (/<\/(?:b|i|s|u|code|pre|a)$/.test(before)) return match
      return '&gt;'
    })
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    let splitIdx = remaining.lastIndexOf('\n', limit)
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', limit)
    if (splitIdx <= 0) splitIdx = limit

    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

function isAuthorised(chatId: number): boolean {
  // Open only when unset (first-run bootstrap). This is dangerous on a public bot
  // token — always set ALLOWED_CHAT_ID after /chatid.
  if (!ALLOWED_CHAT_ID) return true
  return String(chatId) === ALLOWED_CHAT_ID
}

// --- File detection & sending ---

// Creative 96K context gauge for the qwen reply footer: 🧠 + color-coded fill bar + %.
// K=1024 so a full window reads 96k/96k. Zones: 🟩<50  🟨<75  🟧<90  🟥>=90 (+⚠️).
function ctxGauge(promptTokens: number): string {
  const MAX = 98304 // 96K loaded context
  const pct = Math.min(100, Math.round((promptTokens / MAX) * 100))
  const k = Math.round(promptTokens / 1024)
  const seg = pct >= 90 ? '🟥' : pct >= 75 ? '🟧' : pct >= 50 ? '🟨' : '🟩'
  const filled = Math.max(1, Math.min(5, Math.round(pct / 20)))
  const bar = seg.repeat(filled) + '⬜'.repeat(5 - filled)
  const warn = pct >= 90 ? ' ⚠️ getting full' : ''
  return `🧠 ${bar} ${k}k/96k (${pct}%)${warn}`
}

const FILE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.csv', '.xlsx', '.docx', '.zip', '.txt', '.json', '.mp3', '.mp4', '.html', '.pptx']

/**
 * Extract file paths from response text and send them as Telegram documents.
 * Returns the response text with file paths cleaned up.
 *
 * For HTML presentations: if a companion `.present-url` sidecar exists (written
 * by build-presentation.py --publish), also send a tappable HTTPS link so any
 * phone/laptop can open the deck in a browser without downloading the file.
 */
async function extractAndSendFiles(
  ctx: Context,
  response: string,
  sinceMs?: number
): Promise<string> {
  // Match absolute paths that point to real files
  // Absolute (POSIX or Windows) or workspace-relative paths the model may mention
  const pathRegex = /(?:^|\s|`)((?:[A-Za-z]:)?[\\/][^\s`]+?\.(?:pdf|png|jpg|jpeg|gif|csv|xlsx|docx|zip|txt|json|mp3|mp4|html|pptx))\b/gi
  const workspaceRegex = /(?:^|\s|`)(workspace[\\/][\w.\\/-]+\.(?:pdf|png|jpg|jpeg|gif|csv|xlsx|docx|zip|txt|json|mp3|mp4|html|pptx))\b/gi

  const filePaths = new Set<string>()
  const presentUrls = new Set<string>()

  // Find absolute paths
  let match
  while ((match = pathRegex.exec(response)) !== null) {
    filePaths.add(match[1])
  }

  // Find workspace-relative paths and resolve them
  while ((match = workspaceRegex.exec(response)) !== null) {
    const resolved = `./${match[1]}`
    filePaths.add(resolved)
  }

  // ALSO send anything written into uploads/ during this turn (mtime >= turn start),
  // even if the model never typed the path in its reply -- it usually doesn't. The
  // user's own incoming file was saved before sinceMs, so it is excluded.
  if (sinceMs) {
    try {
      for (const name of readdirSync(UPLOADS_DIR)) {
        const p = `${UPLOADS_DIR}/${name}`
        try {
          const st = statSync(p)
          if (st.isFile() && st.mtimeMs >= sinceMs) filePaths.add(p)
        } catch { /* ignore unstatable entry */ }
      }
    } catch (err) {
      logger.warn({ err }, 'uploads scan for auto-send failed')
    }
  }

  // Harvest public presentation URLs from sidecars before we skip them as files
  for (const filePath of [...filePaths]) {
    const name = basename(filePath)
    if (name.endsWith('.present-url')) {
      try {
        const url = readFileSync(filePath, 'utf-8').trim()
        if (url.startsWith('http')) presentUrls.add(url)
      } catch { /* ignore */ }
      filePaths.delete(filePath)
      continue
    }
    // Companion sidecar next to an HTML deck
    if (name.endsWith('.html')) {
      const sidecar = `${filePath}.present-url`
      if (existsSync(sidecar)) {
        try {
          const url = readFileSync(sidecar, 'utf-8').trim()
          if (url.startsWith('http')) presentUrls.add(url)
        } catch { /* ignore */ }
      }
    }
  }

  // Also pick up PRESENT_URL= lines the model/tool printed
  for (const m of response.matchAll(/PRESENT_URL=(https?:\/\/\S+)/g)) {
    presentUrls.add(m[1])
  }
  for (const m of response.matchAll(/Open on any device:\s*(https?:\/\/\S+)/gi)) {
    presentUrls.add(m[1])
  }

  // Send tappable open links first (best UX on phone/laptop)
  for (const url of presentUrls) {
    try {
      await ctx.reply(
        `🎞 Open presentation (any device — tap the link):\n${url}\n\nOpens in your browser. Arrows / space to advance.`
      )
      logger.info({ url }, 'Sent presentation open URL')
    } catch (err) {
      logger.error({ err, url }, 'Failed to send presentation URL')
    }
  }

  // Send each file that exists
  for (const filePath of filePaths) {
    if (existsSync(filePath)) {
      try {
        const filename = basename(filePath)
        // Skip non-deliverable internals
        if (filename.endsWith('.present-url')) continue
        const ext = filePath.split('.').pop()?.toLowerCase()

        if (ext && ['png', 'jpg', 'jpeg', 'gif'].includes(ext)) {
          await ctx.api.sendPhoto(ctx.chat!.id, new InputFile(filePath))
        } else {
          await ctx.api.sendDocument(ctx.chat!.id, new InputFile(filePath), {
            caption: filename,
          })
        }
        logger.info({ filePath }, 'Sent file to Telegram')
      } catch (err) {
        logger.error({ err, filePath }, 'Failed to send file to Telegram')
      }
    }
  }

  return response
}

// --- Main message handler ---

async function handleMessage(
  ctx: Context,
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  const chatId = String(ctx.chat!.id)

  if (!isAuthorised(ctx.chat!.id)) {
    await ctx.reply('Unauthorized. Use /chatid to get your ID and add it to .env')
    return
  }

  // Passthrough / device-transfer mode — never process, never memorize.
  if (isIgnoreMode(chatId)) {
    logger.info({ chatId, msgLen: rawText.length }, 'Ignoring message (ignore mode)')
    return
  }

  // Auto-route complex tasks to Claude Code regardless of active model
  const FORCE_CLAUDE_PATTERNS = [
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)\S+/i, // YouTube URLs
  ]
  const forceClaudeCode = FORCE_CLAUDE_PATTERNS.some((p) => p.test(rawText))

  const model = forceClaudeCode ? 'claude' : (activeModel.get(chatId) ?? 'claude')
  const startTime = Date.now()
  // One mode decision per turn (shared by primary path + any escalation fallback)
  const memMode = takeMemoryInjectMode(chatId)
  const memoryContext = await buildMemoryContext(chatId, rawText, { mode: memMode })

  // Start typing indicator
  const sendTyping = () => {
    ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {})
  }

  let response: string | null

  if (model === 'ollama') {
    // Ollama path -- direct LLM with optional tool calling
    const ollamaModelName = getOllamaModel(chatId)
    logger.info({ chatId, msgLen: rawText.length, model: ollamaModelName, memMode }, 'Processing via Ollama')

    // Keep typing indicator alive throughout
    const typingInterval = setInterval(sendTyping, TYPING_REFRESH_MS)

    try {
      const result = await queryOllama(chatId, rawText, sendTyping)
      let ollamaResponse = result.text
      const footer: string[] = []

      // Check for explicit escalation request from the model
      if (ollamaResponse.startsWith('__ESCALATE__')) {
        clearInterval(typingInterval)
        let escReason = 'Model requested escalation'
        try {
          const escData = JSON.parse(ollamaResponse.replace('__ESCALATE__', ''))
          escReason = escData.reason || escReason
        } catch {}

        logger.info({ chatId, reason: escReason }, 'Ollama explicitly escalated to Claude')

        await ctx.api.sendMessage(
          ctx.chat!.id,
          `[Escalating: ${escReason}]`
        )

        const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText
        const sessionId = getSession(chatId)

        const typingInterval2 = setInterval(sendTyping, TYPING_REFRESH_MS)
        try {
          const claudeModelId = getClaudeModel(chatId)
          const { text, newSessionId, sessionDropped } = await runAgent(fullMessage, sessionId, sendTyping, claudeModelId)
          if (sessionDropped) clearSession(chatId)
          if (newSessionId) setSession(chatId, newSessionId)
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          response = (text ?? '(no response)') + `\n\n[Escalated from ${getOllamaModel(chatId)} -- ${elapsed}s]`
        } finally {
          clearInterval(typingInterval2)
        }
        // Escalation handled -- skip normal confidence scoring
      } else {
        // Normal (non-escalated) response path

        // Tool audit trail
        if (result.toolLog.length > 0) {
          footer.push('[Tools used]')
          footer.push(...result.toolLog.map((l) => `  ${l}`))
        }

        // Confidence scoring
        const confidence = await evaluateConfidence(chatId, rawText, ollamaResponse)
        const threshold = getConfidenceThreshold()

        logger.info(
          { chatId, score: confidence.score, reason: confidence.reason, threshold },
          'Confidence evaluation'
        )

        if (confidence.score >= threshold) {
          // Ollama response is confident enough -- use it
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          const usedEndpoint = result.usedEndpoint ?? getActiveEndpoint(chatId)
          footer.push(`[${usedEndpoint}/${ollamaModelName} -- confidence: ${confidence.score}% -- ${elapsed}s]`)
          if (result.fellBack) {
            footer.push(`[Fallback: primary endpoint was unreachable]`)
          }
          response = ollamaResponse + (footer.length ? '\n\n' + footer.join('\n') : '')
        } else {
        // Below threshold -- escalate to Claude Code
        logger.info(
          { chatId, score: confidence.score },
          'Confidence below threshold, escalating to Claude'
        )

        clearInterval(typingInterval)

        // Notify user of escalation
        await ctx.api.sendMessage(
          ctx.chat!.id,
          `[Ollama confidence: ${confidence.score}% -- ${confidence.reason}]\n[Escalating to Claude Code...]`
        )

        // Run through Claude Code instead
        const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText
        const sessionId = getSession(chatId)

        const typingInterval2 = setInterval(sendTyping, TYPING_REFRESH_MS)
        try {
          const claudeModelId = getClaudeModel(chatId)
          const { text, newSessionId, sessionDropped } = await runAgent(fullMessage, sessionId, sendTyping, claudeModelId)
          if (sessionDropped) clearSession(chatId)
          if (newSessionId) setSession(chatId, newSessionId)
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          response = (text ?? '(no response)') + `\n\n[Escalated from ${ollamaModelName} (${confidence.score}%) to ${getClaudeModelLabel(chatId)} -- ${elapsed}s]`
        } finally {
          clearInterval(typingInterval2)
        }
      }
      } // close outer else (non-escalated path)
    } catch (err) {
      if (err instanceof AllEndpointsDownError) {
        // All Ollama endpoints failed -- escalate to Claude Code
        clearInterval(typingInterval)

        logger.warn({ chatId, error: (err as Error).message }, 'All Ollama endpoints down, escalating to Claude')

        await ctx.api.sendMessage(
          ctx.chat!.id,
          '[All Ollama endpoints unreachable -- escalating to Claude Code...]'
        )

        const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText
        const sessionId = getSession(chatId)

        const typingInterval2 = setInterval(sendTyping, TYPING_REFRESH_MS)
        try {
          const claudeModelId = getClaudeModel(chatId)
          const { text, newSessionId, sessionDropped } = await runAgent(fullMessage, sessionId, sendTyping, claudeModelId)
          if (sessionDropped) clearSession(chatId)
          if (newSessionId) setSession(chatId, newSessionId)
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          response = (text ?? '(no response)') + `\n\n[Escalated: Ollama unreachable -- ${getClaudeModelLabel(chatId)} -- ${elapsed}s]`
        } finally {
          clearInterval(typingInterval2)
        }
      } else {
        response = `Ollama error: ${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      clearInterval(typingInterval)
    }
  } else if (model === 'grok') {
    // Grok (xAI) — OpenAI-compatible API; tools shared with PersonalOS Qwen path
    const grokModel = getGrokModel(chatId)
    logger.info({ chatId, msgLen: rawText.length, model: grokModel, memMode }, 'Processing via Grok')

    const typingInterval = setInterval(sendTyping, TYPING_REFRESH_MS)
    const progress = createTelegramProgress(
      {
        sendMessage: (id, text) => ctx.api.sendMessage(id, text),
        editMessageText: (id, mid, text) =>
          ctx.api.editMessageText(id, mid, text),
        deleteMessage: (id, mid) => ctx.api.deleteMessage(id, mid),
      },
      ctx.chat!.id,
      `grok/${grokModel}`
    )
    try {
      const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText
      const grokResponse = await queryGrok(chatId, fullMessage, sendTyping, {
        locked: isModelLocked(chatId),
        onProgress: (u) => progress.report(u),
      })

      if (grokResponse.startsWith(LM_ESCALATION_PREFIX) || grokResponse.startsWith('__ESCALATE__')) {
        let escReason = 'Model requested escalation'
        try {
          const raw = grokResponse.replace(LM_ESCALATION_PREFIX, '').replace('__ESCALATE__', '')
          const escData = JSON.parse(raw)
          escReason = escData.reason || escReason
        } catch { /* ignore */ }

        if (isModelLocked(chatId)) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          response = `⚠️ Grok wanted to escalate (${escReason}) but you're locked. Use /unlock.\n\n[grok/${grokModel} 🔒 -- ${elapsed}s]`
        } else {
          logger.info({ chatId, reason: escReason }, 'Grok escalated to Claude')
          await ctx.api.sendMessage(ctx.chat!.id, `[Escalating: ${escReason}]`)
          const sessionId = getSession(chatId)
          const claudeModelId = getClaudeModel(chatId)
          const { text, newSessionId, sessionDropped } = await runAgent(
            fullMessage,
            sessionId,
            sendTyping,
            claudeModelId
          )
          if (sessionDropped) clearSession(chatId)
          if (newSessionId) setSession(chatId, newSessionId)
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          response =
            (text ?? '(no response)') +
            `\n\n[Escalated from grok/${grokModel} -- ${getClaudeModelLabel(chatId)} -- ${elapsed}s]`
        }
      } else {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        const lockTag = isModelLocked(chatId) ? ' 🔒' : ''
        response = `${grokResponse}\n\n[grok/${grokModel}${lockTag} -- ${elapsed}s]`
      }
      await progress.finish('done')
    } catch (err) {
      logger.error({ err, chatId }, 'Grok query failed')
      await progress.finish('error')
      if (isModelLocked(chatId)) {
        response = `⚠️ Grok failed and you're locked to it. Use /unlock to allow Claude fallback.\n${err instanceof Error ? err.message : String(err)}`
      } else {
        await ctx.api.sendMessage(
          ctx.chat!.id,
          `[Grok error: ${err instanceof Error ? err.message : String(err)}]\n[Falling back to Claude...]`
        )
        const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText
        const sessionId = getSession(chatId)
        const claudeModelId = getClaudeModel(chatId)
        const { text, newSessionId, sessionDropped } = await runAgent(
          fullMessage,
          sessionId,
          sendTyping,
          claudeModelId
        )
        if (sessionDropped) clearSession(chatId)
        if (newSessionId) setSession(chatId, newSessionId)
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        response =
          (text ?? '(no response)') +
          `\n\n[Escalated: Grok error -- ${getClaudeModelLabel(chatId)} -- ${elapsed}s]`
      }
    } finally {
      clearInterval(typingInterval)
      await progress.finish('abort').catch(() => {})
    }
  } else if (model === 'lmstudio') {
    // LM Studio path -- Qwen on your LM Studio host
    const lmModel = getLMStudioModel(chatId)
    logger.info({ chatId, msgLen: rawText.length, model: lmModel, memMode }, 'Processing via LM Studio')

    const typingInterval = setInterval(sendTyping, TYPING_REFRESH_MS)

    // Register abort controller so queueMessage() can interrupt this generation
    const abortCtrl = new AbortController()
    activeGenerations.set(chatId, { controller: abortCtrl, startedAt: Date.now() })

    const progress = createTelegramProgress(
      {
        sendMessage: (id, text) => ctx.api.sendMessage(id, text),
        editMessageText: (id, mid, text) =>
          ctx.api.editMessageText(id, mid, text),
        deleteMessage: (id, mid) => ctx.api.deleteMessage(id, mid),
      },
      ctx.chat!.id,
      `qwen/${lmModel}`
    )

    try {
      const lmContextPreamble = pendingLMContextInject.get(chatId) ?? ''
      if (lmContextPreamble) pendingLMContextInject.delete(chatId)
      const lmMessage = memoryContext
        ? `${lmContextPreamble}${memoryContext}\n\n${rawText}`
        : lmContextPreamble
          ? `${lmContextPreamble}${rawText}`
          : rawText
      const lmResponse = await queryLMStudio(chatId, lmMessage, rawText, sendTyping, async (aheadOf) => {
        progress.report({ phase: 'queued', detail: aheadOf })
        await ctx.api.sendMessage(ctx.chat!.id, `⏳ Queued behind: ${aheadOf}`)
      }, abortCtrl.signal, {
        locked: isModelLocked(chatId),
        holderLabel: 'your previous message',
        onProgress: (u) => progress.report(u),
      })

      // Check if Qwen requested escalation to Claude
      if (lmResponse.startsWith(LM_ESCALATION_PREFIX)) {
        let escReason = 'Model requested escalation'
        try {
          const escData = JSON.parse(lmResponse.replace(LM_ESCALATION_PREFIX, ''))
          escReason = escData.reason || escReason
        } catch {}

        if (isModelLocked(chatId)) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          response = `⚠️ Model wanted to escalate (${escReason}) but you're locked to ${lmModel}. Use /unlock to allow fallback.\n\n[lmstudio/${lmModel} 🔒 -- ${elapsed}s]`
        } else {
        logger.info({ chatId, reason: escReason }, 'LM Studio escalated to Claude')
        await ctx.api.sendMessage(ctx.chat!.id, `[Escalating: ${escReason}]`)

        const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText
        const sessionId = getSession(chatId)
        const claudeModelId = getClaudeModel(chatId)
        const { text, newSessionId, sessionDropped } = await runAgent(fullMessage, sessionId, sendTyping, claudeModelId)
        if (sessionDropped) clearSession(chatId)
        if (newSessionId) setSession(chatId, newSessionId)
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        response = (text ?? '(no response)') + `\n\n[Escalated from ${lmModel} -- ${getClaudeModelLabel(chatId)} -- ${elapsed}s]`
        } // end !isModelLocked escalation
      } else {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        const lockTag = isModelLocked(chatId) ? ' 🔒' : ''
        // Creative context gauge on its own line (color bar + % + ⚠️). 0 = not measured yet.
        const ctxTokens = getSessionContextTokens(chatId)
        const gauge = ctxTokens > 0 ? `\n${ctxGauge(ctxTokens)}` : ''
        response = `${lmResponse}\n\n[lmstudio/${lmModel}${lockTag} -- ${elapsed}s]${gauge}`
      }
      await progress.finish('done')
    } catch (err) {
      // If we were interrupted by a new message, discard silently (fireBatch will re-run)
      if (err instanceof Error && err.name === 'AbortError') {
        logger.info({ chatId }, 'LM Studio generation aborted by interrupt — discarding partial response')
        await progress.finish('abort')
        return
      }
      logger.error({ err, chatId }, 'LM Studio query failed')
      await progress.finish('error')
      // Differentiate timeout from actual unreachability -- the box may be fully up
      // and a single long tool-loop just exceeded its per-loop budget.
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('aborted due to timeout'))
      if (isModelLocked(chatId)) {
        response = isTimeout
          ? `⏱️ ${lmModel} timed out on this tool loop. You're locked to this model. Use /unlock to allow Claude fallback, or try again with a simpler prompt.`
          : `⚠️ ${lmModel} is unreachable. You're locked to this model. Use /unlock to allow fallback, or try again.`
      } else {
      // Fallback to Claude on error
      await ctx.api.sendMessage(
        ctx.chat!.id,
        `[LM Studio ${isTimeout ? 'timed out' : 'error'}: ${err instanceof Error ? err.message : String(err)}]\n[Falling back to Claude...]`
      )

      const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText
      const sessionId = getSession(chatId)
      const claudeModelId = getClaudeModel(chatId)
      const { text, newSessionId, sessionDropped } = await runAgent(fullMessage, sessionId, sendTyping, claudeModelId)
      if (sessionDropped) clearSession(chatId)
      if (newSessionId) setSession(chatId, newSessionId)
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const reason = isTimeout ? 'LM Studio timed out' : 'LM Studio unreachable'
      response = (text ?? '(no response)') + `\n\n[Escalated: ${reason} -- ${getClaudeModelLabel(chatId)} -- ${elapsed}s]`
      } // end !isModelLocked error fallback
    } finally {
      activeGenerations.delete(chatId)
      clearInterval(typingInterval)
      await progress.finish('abort').catch(() => {})
    }
  } else {
    // Claude Code path -- full tooling
    // Consume any pending context preamble (set when switching back to Claude from another provider)
    const contextPreamble = pendingContextInject.get(chatId) ?? ''
    if (contextPreamble) pendingContextInject.delete(chatId)
    const fullMessage = memoryContext
      ? `${contextPreamble}${memoryContext}\n\n${rawText}`
      : contextPreamble
        ? `${contextPreamble}${rawText}`
        : rawText

    const sessionId = getSession(chatId)

    const claudeModelId = getClaudeModel(chatId)
    logger.info({ chatId, msgLen: rawText.length, model: claudeModelId, memMode }, 'Processing via Claude Code')

    const { text, newSessionId, sessionDropped } = await runAgent(
      fullMessage,
      sessionId,
      sendTyping,
      claudeModelId
    )

    if (sessionDropped) clearSession(chatId)
    if (newSessionId) {
      setSession(chatId, newSessionId)
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    response = text ? `${text}\n\n[${getClaudeModelLabel(chatId)} -- ${elapsed}s]` : text
  }

  if (!response) {
    await ctx.reply('(no response)')
    return
  }

  // Save to memory
  await saveConversationTurn(chatId, rawText, response)


  // Update the shared cross-provider turn buffer so a newly-switched model can see context
  pushSharedTurn(chatId, 'user', rawText)
  // Strip footer lines like [opus -- 3.2s] before storing so they don't confuse other models
  const responseBody = response.replace(/\n\n\[.*?\]\s*$/s, '').trim()
  pushSharedTurn(chatId, 'assistant', responseBody)

  // Persist cross-provider turn to SQLite so context survives restarts and is
  // available to other models on switch. Skip if Qwen's queryLMStudio already
  // logged it (it logs only when it produces a non-fallback answer) to avoid
  // duplicate rows.
  if (responseBody && model !== 'lmstudio') {
    try {
      const modelLabel =
        model === 'ollama' ? getOllamaModel(chatId)
        : model === 'grok' ? `grok/${getGrokModel(chatId)}`
        : getClaudeModelLabel(chatId)
      logConversationTurn(chatId, rawText, responseBody, modelLabel)
    } catch (logErr) {
      logger.warn({ err: logErr, chatId }, 'logConversationTurn failed')
    }
  }


  // Extract and send any files referenced in the response, plus anything written
  // into uploads/ during this turn (robust even if the model didn't print the path).
  await extractAndSendFiles(ctx, response, startTime)

  // Voice mode: synthesize the response body and send as Telegram voice. We
  // still send the text version so links/file refs remain copyable. The voice
  // pill leads so it shows up first on mobile lock screens.
  //
  // Only the explicit /voice toggle gates TTS. `forceVoiceReply` (passed by
  // the message:voice handler) used to OR into this, which meant any voice
  // note the user sent would trigger a voice reply regardless of the toggle —
  // breaking the "off by default" contract.
  const shouldVoiceReply = voiceMode.has(chatId) && ttsAvailable()
  if (shouldVoiceReply && responseBody) {
    try {
      const oggPath = await synthesizeVoice(responseBody)
      if (oggPath) {
        try {
          await ctx.api.sendVoice(ctx.chat!.id, new InputFile(oggPath))
        } finally {
          cleanupTtsFile(oggPath)
        }
      }
    } catch (err) {
      logger.warn({ err }, 'TTS send failed, falling back to text only')
    }
  }

  // Send response
  const formatted = formatForTelegram(response)
  const chunks = splitMessage(formatted)

  for (const chunk of chunks) {
    try {
      await ctx.api.sendMessage(ctx.chat!.id, chunk, { parse_mode: 'HTML' })
    } catch (err) {
      // Fallback to plain text if HTML parsing fails
      logger.warn({ err }, 'HTML send failed, falling back to plain text')
      await ctx.api.sendMessage(ctx.chat!.id, chunk.replace(/<[^>]+>/g, ''))
    }
  }
}

// --- Bot creation ---

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is not set. Run `npm run setup` or add it to .env'
    )
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN)
  botInstanceForNotify = bot

  // Load persisted settings
  loadVoiceModes()
  loadPersistedModels()

  // Commands
  bot.command('start', async (ctx) => {
    await ctx.reply(
      'PersonalOS is online. Send me a message and I\'ll run it through Claude Code on your machine.'
    )
  })

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Your chat ID: <code>${ctx.chat.id}</code>`, {
      parse_mode: 'HTML',
    })
  })

  // Google / Gmail auth status + force refresh
  bot.command('gmailauth', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    const arg = (ctx.message?.text ?? '').replace(/^\/gmailauth(@\w+)?\s*/i, '').trim().toLowerCase()
    const account = (arg === 'work' ? 'work' : 'personal') as AccountName

    if (arg === 'status' || arg === 'check') {
      const results = await refreshAllGoogleAccounts()
      const lines = results.map((r) => {
        if (r.ok) return `✅ ${r.account}: OK (access until ${r.accessExpiresAt ?? '?'})`
        if (r.needsReauth) return `❌ ${r.account}: needs re-auth — /gmailauth ${r.account}\n   ${r.error ?? ''}`
        return `⚠️ ${r.account}: ${r.error ?? 'error'}`
      })
      await ctx.reply(
        `Google auth status:\n${lines.join('\n')}\n\n` +
        `If tokens die every ~7 days: Google Cloud Console → OAuth consent screen → **Publish to Production**.\n` +
        `Redirect URI for Telegram login:\n${getGoogleFunnelRedirectUri()}`
      )
      return
    }

    // Start consent flow (Funnel callback)
    try {
      const { url, redirectUri, account: acc, email } = createGoogleAuthUrl(account, chatId)
      await ctx.reply(
        `Google login for "${acc}" → must be ${email}\n\n` +
        `1) Tap this short link (don't copy-paste fragments):\n${url}\n\n` +
        `2) On Google, pick ${email} (not your other Google account)\n` +
        `3) Approve → you'll get ✅ here\n\n` +
        `If you still see redirect_uri_mismatch, add this in Google Cloud → Credentials → Authorized redirect URIs:\n` +
        `${redirectUri}\n\n` +
        `Tip: open the link in a private window if Brave keeps using the wrong profile.`
      )
    } catch (err) {
      await ctx.reply(`Could not start Google auth: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  bot.command('gmailstatus', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const results = await refreshAllGoogleAccounts()
    const lines = results.map((r) =>
      r.ok
        ? `✅ ${r.account}: OK until ${r.accessExpiresAt ?? '?'}`
        : `❌ ${r.account}: ${r.needsReauth ? 're-auth needed' : r.error} → /gmailauth ${r.account}`
    )
    await ctx.reply(lines.join('\n'))
  })

  // Grok monthly-plan OAuth status + force refresh
  bot.command('grokauth', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const snap = getGrokAuthSnapshot()
    const r = await refreshGrokAccessToken(true)
    const snap2 = getGrokAuthSnapshot()
    const lines = [
      `Grok auth: ${describeXaiAuth()}`,
      `Access token: ${snap2.hasAccess ? 'yes' : 'no'}`,
      `Refresh token: ${snap2.hasRefresh ? 'yes (auto-refresh every ~6h)' : 'no — run /groklogin'}`,
      snap2.expiresAt ? `Expires: ${snap2.expiresAt}` : '',
      snap2.minutesLeft != null ? `Minutes left: ${snap2.minutesLeft}` : '',
      r.ok
        ? (r.skipped ? 'Refresh: skipped (still valid)' : 'Refresh: OK — new access token saved')
        : `Refresh failed: ${r.error}`,
      '',
      'Auto-refresh runs before Grok calls when <5 min left, and on HTTP 401.',
      'Commands: /groklogin · /model grok',
    ].filter(Boolean)
    await ctx.reply(lines.join('\n'))
  })

  // Telegram device-code login for monthly plan (no API key)
  bot.command('groklogin', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    await ctx.reply('Starting Grok plan login…')
    const started = await startGrokDeviceLogin(chatId)
    if (!started.ok) {
      await ctx.reply(`Login start failed: ${started.error}`)
      return
    }
    const link = started.verificationUriComplete || started.verificationUri
    await ctx.reply(
      `Sign in with your Grok monthly plan:\n\n` +
      `1) Open: ${link}\n` +
      `2) Code: ${started.userCode}\n\n` +
      `I'll wait up to ${Math.round(started.expiresIn / 60)} minutes and confirm when done.`
    )
    // Poll in background so Telegram doesn't time out the command handler
    void (async () => {
      const result = await pollGrokDeviceLoginUntilDone(chatId)
      if (result.ok) {
        await ctx.reply(
          `Grok login OK.\n` +
          (result.expiresAt ? `Access token until: ${result.expiresAt}\n` : '') +
          `Refresh token stored — PersonalOS will auto-refresh every ~6h.\n` +
          `Switch: /model grok`
        )
      } else {
        await ctx.reply(`Grok login failed: ${result.error}`)
      }
    })()
  })

  bot.command('newchat', async (ctx) => {
    const chatId = String(ctx.chat.id)
    clearSession(chatId)
    clearOllamaHistory(chatId)
    clearGrokHistory(chatId)
    clearLMStudioHistory(chatId)
    clearSharedTurns(chatId)
    pendingContextInject.delete(chatId)
    pendingLMContextInject.delete(chatId)
    markSessionFresh(chatId)
    await ctx.reply(sessionClearedMessage(chatId))
  })

  // /ignore — device-to-device transfer mode. Bot fully ignores non-command messages.
  // /ignore alone → toggle ON until /listen
  // /ignore <text> → swallow this payload only (no reply, no memory)
  bot.command('ignore', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    const arg = (ctx.message?.text ?? '').replace(/^\/ignore(@\S+)?\s*/i, '').trim()
    if (arg) {
      logger.info({ chatId, len: arg.length }, 'One-shot ignore (transfer payload)')
      // Completely silent — no ack, no memory, no model
      return
    }
    ignoreMode.add(chatId)
    setSetting(chatId, 'ignore_mode', '1')
    await ctx.reply(
      'Ignore mode ON.\n' +
      'Messages (and media) are not processed — good for pasting/transferring between devices.\n' +
      'Commands still work. Send /listen to resume.'
    )
  })

  bot.command('listen', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    ignoreMode.delete(chatId)
    setSetting(chatId, 'ignore_mode', '0')
    await ctx.reply('Listening again. PersonalOS will process messages.')
  })

  bot.command('unignore', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    ignoreMode.delete(chatId)
    setSetting(chatId, 'ignore_mode', '0')
    await ctx.reply('Listening again. PersonalOS will process messages.')
  })

  bot.command('lock', async (ctx) => {
    const chatId = String(ctx.chat!.id)
    const model = activeModel.get(chatId) ?? 'claude'
    if (model === 'claude') {
      await ctx.reply('Nothing to lock — already on Claude. Switch to /model qwen or /model grok first.')
      return
    }
    modelLocked.add(chatId)
    setSetting(chatId, 'model_locked', '1')
    const label =
      model === 'lmstudio' ? getLMStudioStatus(chatId)
      : model === 'grok' ? getGrokStatus(chatId)
      : `ollama/${getOllamaModel(chatId)}`
    await ctx.reply(`🔒 Locked to ${label}. No fallback to Claude. Use /unlock to release.`)
  })

  bot.command('unlock', async (ctx) => {
    const chatId = String(ctx.chat!.id)
    modelLocked.delete(chatId)
    setSetting(chatId, 'model_locked', '0')
    await ctx.reply('🔓 Unlocked. Fallback to Claude enabled.')
  })

  // /btw <text> -- queue text to run after the current turn finishes.
  // Never interrupts. Use for "oh and also..." follow-ups.
  bot.command('btw', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const arg = (ctx.message?.text ?? '').replace(/^\/btw(@\S+)?\s*/, '').trim()
    queueBtw(ctx, arg)
  })

  bot.command('forget', async (ctx) => {
    const chatId = String(ctx.chat.id)
    clearSession(chatId)
    clearOllamaHistory(chatId)
    clearGrokHistory(chatId)
    clearLMStudioHistory(chatId)
    clearSharedTurns(chatId)
    pendingContextInject.delete(chatId)
    pendingLMContextInject.delete(chatId)
    markSessionFresh(chatId)
    await ctx.reply(sessionClearedMessage(chatId))
  })

  bot.command('memory', async (ctx) => {
    const count = getMemoryCount(String(ctx.chat.id))
    await ctx.reply(`You have ${count} memories stored.`)
  })

  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat.id)
    const { stt } = voiceCapabilities()
    if (!stt) {
      await ctx.reply('Voice STT is not configured.')
      return
    }
    if (voiceMode.has(chatId)) {
      voiceMode.delete(chatId)
      deleteSetting(chatId, 'voice_mode')
      await ctx.reply('Voice mode disabled. Replies will be text only.')
    } else {
      voiceMode.add(chatId)
      setSetting(chatId, 'voice_mode', '1')
      const ttsNote = ttsAvailable()
        ? ' Replies will come as voice messages plus the text transcript.'
        : ' (TTS unavailable on this host — replies stay text-only.)'
      await ctx.reply(`Voice mode enabled.${ttsNote}`)
    }
  })

  // Model switching
  bot.command('model', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    const arg = (ctx.message?.text ?? '').replace('/model', '').trim()

    if (!arg) {
      const current = activeModel.get(chatId) ?? 'claude'
      let status: string
      if (current === 'ollama') status = getOllamaStatus(chatId)
      else if (current === 'lmstudio') status = getLMStudioStatus(chatId)
      else if (current === 'grok') status = getGrokStatus(chatId)
      else status = `Claude Code (${getClaudeModelLabel(chatId)})`
      await ctx.reply(
        `Active: ${status}\n\n` +
        'Shortcuts (Claude aliases always track latest):\n' +
        `${CLAUDE_MODEL_HELP}\n` +
        `/model grok -- Grok (xAI API / Grok CLI OAuth)\n` +
        `/model grok <id> -- pick a Grok model id (see /models grok)\n` +
        `/model lmstudio -- local/remote LM Studio or LiteLLM\n` +
        `/model qwen -- same as lmstudio\n` +
        `/model local -- Ollama on this machine\n` +
        `/model infinity -- Ollama on mini-infinity\n` +
        `/model infinity qwen3:32b -- endpoint + model\n` +
        `/models -- list models on current endpoint\n` +
        `/models grok -- list xAI models\n` +
        `/tools -- toggle tool calling for Ollama\n` +
        `/endpoints -- manage endpoints & fallback`
      )
      return
    }

    // Grok (xAI) shortcut
    const lowerArg = arg.toLowerCase()
    if (lowerArg === 'grok' || lowerArg.startsWith('grok ') || lowerArg.startsWith('xai')) {
      const available = await isGrokAvailable()
      if (!available) {
        await ctx.reply(
          'Grok not reachable (monthly plan OAuth).\n\n' +
          'Send /groklogin to authenticate from Telegram, or on the machine: grok login --oauth\n\n' +
          `Current: ${describeXaiAuth()}`
        )
        return
      }
      activeModel.set(chatId, 'grok')
      setSetting(chatId, 'active_model', 'grok')
      clearGrokHistory(chatId)
      const modelArg = arg.replace(/^(grok|xai)\s*/i, '').trim()
      if (modelArg) setGrokModel(chatId, modelArg)
      await ctx.reply(`Switched to Grok: ${getGrokStatus(chatId)}`)
      return
    }

    // LM Studio shortcut
    if (lowerArg === 'lmstudio' || lowerArg === 'qwen' || lowerArg === 'macstudio') {
      const available = await isLMStudioAvailable()
      if (!available) {
        await ctx.reply('LM Studio not reachable. Is LMSTUDIO_URL set and the server running?')
        return
      }
      activeModel.set(chatId, 'lmstudio')
      setSetting(chatId, 'active_model', 'lmstudio')
      // Clear LM Studio history and inject prior context as a preamble on the
      // first message — avoids seeding 10 separate history messages that trip
      // Qwen's Jinja template with "No user query found in messages."
      clearLMStudioHistory(chatId)
      const priorTurnsForLM = getSharedTurns(chatId)
      if (priorTurnsForLM.length > 0) {
        pendingLMContextInject.set(chatId, buildContextPreamble(priorTurnsForLM))
      }

      // Allow model override: /model lmstudio qwen3.5-14b
      const modelArg = arg.replace(/^(lmstudio|qwen|macstudio)\s*/i, '').trim()
      if (modelArg) {
        setLMStudioModel(chatId, modelArg)
      }

      await ctx.reply(`Switched to LM Studio: ${getLMStudioStatus(chatId)}`)
      return
    }

    // Claude model shortcuts
    if (lowerArg === 'claude' || CLAUDE_SHORTCUTS[lowerArg]) {
      const prevModel = activeModel.get(chatId)
      activeModel.set(chatId, 'claude')
      setSetting(chatId, 'active_model', 'claude')
      if (CLAUDE_SHORTCUTS[lowerArg]) {
        const family = CLAUDE_SHORTCUTS[lowerArg]
        claudeModel.set(chatId, family)
        setSetting(chatId, 'claude_model', family)
      }
      // If coming from another provider, schedule a context preamble for the next Claude message
      if (prevModel && prevModel !== 'claude') {
        const priorTurns = getSharedTurns(chatId)
        if (priorTurns.length > 0) {
          pendingContextInject.set(chatId, buildContextPreamble(priorTurns))
        }
      }
      await ctx.reply(`Switched to Claude Code (${getClaudeModelLabel(chatId)})`+'.')
      return
    }

    // Parse: endpoint name directly, or endpoint + model
    // e.g. "infinity", "local", "infinity qwen3:32b", "ollama@infinity qwen3:32b"
    let input = arg.toLowerCase()

    // Strip optional "ollama" or "ollama@" prefix for backwards compat
    input = input.replace(/^ollama@?/i, '')

    const spaceIdx = input.indexOf(' ')
    let endpointName: string
    let modelName: string | undefined

    if (spaceIdx > 0) {
      endpointName = input.slice(0, spaceIdx)
      modelName = arg.slice(arg.indexOf(' ') + 1).trim() // preserve original case for model name
    } else {
      endpointName = input
    }

    // Check if it's a known endpoint
    const endpoints = getEndpointNames()
    if (!endpoints.includes(endpointName)) {
      await ctx.reply(`Unknown: ${endpointName}\nAvailable: claude, ${endpoints.join(', ')}`)
      return
    }

    setActiveEndpoint(chatId, endpointName)

    // Check reachability
    const available = await isOllamaAvailable(undefined, chatId)
    if (!available) {
      await ctx.reply(`Ollama not reachable at ${endpointName}. Is it running?`)
      return
    }

    activeModel.set(chatId, 'ollama')
    setSetting(chatId, 'active_model', 'ollama')
    // Clear and re-seed Ollama history with recent shared turns so the new
    // model can see what the previous model (e.g. Claude) wrote this session.
    clearOllamaHistory(chatId)
    seedOllamaHistory(chatId, getSharedTurns(chatId))

    if (modelName) {
      setOllamaModel(chatId, modelName)
    }

    await ctx.reply(`Switched to Ollama: ${getOllamaStatus(chatId)}`)
  })

  bot.command('models', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    const arg = (ctx.message?.text ?? '').replace('/models', '').trim().toLowerCase()

    // /models grok -- list xAI models
    if (arg === 'grok' || arg === 'xai') {
      const models = await listGrokModels()
      if (models.length === 0) {
        await ctx.reply(`No xAI models (auth: ${describeXaiAuth()}). Set XAI_API_KEY or re-login Grok CLI.`)
        return
      }
      await ctx.reply(
        `Grok models (${describeXaiAuth()}):\n${models.map((m) => `  ${m}`).join('\n')}\n\nSwitch: /model grok <id>`
      )
      return
    }

    // /models lmstudio -- list LM Studio models
    if (arg === 'lmstudio' || arg === 'qwen') {
      const available = await isLMStudioAvailable()
      if (!available) {
        await ctx.reply('LM Studio not reachable. Is LMSTUDIO_URL set and the server running?')
        return
      }
      const models = await listLMStudioModels()
      if (models.length === 0) {
        await ctx.reply('No models loaded in LM Studio.')
        return
      }
      const current = getLMStudioModel(chatId)
      const lines = models.map((m) => `${m === current ? '> ' : '  '}${m}`)
      await ctx.reply(`LM Studio models:\n${lines.join('\n')}\n\nSwitch: /model lmstudio <model>`)
      return
    }

    const endpointName = arg || undefined
    const available = await isOllamaAvailable(endpointName, chatId)
    if (!available) {
      const name = endpointName ?? getActiveEndpoint(chatId)
      await ctx.reply(`Ollama not reachable at ${name}. Is it running?`)
      return
    }

    const models = await listOllamaModels(endpointName, chatId)
    if (models.length === 0) {
      await ctx.reply('No models found. Pull one with: ollama pull qwen3-30b-moe')
      return
    }

    const current = getOllamaModel(chatId)
    const name = endpointName ?? getActiveEndpoint(chatId)
    const lines = models.map((m) => `${m === current ? '> ' : '  '}${m}`)
    await ctx.reply(`Ollama models on ${name}:\n${lines.join('\n')}\n\nSwitch: /model ollama@${name} <model>`)
  })

  // Tools toggle for Ollama
  bot.command('tools', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)

    const current = activeModel.get(chatId) ?? 'claude'
    if (current !== 'ollama') {
      await ctx.reply('Tools toggle is for Ollama mode. Claude Code always has full tools.\nSwitch first: /model ollama')
      return
    }

    const enabled = isToolsEnabled(chatId)
    setToolsEnabled(chatId, !enabled)
    clearOllamaHistory(chatId) // reset so system prompt regenerates with/without tool info
    await ctx.reply(
      !enabled
        ? 'Tools enabled. Ollama can now run bash, read/write files, list directories, and use curl for web lookups.'
        : 'Tools disabled. Ollama is chat-only.'
    )
  })

  // Endpoint management
  bot.command('endpoints', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return

    const text = (ctx.message?.text ?? '').replace('/endpoints', '').trim()
    const parts = text.split(/\s+/)
    const subCmd = parts[0]?.toLowerCase()

    // /endpoints -- show status
    if (!subCmd) {
      const statuses = getEndpointsStatus()
      const cooldown = getCooldownMinutes()
      const lines = statuses.map((s) => {
        const icon = s.health === 'up' ? '🟢' : s.health === 'down' ? '🔴' : '⚪'
        const cd = s.cooldown ? ' (cooldown)' : ''
        const err = s.lastError ? `\n    Error: ${s.lastError}` : ''
        const down = s.downSince ? `\n    Down since: ${s.downSince}` : ''
        return `${s.priority}. ${icon} ${s.name} -- ${s.url}${cd}${down}${err}`
      })
      await ctx.reply(
        `Endpoints (priority order):\n${lines.join('\n')}\n\nCooldown: ${cooldown}min\n\n` +
        'Commands:\n' +
        '/endpoints check -- health check all\n' +
        '/endpoints priority a,b,c -- reorder\n' +
        '/endpoints add <name> <url>\n' +
        '/endpoints remove <name>\n' +
        '/endpoints cooldown <minutes>\n' +
        '/endpoints reset [name] -- clear health state'
      )
      return
    }

    // /endpoints check -- health check all endpoints
    if (subCmd === 'check') {
      const results = await checkAllEndpoints()
      const lines = results.map((r) => `${r.available ? '🟢' : '🔴'} ${r.name}`)
      await ctx.reply(`Health check:\n${lines.join('\n')}`)
      return
    }

    // /endpoints priority a,b,c
    if (subCmd === 'priority') {
      const orderStr = parts.slice(1).join(',')
      const order = orderStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      if (order.length === 0) {
        await ctx.reply(`Current priority: ${getEndpointPriority().join(' > ')}`)
        return
      }
      const result = setEndpointPriority(order)
      if (!result.success) {
        await ctx.reply(`Error: ${result.error}`)
        return
      }
      await ctx.reply(`Priority updated: ${order.join(' > ')}`)
      return
    }

    // /endpoints add <name> <url>
    if (subCmd === 'add') {
      const name = parts[1]
      const url = parts[2]
      if (!name || !url) {
        await ctx.reply('Usage: /endpoints add <name> <url>\nExample: /endpoints add workstation http://192.168.1.50:11434')
        return
      }
      const result = addEndpoint(name, url)
      if (!result.success) {
        await ctx.reply(`Error: ${result.error}`)
        return
      }
      await ctx.reply(`Added endpoint "${name}" (${url})\nPriority: ${getEndpointPriority().join(' > ')}`)
      return
    }

    // /endpoints remove <name>
    if (subCmd === 'remove') {
      const name = parts[1]
      if (!name) {
        await ctx.reply('Usage: /endpoints remove <name>')
        return
      }
      const result = removeEndpoint(name)
      if (!result.success) {
        await ctx.reply(`Error: ${result.error}`)
        return
      }
      await ctx.reply(`Removed endpoint "${name}"\nPriority: ${getEndpointPriority().join(' > ')}`)
      return
    }

    // /endpoints cooldown <minutes>
    if (subCmd === 'cooldown') {
      const minutes = parseInt(parts[1])
      if (isNaN(minutes) || minutes < 0) {
        await ctx.reply(`Current cooldown: ${getCooldownMinutes()} minutes\nUsage: /endpoints cooldown <minutes>`)
        return
      }
      setCooldownMinutes(minutes)
      await ctx.reply(`Cooldown set to ${minutes} minutes`)
      return
    }

    // /endpoints reset [name] -- clear health state
    if (subCmd === 'reset') {
      const name = parts[1]
      resetEndpointHealth(name)
      await ctx.reply(name ? `Reset health for "${name}"` : 'Reset all endpoint health states')
      return
    }

    await ctx.reply('Unknown subcommand. Use /endpoints for help.')
  })

  // /web <task> -- dispatch to local web-agent service (Playwright + Qwen, paranoid approval gate)
  bot.command('web', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const task = (ctx.message?.text ?? '').replace(/^\/web(\s+|$)/, '').trim()
    if (!task) {
      await ctx.reply('Usage: /web <natural-language task>\nExample: /web go to httpbin.org/ip and tell me what IP you see')
      return
    }
    const chatId = String(ctx.chat.id)
    let jobId: string
    try {
      jobId = await createWebTask(task, { kind: 'telegram', channel: chatId })
    } catch (err) {
      await ctx.reply(`web-agent dispatch failed: ${(err as Error).message}`)
      return
    }
    await ctx.reply(`🕸️ web-agent started (job ${jobId})`)
    void pollWebTask(jobId, {
      onText: async (line) => {
        try { await ctx.api.sendMessage(chatId, line.slice(0, 1500)) } catch { /* ignore */ }
      },
      onApproval: async (approvalId, intent, screenshotPath, url) => {
        const text = `⚠️ Approval required\nIntent: ${intent.slice(0, 200)}\nURL: ${url ?? '?'}\n(approval ${approvalId})`
        const kb = {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `web_approve:${jobId}:${approvalId}` },
            { text: '❌ Deny',    callback_data: `web_deny:${jobId}:${approvalId}` },
            { text: '🛑 Cancel',  callback_data: `web_cancel:${jobId}:${approvalId}` },
          ]],
        }
        try { await ctx.api.sendMessage(chatId, text, { reply_markup: kb }) } catch { /* ignore */ }
      },
      onDone: async (status, result) => {
        const icon = status === 'completed' ? '✅' : status === 'cancelled' ? '🛑' : '❌'
        const body = result ? `\n${result.slice(0, 3000)}` : ''
        try { await ctx.api.sendMessage(chatId, `${icon} web-agent ${status}${body}`) } catch { /* ignore */ }
      },
    }).catch(async (err) => {
      try { await ctx.api.sendMessage(chatId, `(poll error: ${(err as Error).message})`) } catch { /* ignore */ }
    })
  })

  // /codex <plan-or-code> -- run the OpenClaw/PersonalOS top-10 checklist via Qwen 397B
  bot.command('codex', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const input = (ctx.message?.text ?? '').replace(/^\/codex(\s+|$)/, '').trim()
    if (!input) {
      await ctx.reply('Usage: /codex <plan, diff, or code to review>\nReviews against the 10-item OpenClaw/PersonalOS pre-flight checklist.')
      return
    }
    await ctx.reply(`🔍 Reviewing (~30-90s, Qwen 397B)...`)
    const result = await reviewWithCodex(input)
    if (!result.ok) {
      await ctx.reply(`Codex review failed: ${result.error}`)
      return
    }
    const icon = result.verdict === 'APPROVED' ? '✅' : result.verdict === 'REVISE' ? '⚠️' : '❓'
    const header = `${icon} **Codex review** (${result.model}, ${Math.round(result.durationMs / 1000)}s) — VERDICT: ${result.verdict}\n\n`
    const body = header + result.body
    // Telegram caps at 4096; chunk if needed
    for (let i = 0; i < body.length; i += 3800) {
      try { await ctx.reply(body.slice(i, i + 3800)) } catch { /* ignore */ }
    }
  })

  bot.callbackQuery(/^web_(approve|deny|cancel):/, async (ctx) => {
    const data = ctx.callbackQuery.data ?? ''
    const match = data.match(/^web_(approve|deny|cancel):([^:]+):(.+)$/)
    if (!match) {
      await ctx.answerCallbackQuery({ text: 'bad callback' })
      return
    }
    const decision = match[1] as 'approve' | 'deny' | 'cancel'
    const jobId = match[2]!
    const approvalId = match[3]!
    try {
      await decideWebApproval(jobId, approvalId, decision)
      await ctx.answerCallbackQuery({ text: `${decision}d` })
      if (ctx.callbackQuery.message) {
        const orig = ('text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '') ?? ''
        const stamped = `${orig}\n\n→ ${decision}d`
        try { await ctx.editMessageText(stamped.slice(0, 4000)) } catch { /* ignore */ }
      }
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `error: ${(err as Error).message.slice(0, 100)}` })
    }
  })

  // Scheduler commands
  if (SCHEDULER_ENABLED) {
    bot.command('schedule', async (ctx) => {
      if (!isAuthorised(ctx.chat.id)) return

      const text = ctx.message?.text ?? ''
      const parts = text.replace('/schedule', '').trim().split(/\s+/)
      const subCmd = parts[0]

      if (!subCmd || subCmd === 'list') {
        const tasks = getAllTasks()
        if (tasks.length === 0) {
          await ctx.reply('No scheduled tasks.')
          return
        }
        const lines = tasks.map((t) => {
          const next = new Date(t.next_run * 1000).toLocaleString()
          const modelLabel = t.model === 'lmstudio' ? 'qwen' : (t.model ?? 'claude')
          return `[${t.status}] ${t.id}: ${t.prompt.slice(0, 40)} (${t.schedule}) [${modelLabel}] next: ${next}`
        })
        await ctx.reply(lines.join('\n'))
        return
      }

      if (subCmd === 'delete' && parts[1]) {
        deleteTask(parts[1])
        await ctx.reply(`Deleted task: ${parts[1]}`)
        return
      }

      if (subCmd === 'pause' && parts[1]) {
        setTaskStatus(parts[1], 'paused')
        await ctx.reply(`Paused task: ${parts[1]}`)
        return
      }

      if (subCmd === 'resume' && parts[1]) {
        setTaskStatus(parts[1], 'active')
        await ctx.reply(`Resumed task: ${parts[1]}`)
        return
      }

      if (subCmd === 'create') {
        // Usage: /schedule create "prompt" "cron" [model]
        const match = text.match(/create\s+"([^"]+)"\s+"([^"]+)"(?:\s+(\S+))?/)
        if (!match) {
          await ctx.reply('Usage: /schedule create "prompt" "cron" [model]\nModels: claude (default), qwen/lmstudio, grok, haiku, sonnet, opus')
          return
        }
        const [, prompt, cron, rawModel] = match
        const model = resolveTaskModel(rawModel) ?? undefined
        const modelLabel =
          model === 'lmstudio' ? 'qwen'
          : model === 'grok' ? 'grok'
          : (model ?? 'claude (latest)')

        try {
          CronExpressionParser.parse(cron)
        } catch {
          await ctx.reply(`Invalid cron: ${cron}`)
          return
        }
        const id = randomUUID().slice(0, 8)
        const nextRun = computeNextRun(cron)
        createTask(id, String(ctx.chat.id), prompt, cron, nextRun, model)
        await ctx.reply(
          `Task ${id} created.\nPrompt: ${prompt}\nSchedule: ${cron}\nModel: ${modelLabel}\nNext: ${new Date(nextRun * 1000).toLocaleString()}`
        )
        return
      }

      await ctx.reply(
        'Usage: /schedule [list|create|delete|pause|resume]\n' +
          'Create: /schedule create "prompt" "cron"\n' +
          'Delete: /schedule delete <id>'
      )
    })
  }

  // WhatsApp commands
  if (WA_ENABLED) {
    bot.command('wa', async (ctx) => {
      if (!isAuthorised(ctx.chat.id)) return
      const result = listRecentChats()
      await ctx.reply(result)
    })
  }

  // Voice notes
  bot.on('message:voice', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    if (isIgnoreMode(String(ctx.chat.id))) {
      logger.info({ chatId: ctx.chat.id }, 'Ignoring voice (ignore mode)')
      return
    }

    const { stt } = voiceCapabilities()
    if (!stt) {
      await ctx.reply('Voice transcription is not configured.')
      return
    }

    try {
      const file = await ctx.getFile()
      const localPath = await downloadMedia(file.file_id, 'voice.oga')

      await ctx.api.sendChatAction(ctx.chat.id, 'typing')
      const transcript = await transcribeAudio(localPath)

      if (!transcript) {
        await ctx.reply('Could not transcribe audio.')
        return
      }

      logger.info({ transcript: transcript.slice(0, 100) }, 'Transcribed voice')
      processMessage(ctx, `[Voice transcribed]: ${transcript}`, true)
    } catch (err) {
      logger.error({ err }, 'Voice processing failed')
      await ctx.reply(`Voice transcription failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // Photos
  bot.on('message:photo', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    if (isIgnoreMode(String(ctx.chat.id))) {
      logger.info({ chatId: ctx.chat.id }, 'Ignoring photo (ignore mode)')
      return
    }

    try {
      const photos = ctx.message!.photo!
      const largest = photos[photos.length - 1]
      const localPath = await downloadMedia(largest.file_id, 'photo.jpg')
      const caption = ctx.message!.caption
      processMessage(ctx, buildPhotoMessage(localPath, caption))
    } catch (err) {
      logger.error({ err }, 'Photo processing failed')
      await ctx.reply('Failed to process photo.')
    }
  })

  // Documents
  bot.on('message:document', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    if (isIgnoreMode(String(ctx.chat.id))) {
      logger.info({ chatId: ctx.chat.id }, 'Ignoring document (ignore mode)')
      return
    }

    try {
      const doc = ctx.message!.document!
      const localPath = await downloadMedia(
        doc.file_id,
        doc.file_name ?? 'document'
      )
      const caption = ctx.message!.caption
      processMessage(
        ctx,
        buildDocumentMessage(localPath, doc.file_name ?? 'document', caption)
      )
    } catch (err) {
      logger.error({ err }, 'Document processing failed')
      await ctx.reply('Failed to process document.')
    }
  })

  // Videos
  bot.on('message:video', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    if (isIgnoreMode(String(ctx.chat.id))) {
      logger.info({ chatId: ctx.chat.id }, 'Ignoring video (ignore mode)')
      return
    }

    try {
      const video = ctx.message!.video!
      const localPath = await downloadMedia(
        video.file_id,
        video.file_name ?? 'video.mp4'
      )
      const caption = ctx.message!.caption
      processMessage(ctx, buildVideoMessage(localPath, caption))
    } catch (err) {
      logger.error({ err }, 'Video processing failed')
      await ctx.reply('Failed to process video.')
    }
  })

  // Stickers, GIFs/animations, audio files, and video notes don't have a real
  // processing path yet, but silent no-ops look like the bot is broken. Reply
  // once so the user knows the message was received but unsupported.
  bot.on('message:sticker', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    if (isIgnoreMode(String(ctx.chat.id))) return
    logger.info({ chatId: ctx.chat.id }, 'Received sticker — no handler')
    await ctx.reply("I received a sticker but can't process that format yet.")
  })

  bot.on('message:animation', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    if (isIgnoreMode(String(ctx.chat.id))) return
    logger.info({ chatId: ctx.chat.id }, 'Received animation — no handler')
    await ctx.reply("I received an animation (GIF) but can't process that format yet.")
  })

  bot.on('message:audio', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    if (isIgnoreMode(String(ctx.chat.id))) return
    logger.info({ chatId: ctx.chat.id }, 'Received audio file — no handler')
    await ctx.reply("I received an audio file but can't process that format yet. (Voice notes do work — try recording instead of attaching.)")
  })

  bot.on('message:video_note', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    if (isIgnoreMode(String(ctx.chat.id))) return
    logger.info({ chatId: ctx.chat.id }, 'Received video note — no handler')
    await ctx.reply("I received a video note (round video) but can't process that format yet.")
  })

  // Text messages (must be last)
  bot.on('message:text', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message.text
    if (text.startsWith('/')) {
      // Unknown slash command — grammY's bot.command() handlers caught everything
      // they know about already. Tell the user rather than silently swallowing.
      logger.info({ chatId: ctx.chat.id, text: text.slice(0, 50) }, 'Unknown slash command')
      await ctx.reply('Unknown command. Try /model, /memory, /newchat, /ignore, /listen, /btw, /voice, /lock, /unlock, /schedule.')
      return
    }

    // Device-transfer mode: swallow everything without a reply
    if (isIgnoreMode(String(ctx.chat.id))) {
      logger.info({ chatId: ctx.chat.id, msgLen: text.length }, 'Ignoring text (ignore mode)')
      return
    }

    // If the user replied to a voice/photo/doc/video, re-fetch and re-process it
    // with his text as the follow-up instruction. Always re-runs, no special
    // "only on prior failure" tracking — simpler and predictable.
    if (await handleMediaReply(ctx, text)) return

    // Text-to-text reply: inject the quoted message so local models see context
    const replied = ctx.message.reply_to_message
    if (replied && (replied.text || replied.caption)) {
      const hasMedia = !!(replied.voice || replied.video_note || replied.photo?.length || replied.document || replied.video)
      if (!hasMedia) {
        const wrapped = buildTextReplyMessage(
          replied.text,
          replied.caption,
          replied.from?.is_bot,
          replied.from?.first_name,
          text,
        )
        if (wrapped) {
          queueMessage(ctx, wrapped)
          return
        }
      }
    }

    queueMessage(ctx, text)
  })

  // Error handler
  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update }, 'Bot error')
  })

  return bot
}

export function getBotSendFn(
  bot: Bot
): (chatId: string, text: string) => Promise<void> {
  return async (chatId: string, text: string) => {
    const formatted = formatForTelegram(text)
    const chunks = splitMessage(formatted)
    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(Number(chatId), chunk, { parse_mode: 'HTML' })
      } catch (err) {
        logger.warn({ err, chatId }, 'HTML send failed, falling back to plain text')
        await bot.api.sendMessage(Number(chatId), chunk.replace(/<[^>]+>/g, ''))
      }
    }
  }
}
