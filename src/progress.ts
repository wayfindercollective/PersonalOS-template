/**
 * Telegram progress feedback for long agent turns.
 *
 * Telegram has no native progress bar — the practical approach is one status
 * message that we edit in place (throttled) with an emoji/block bar + current step.
 * On finish the status message is deleted so the chat stays clean.
 */

export type ProgressPhase =
  | 'start'
  | 'queued'
  | 'thinking'
  | 'tool_start'
  | 'tool_done'
  | 'done'
  | 'error'

export interface ProgressUpdate {
  phase: ProgressPhase
  /** Human label, e.g. model name */
  title?: string
  tool?: string
  detail?: string
  loop?: number
  maxLoops?: number
  toolsDone?: number
}

export type ProgressReporter = {
  report: (u: ProgressUpdate) => void
  finish: (outcome?: 'done' | 'error' | 'abort') => Promise<void>
}

type TelegramApi = {
  sendMessage: (
    chatId: number | string,
    text: string
  ) => Promise<{ message_id: number }>
  editMessageText: (
    chatId: number | string,
    messageId: number,
    text: string
  ) => Promise<unknown>
  deleteMessage: (chatId: number | string, messageId: number) => Promise<unknown>
}

const MIN_EDIT_MS = 1200 // Telegram rate-limit friendly
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** Block progress bar using Unicode blocks (works on mobile Telegram). */
export function progressBar(pct: number, width = 10): string {
  const p = clamp01(pct)
  const filled = Math.round(p * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `0:${String(r).padStart(2, '0')}`
}

function friendlyTool(name: string): string {
  const map: Record<string, string> = {
    bash: 'shell',
    read_file: 'read file',
    write_file: 'write file',
    list_directory: 'list dir',
    create_presentation: 'presentation',
    grounded_search: 'web search',
    web_search: 'web search',
    web_fetch: 'fetch url',
    browse_url: 'browse',
    schedule_task: 'schedule',
    calendar_list_events: 'calendar',
    gmail_search: 'gmail',
    escalate: 'escalate',
  }
  return map[name] ?? name.replace(/_/g, ' ')
}

function estimatePct(state: {
  phase: ProgressPhase
  loop: number
  maxLoops: number
  toolsDone: number
}): number {
  // Soft estimate: tools push the bar; loops add smaller increments. Cap at 95% until done.
  const toolPart = Math.min(0.7, state.toolsDone * 0.12)
  const loopPart = Math.min(0.25, (state.loop / Math.max(1, state.maxLoops)) * 0.25)
  let pct = 0.08 + toolPart + loopPart
  if (state.phase === 'thinking') pct = Math.max(pct, 0.12)
  if (state.phase === 'tool_start') pct = Math.max(pct, 0.15)
  if (state.phase === 'done') return 1
  if (state.phase === 'error') return pct
  return Math.min(0.95, pct)
}

export function createTelegramProgress(
  api: TelegramApi,
  chatId: number | string,
  title = 'PersonalOS'
): ProgressReporter {
  const startedAt = Date.now()
  let messageId: number | null = null
  /** In-flight create — prevents a race that posts two status messages. */
  let createPromise: Promise<void> | null = null
  let spin = 0
  let lastEdit = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let finished = false
  let toolsDone = 0
  let loop = 0
  let maxLoops = 10
  let lastTool = ''
  let phase: ProgressPhase = 'start'
  let detail = ''
  let displayTitle = title

  const render = (): string => {
    const elapsed = formatElapsed(Date.now() - startedAt)
    const pct = estimatePct({ phase, loop, maxLoops, toolsDone })
    const bar = progressBar(pct)
    const pctLabel = `${Math.round(pct * 100)}%`
    const spinChar = SPINNER[spin % SPINNER.length]
    spin++

    // One activity line only — do not also put a spinner on the title line
    // (that looked like "thinking twice" in the chat UI).
    let activity: string
    switch (phase) {
      case 'queued':
        activity = `⏳ queued${detail ? ` · ${detail}` : ''}`
        break
      case 'tool_start':
        activity = `🔧 ${friendlyTool(lastTool || 'tool')}…`
        break
      case 'tool_done':
        activity = `✓ ${friendlyTool(lastTool || 'tool')}`
        break
      case 'thinking':
        activity = `${spinChar} thinking…`
        break
      case 'error':
        activity = `⚠️ ${detail || 'error'}`
        break
      case 'done':
        activity = '✓ done'
        break
      default:
        activity = `${spinChar} working…`
    }

    const meta: string[] = []
    if (toolsDone > 0) meta.push(`${toolsDone} tool${toolsDone === 1 ? '' : 's'}`)
    if (loop > 0) meta.push(`step ${loop}/${maxLoops}`)
    const metaLine = meta.length ? meta.join(' · ') : 'starting'

    // Keep under Telegram message edit limits; plain text, no HTML needed
    return [
      `${displayTitle} · ${elapsed}`,
      `${bar} ${pctLabel}`,
      activity,
      metaLine,
    ].join('\n')
  }

  const ensureMessage = async (): Promise<void> => {
    if (messageId != null || finished) return
    // Coalesce concurrent first reports: start + thinking fire back-to-back
    // from Grok/Qwen before sendMessage resolves; without this lock both
    // send a new status message → two "thinking" cards in Telegram.
    if (createPromise) {
      await createPromise
      return
    }
    createPromise = (async () => {
      try {
        if (messageId != null || finished) return
        const msg = await api.sendMessage(chatId, render())
        messageId = msg.message_id
        lastEdit = Date.now()
      } catch {
        // Non-fatal — progress is best-effort
      } finally {
        createPromise = null
      }
    })()
    await createPromise
  }

  const doEdit = async (force = false): Promise<void> => {
    if (finished) return
    await ensureMessage()
    if (messageId == null || finished) return
    const now = Date.now()
    if (!force && now - lastEdit < MIN_EDIT_MS) return
    try {
      await api.editMessageText(chatId, messageId, render())
      lastEdit = now
    } catch {
      // ignore "message is not modified" and transient edit failures
    }
  }

  const scheduleFlush = (): void => {
    if (flushTimer || finished) return
    const wait = Math.max(0, MIN_EDIT_MS - (Date.now() - lastEdit))
    flushTimer = setTimeout(() => {
      flushTimer = null
      void doEdit(true)
    }, wait)
  }

  const report = (u: ProgressUpdate): void => {
    if (finished) return
    if (u.loop != null) loop = u.loop
    if (u.maxLoops != null) maxLoops = u.maxLoops
    if (u.toolsDone != null) toolsDone = u.toolsDone
    if (u.tool) lastTool = u.tool
    if (u.phase === 'tool_done') toolsDone = Math.max(toolsDone, (u.toolsDone ?? toolsDone + 1))
    phase = u.phase
    if (u.detail) detail = u.detail
    if (u.title) displayTitle = u.title

    // Kick off message creation immediately on first report; always funnel
    // through ensureMessage so concurrent reports share one send.
    if (messageId == null) {
      void ensureMessage().then(() => {
        if (!finished) void doEdit(true)
      })
      return
    }
    scheduleFlush()
  }

  const finish = async (outcome: 'done' | 'error' | 'abort' = 'done'): Promise<void> => {
    if (finished) return
    finished = true
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    // Wait for a racing create so we can still delete it
    if (createPromise) {
      try {
        await createPromise
      } catch { /* ignore */ }
    }
    phase = outcome === 'error' ? 'error' : 'done'
    // Prefer delete so the chat isn't littered with status noise
    if (messageId != null) {
      try {
        await api.deleteMessage(chatId, messageId)
      } catch {
        try {
          await api.editMessageText(
            chatId,
            messageId,
            outcome === 'error' ? '⚠️ done (with errors)' : '✓ done'
          )
        } catch { /* ignore */ }
      }
    }
    messageId = null
  }

  return { report, finish }
}

/** No-op reporter for scheduler / tests */
export function noopProgress(): ProgressReporter {
  return {
    report: () => {},
    finish: async () => {},
  }
}
