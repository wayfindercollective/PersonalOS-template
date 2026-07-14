import { CronExpressionParser } from 'cron-parser'
import { execSync } from 'node:child_process'
import {
  getDueTasks,
  updateTaskAfterRun,
  updateTaskAfterSuccess,
  bumpTaskNextRun,
  setTaskStatus,
  recordTaskFailure,
  getUnreportedFailures,
  markFailuresReported,
  getSetting,
  setSetting,
  type TaskFailure,
} from './db.js'
import { runAgent } from './agent.js'
import { queryLMStudio, isLMStudioAvailable } from './lmstudio.js'
import { queryGrok, isGrokAvailable } from './grok.js'
import { buildMemoryContext } from './memory.js'
import { normalizeClaudeModel } from './models.js'
import { logger } from './logger.js'

// Block dangerous patterns for raw shell tasks. Mirrors the BLOCKED_COMMANDS
// list in lmstudio.ts so a scheduled raw task can't escalate privileges or
// destroy data.
const RAW_BLOCKED: RegExp[] = [
  /\bsudo\b/,
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/i,
  /\brm\s+-[a-z]*R/i,
  /\bmkfs\b/, /\bdd\s+/, /\bformat\b/, /\bshred\b/, /\bwipe\b/,
  /\b(shutdown|reboot|poweroff|halt|init\s+[0-6])\b/,
  /\bsystemctl\s+(stop|disable|mask|restart)\s+(?!--user)/,
  /\bchmod\s+[0-7]*777\b/, /\bchown\b/,
  /\bcurl\s.*\|\s*(ba)?sh\b/, /\bwget\s.*\|\s*(ba)?sh\b/,
  />\s*\/dev\/sd/, />\s*\/etc\//, />\s*\/boot\//,
  /\biptables\b/, /\bkill\s+-9\b/, /\bkillall\b/, /\bpkill\b/,
  /\bcrontab\s+-r\b/, /\bgit\s+push\s+.*--force\b/, /\bgit\s+reset\s+--hard\b/,
  /:\(\)\s*\{\s*:\|:&\s*\}/,
]
export function rawBlockedReason(cmd: string): string | null {
  for (const p of RAW_BLOCKED) if (p.test(cmd)) return `Blocked pattern: ${p.source}`
  return null
}

/** runAgent soft-fails into text instead of throwing — treat those as task failures. */
export function isAgentFailureResult(text: string): boolean {
  const t = text.trim()
  return (
    /^Error running agent:/i.test(t) ||
    /^Agent timed out after /i.test(t)
  )
}

type Sender = (chatId: string, text: string) => Promise<void>

type PushTurn = (chatId: string, role: 'user' | 'assistant', content: string) => void

let sender: Sender | undefined
let pushTurn: PushTurn | undefined
let interval: ReturnType<typeof setInterval> | undefined
let digestInterval: ReturnType<typeof setInterval> | undefined
const running = new Set<string>() // dedup guard -- tracks in-flight task IDs

const DIGEST_SETTING_KEY = 'last_failure_digest_at'
const DIGEST_SETTING_CHAT = '_system'
const DIGEST_DOW = 1 // Monday
const DIGEST_HOUR = 9 // 09:00 local time

export function computeNextRun(cronExpression: string): number {
  const expr = CronExpressionParser.parse(cronExpression)
  const next = expr.next()
  return Math.floor(next.getTime() / 1000)
}

export async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks()
  if (tasks.length === 0) return

  logger.info({ count: tasks.length }, 'Running due tasks')

  for (const task of tasks) {
    // Dedup guard: skip if this task is already running from a previous tick
    if (running.has(task.id)) {
      logger.info({ taskId: task.id }, 'Skipping task -- already running')
      continue
    }
    running.add(task.id)

    try {
      // Bump next_run NOW so the next tick won't pick it up again
      const nextRun = computeNextRun(task.schedule)
      bumpTaskNextRun(task.id, nextRun)

      // ── Raw shell tasks: just execSync, no LLM ────────────────────────────
      if (task.task_type === 'raw') {
        const cmd = task.prompt.trim()
        const blocked = rawBlockedReason(cmd)
        if (blocked) {
          logger.warn({ taskId: task.id, reason: blocked }, 'Raw task blocked by safety filter — pausing')
          setTaskStatus(task.id, 'paused')
          recordTaskFailure(task.id, task.prompt, task.chat_id, `Raw blocked: ${blocked}`)
          continue
        }
        let stdout = ''
        let exitInfo = ''
        try {
          stdout = execSync(cmd, {
            encoding: 'utf-8',
            timeout: 5 * 60_000,
            maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
          })
        } catch (e) {
          const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number }
          stdout = (err.stdout ?? '') + (err.stderr ? `\n--- stderr ---\n${err.stderr}` : '')
          exitInfo = `(exit=${err.status ?? '?'})\n`
          // Treat non-zero exit as failure: record for digest, but don't crash.
          recordTaskFailure(task.id, task.prompt, task.chat_id, (exitInfo + stdout).slice(0, 1000))
        }
        const trimmed = (exitInfo + stdout).trim() || '(no output)'
        updateTaskAfterSuccess(task.id, nextRun, trimmed.slice(0, 4000))
        if (task.one_shot) {
          setTaskStatus(task.id, 'paused')
          logger.info({ taskId: task.id }, 'Auto-paused one-shot raw task')
        }
        const outputMode = task.raw_output_mode ?? 'chat'
        if (outputMode === 'chat' && sender && !exitInfo) {
          // Successful raw task with chat mode: send the output to chat
          await sender(task.chat_id, trimmed.slice(0, 3500))
        }
        logger.info({ taskId: task.id, bytes: trimmed.length, outputMode, exitInfo }, 'Raw task completed')
        continue
      }
      // ── End raw task path ─────────────────────────────────────────────────

      const taskModel = task.model ?? 'claude'
      const modelLabel =
        taskModel === 'lmstudio' ? 'qwen'
        : taskModel === 'grok' ? 'grok'
        : taskModel

      // Tasks with [silent] prefix skip the result message entirely
      const isSilent = task.prompt.startsWith('[silent]')
      const cleanPrompt = isSilent ? task.prompt.slice(8).trim() : task.prompt

      let result: string

      if (taskModel === 'lmstudio') {
        // Route to LM Studio (Qwen) -- no Claude usage
        // Fallback notices stay in the journal only (never chat spam).
        const available = await isLMStudioAvailable()
        if (!available) {
          logger.warn({ taskId: task.id }, 'LM Studio unavailable for scheduled task, falling back to Claude')
          const memoryContext = await buildMemoryContext(task.chat_id, cleanPrompt)
          const fullPrompt = memoryContext ? `${memoryContext}\n\n${cleanPrompt}` : cleanPrompt
          const { text } = await runAgent(fullPrompt)
          result = text ?? '(no output)'
        } else {
          const memoryContext = await buildMemoryContext(task.chat_id, cleanPrompt)
          const fullPrompt = memoryContext ? `${memoryContext}\n\n${cleanPrompt}` : cleanPrompt
          // Use a dedicated chat ID for scheduled tasks so we don't pollute interactive history
          const schedulerChatId = `sched-${task.id}`
          const promptSnippet = cleanPrompt.replace(/\s+/g, ' ').slice(0, 60)
          const holderLabel = `scheduled task: "${promptSnippet}${cleanPrompt.length > 60 ? '...' : ''}"`
          try {
            result = await queryLMStudio(schedulerChatId, fullPrompt, cleanPrompt, undefined, undefined, undefined, { holderLabel })
          } catch (lmErr) {
            logger.warn({ taskId: task.id, err: lmErr }, 'LM Studio query failed for scheduled task, falling back to Claude')
            const { text } = await runAgent(fullPrompt)
            result = text ?? '(no output)'
          }
        }
      } else if (taskModel === 'grok') {
        const available = await isGrokAvailable()
        const memoryContext = await buildMemoryContext(task.chat_id, cleanPrompt)
        const fullPrompt = memoryContext ? `${memoryContext}\n\n${cleanPrompt}` : cleanPrompt
        if (!available) {
          logger.warn({ taskId: task.id }, 'Grok unavailable for scheduled task, falling back to Claude')
          const { text } = await runAgent(fullPrompt)
          result = text ?? '(no output)'
        } else {
          const schedulerChatId = `sched-grok-${task.id}`
          try {
            result = await queryGrok(schedulerChatId, fullPrompt)
          } catch (gErr) {
            logger.warn({ taskId: task.id, err: gErr }, 'Grok query failed for scheduled task, falling back to Claude')
            const { text } = await runAgent(fullPrompt)
            result = text ?? '(no output)'
          }
        }
      } else {
        // Claude path (default) — family aliases (opus/sonnet/haiku) track latest.
        // Normalize any stale versioned pins stored on older task rows.
        const claudeModelId =
          taskModel === 'claude' || !taskModel
            ? undefined
            : normalizeClaudeModel(taskModel)
        const { text } = await runAgent(cleanPrompt, undefined, undefined, claudeModelId)
        result = text ?? '(no output)'
      }

      // Soft agent failures must not be posted as successful cron replies.
      if (isAgentFailureResult(result)) {
        throw new Error(result)
      }

      // Update with actual result (stamps last_success_at too)
      updateTaskAfterSuccess(task.id, nextRun, result)

      // One-shot tasks auto-pause after a successful run, keeping the row for reference.
      if (task.one_shot) {
        setTaskStatus(task.id, 'paused')
        logger.info({ taskId: task.id }, 'Auto-paused one-shot task after successful run')
      }

      if (sender && !isSilent) {
        await sender(task.chat_id, result)
        if (pushTurn) pushTurn(task.chat_id, 'assistant', '[cron: ' + cleanPrompt.slice(0, 50) + '] ' + result)
      }

      logger.info({ taskId: task.id, nextRun }, 'Task completed')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error({ taskId: task.id, err }, 'Task failed')

      // Auto-pause tasks that fail with unrecoverable errors (bad chat ID, etc.)
      const unrecoverable = /chat not found|invalid chat|forbidden|unauthorized/i.test(errMsg)
      if (unrecoverable) {
        logger.warn({ taskId: task.id }, 'Auto-pausing task due to unrecoverable error')
        setTaskStatus(task.id, 'paused')
      } else {
        // Recoverable error -- schedule next run so it doesn't block.
        // Preserve last_result (the prior successful output) -- failure details
        // are captured in the task_failures table for the weekly digest.
        try {
          const nextRun = computeNextRun(task.schedule)
          bumpTaskNextRun(task.id, nextRun)
        } catch {
          // Bad cron expression -- pause it
          logger.warn({ taskId: task.id }, 'Auto-pausing task due to invalid schedule')
          setTaskStatus(task.id, 'paused')
        }
      }

      // Record for weekly digest instead of sending an inline failure message
      try {
        recordTaskFailure(task.id, task.prompt, task.chat_id, errMsg)
      } catch (recErr) {
        logger.error({ taskId: task.id, err: recErr }, 'Failed to record task failure')
      }
    } finally {
      running.delete(task.id)
    }
  }
}

function formatFailureDigest(failures: TaskFailure[]): string {
  const lines: string[] = []
  lines.push(`Scheduled task failure digest (${failures.length} failure${failures.length === 1 ? '' : 's'} this week):`)
  lines.push('')
  for (const f of failures) {
    const when = new Date(f.occurred_at * 1000).toLocaleString()
    const prompt = f.task_prompt.replace(/\s+/g, ' ').slice(0, 80)
    const err = f.error_message.replace(/\s+/g, ' ').slice(0, 200)
    lines.push(`• ${when} — ${prompt}`)
    lines.push(`  Error: ${err}`)
  }
  return lines.join('\n')
}

export async function runWeeklyDigestCheck(force = false): Promise<void> {
  if (!sender) return

  if (!force) {
    const now = new Date()
    const lastStr = getSetting(DIGEST_SETTING_CHAT, DIGEST_SETTING_KEY)
    const last = lastStr ? parseInt(lastStr, 10) : 0
    const sixDaysAgo = Math.floor(Date.now() / 1000) - 6 * 86_400
    if (last > sixDaysAgo) return // already sent this week

    // Fire on Monday at or after the digest hour, OR any time if we missed
    // last week's window (>=7 days since the last digest). This catches up
    // automatically if the service was down during Mon 09:00–09:59.
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86_400
    const onMondayAtOrAfterHour =
      now.getDay() === DIGEST_DOW && now.getHours() >= DIGEST_HOUR
    const overdue = last < sevenDaysAgo
    if (!onMondayAtOrAfterHour && !overdue) return
  }

  const failures = getUnreportedFailures()
  // Always advance the watermark so we don't re-check every minute of the digest hour
  setSetting(DIGEST_SETTING_CHAT, DIGEST_SETTING_KEY, String(Math.floor(Date.now() / 1000)))

  if (failures.length === 0) return // quiet: no "all clear" message

  // Group by chat so each chat gets only its own failures
  const byChat = new Map<string, TaskFailure[]>()
  for (const f of failures) {
    const list = byChat.get(f.chat_id) ?? []
    list.push(f)
    byChat.set(f.chat_id, list)
  }

  const sentIds: number[] = []
  for (const [chatId, chatFailures] of byChat) {
    try {
      await sender!(chatId, formatFailureDigest(chatFailures))
      sentIds.push(...chatFailures.map((f) => f.id))
    } catch (err) {
      logger.warn({ chatId, err }, 'Failed to send weekly failure digest')
    }
  }

  markFailuresReported(sentIds)
  logger.info({ failures: failures.length, sent: sentIds.length }, 'Weekly failure digest run')
}

export function initScheduler(send: Sender, onPushTurn?: PushTurn): void {
  sender = send
  pushTurn = onPushTurn
  interval = setInterval(runDueTasks, 60_000)
  digestInterval = setInterval(() => {
    runWeeklyDigestCheck().catch((err) => logger.error({ err }, 'Weekly digest check failed'))
  }, 60 * 60_000) // hourly
  logger.info('Scheduler started (60s poll, hourly digest check)')

  // Run immediately on start to catch any overdue tasks
  runDueTasks().catch((err) => logger.error({ err }, 'Initial task run failed'))
  runWeeklyDigestCheck().catch((err) => logger.error({ err }, 'Initial digest check failed'))
}

export function stopScheduler(): void {
  if (interval) {
    clearInterval(interval)
    interval = undefined
  }
  if (digestInterval) {
    clearInterval(digestInterval)
    digestInterval = undefined
  }
}
