import { query } from '@anthropic-ai/claude-agent-sdk'
import os from 'node:os'
import type { SDKSystemMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { PROJECT_ROOT, TYPING_REFRESH_MS, AGENT_TIMEOUT_MS } from './config.js'
import { logger } from './logger.js'

// Locate the Claude CLI binary. Preference order:
//   1. `claude` on PATH (brew install — stable across VS Code extension upgrades)
//   2. VS Code extension's bundled native binary (versioned dir, churns on every update)
// Resolved per call so a VS Code extension upgrade mid-process doesn't strand a stale path.
function findClaudeBinary(): string | undefined {
  // 1) PATH (works on Linux/macOS/Windows when `claude` is installed)
  const whichCmd = process.platform === 'win32' ? 'where claude' : 'command -v claude'
  try {
    const out = execSync(whichCmd, {
      encoding: 'utf-8',
      ...(process.platform === 'win32' ? { shell: 'cmd.exe' } : {}),
    }).trim()
    const bin = out.split(/\r?\n/)[0]?.trim()
    if (bin && existsSync(bin)) return bin
  } catch { /* not on PATH */ }

  // 2) Common VS Code / Cursor extension locations (optional fallback)
  const home = os.homedir()
  const extensionRoots = [
    join(home, '.vscode', 'extensions'),
    join(home, '.cursor', 'extensions'),
    join(home, '.var', 'app', 'com.visualstudio.code', 'data', 'vscode', 'extensions'), // Flatpak Linux
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Code', 'User', 'extensions')
      : '',
    process.platform === 'win32'
      ? join(home, '.vscode', 'extensions')
      : '',
  ].filter(Boolean)

  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const extensionsDir of extensionRoots) {
    try {
      if (!existsSync(extensionsDir)) continue
      const dirs = readdirSync(extensionsDir)
        .filter((d) => d.startsWith('anthropic.claude-code-'))
        .sort()
        .reverse()
      for (const dir of dirs) {
        for (const rel of [
          join('resources', 'native-binary', binaryName),
          join('resources', 'native-binary', 'claude'),
        ]) {
          const bin = join(extensionsDir, dir, rel)
          if (existsSync(bin)) return bin
        }
      }
    } catch { /* try next root */ }
  }
  return undefined
}

export function isStaleSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('ENOENT') || msg.includes('no such file') || (msg.includes('session') && msg.includes('not found'))
}

// The Agent SDK reports a dead Claude Code subprocess as "process exited with code N"
// with no stderr (e.g. transient API overload, a momentary write failure). Treat a
// non-zero exit as transient and worth one retry rather than surfacing it raw.
export function isTransientProcessError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /process exited with code\s+[1-9]/i.test(msg) || /exited with code\s+[1-9]/i.test(msg)
}

// Backoff before retrying a transient subprocess death (helps with API-overload blips).
const RETRY_BACKOFF_MS = 2000

async function runAgentOnce(
  message: string,
  sessionId: string | undefined,
  abortController: AbortController,
  model?: string
): Promise<{ text: string | null; newSessionId?: string }> {
  let resultText: string | null = null
  let newSessionId: string | undefined
  // Collect text from assistant events as fallback when result.result is empty.
  // This happens when the agent's last turn is a tool call (e.g. cleanup) with no
  // text after it -- the SDK returns result.result=null even though the agent
  // produced meaningful text earlier in the turn.
  let lastAssistantText: string | null = null

  const claudeBinary = findClaudeBinary()

  const events = query({
    prompt: message,
    options: {
      abortController,
      cwd: PROJECT_ROOT,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      env: {
        ...process.env,
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '100000',
      },
      ...(model ? { model } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
    },
  })

  for await (const event of events) {
    if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
      const sysEvent = event as SDKSystemMessage
      newSessionId = sysEvent.session_id
      logger.debug({ sessionId: newSessionId }, 'Session initialized')
    }

    if (event.type === 'assistant' && 'message' in event) {
      const msg = (event as any).message
      const textBlocks = (msg?.content ?? []).filter((b: any) => b.type === 'text' && b.text?.trim())
      if (textBlocks.length > 0) {
        // Keep the last non-empty text block as fallback
        const text = textBlocks.map((b: any) => b.text.trim()).join('\n')
        if (text) lastAssistantText = text
      }
    }

    if (event.type === 'result') {
      const resultEvent = event as SDKResultMessage
      if (resultEvent.subtype === 'success') {
        resultText = resultEvent.result ?? null
        if (!resultText && lastAssistantText) {
          logger.info('Result was empty, using last assistant text block as response')
          resultText = lastAssistantText
        } else if (!resultText) {
          logger.warn({ sessionId, subtype: resultEvent.subtype }, 'Agent returned success with empty/null result and no assistant text')
        }
      } else {
        const errors = 'errors' in resultEvent ? resultEvent.errors : []
        logger.warn({ sessionId, subtype: resultEvent.subtype, errors }, 'Agent returned non-success result')
        // Clean up raw error messages -- strip stack traces, keep meaningful info
        const rawErrors = errors.length ? errors.join('\n') : resultEvent.subtype
        const cleaned = rawErrors
          .split('\n')
          .filter((l: string) => !/^\s+at\s/.test(l) && l.trim())
          .map((l: string) => { const m = l.match(/^(?:.*Error:\s*)(.+)/); return m ? m[1].trim() : l.trim() })
          .filter((l: string, i: number, a: string[]) => a.indexOf(l) === i) // dedupe
          .join('\n')
        resultText = `(Agent hit an error -- retrying may help)\n${cleaned}`
      }
    }
  }

  return { text: resultText, newSessionId }
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  model?: string
): Promise<{ text: string | null; newSessionId?: string; sessionDropped?: boolean }> {
  let resultText: string | null = null
  let newSessionId: string | undefined
  let sessionDropped = false

  // Refresh typing indicator while waiting
  let typingInterval: ReturnType<typeof setInterval> | undefined
  if (onTyping) {
    onTyping()
    typingInterval = setInterval(onTyping, TYPING_REFRESH_MS)
  }

  // AbortController to kill the subprocess on timeout
  const abortController = new AbortController()
  const timer = setTimeout(() => {
    logger.warn({ timeoutMs: AGENT_TIMEOUT_MS }, 'Agent query timed out, aborting subprocess')
    abortController.abort()
  }, AGENT_TIMEOUT_MS)

  try {
    try {
      const result = await runAgentOnce(message, sessionId, abortController, model)
      resultText = result.text
      newSessionId = result.newSessionId
    } catch (err) {
      if (abortController.signal.aborted) {
        // Timed out — don't retry, let the outer handler emit the timeout message.
        throw err
      } else if (sessionId && isStaleSessionError(err)) {
        // Session .jsonl no longer exists — start fresh silently
        logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'Stale session detected, retrying without resume')
        sessionDropped = true
        const result = await runAgentOnce(message, undefined, abortController, model)
        resultText = result.text
        newSessionId = result.newSessionId
      } else if (isTransientProcessError(err)) {
        // Claude Code subprocess died (transient). Retry once WITH the same session to
        // preserve continuity; if that also fails and we had a session, drop it and
        // retry fresh as a last resort.
        logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'Transient Claude Code exit, retrying once')
        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS))
        try {
          const result = await runAgentOnce(message, sessionId, abortController, model)
          resultText = result.text
          newSessionId = result.newSessionId
        } catch (err2) {
          if (sessionId && !abortController.signal.aborted) {
            logger.warn({ sessionId, err: err2 instanceof Error ? err2.message : String(err2) }, 'Retry with resume failed, retrying once without resume')
            sessionDropped = true
            const result = await runAgentOnce(message, undefined, abortController, model)
            resultText = result.text
            newSessionId = result.newSessionId
          } else {
            throw err2
          }
        }
      } else {
        throw err
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      resultText = resultText ?? `Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s -- try a simpler request or use /model local`
    } else {
      logger.error({ err }, 'Agent error')
      resultText = resultText ?? `Error running agent: ${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    clearTimeout(timer)
    if (typingInterval) clearInterval(typingInterval)
  }

  return { text: resultText, newSessionId, sessionDropped }
}
