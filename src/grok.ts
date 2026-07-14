/**
 * Grok (xAI) backend for PersonalOS.
 *
 * OpenAI-compatible chat + function calling against https://api.x.ai/v1.
 * Reuses PersonalOS tools from lmstudio.ts so Grok has the same agent surface
 * as Qwen (bash, files, calendar, create_presentation, etc.).
 *
 * Auth: XAI_API_KEY or Grok CLI OAuth (~/.grok/auth.json) — see xai-auth.ts.
 */
import { logger } from './logger.js'
import {
  resolveXaiCredentials,
  describeXaiAuth,
  isXaiAvailable,
  listXaiModels,
  refreshGrokAccessToken,
  resolveDefaultGrokModel,
  XAI_API_BASE,
  XAI_DEFAULT_MODEL,
  XAI_TIMEOUT_MS,
} from './xai-auth.js'
import {
  TOOLS,
  executeTool,
  buildSystemPrompt,
  LM_ESCALATION_PREFIX,
} from './lmstudio.js'

const MAX_TOOL_LOOPS = 20
const MAX_HISTORY = 40

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface GrokMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

const chatHistory = new Map<string, GrokMessage[]>()
const chatModel = new Map<string, string>()

export function getGrokModel(chatId: string): string {
  // May be "latest" until first async resolve — callers that need a concrete id
  // should use resolveGrokModel().
  return chatModel.get(chatId) ?? XAI_DEFAULT_MODEL
}

/** Resolve a concrete model id (auto-picks latest when default is "latest"). */
export async function resolveGrokModel(chatId: string): Promise<string> {
  const stored = chatModel.get(chatId)
  if (stored && stored !== 'latest' && stored !== 'auto') return stored
  return resolveDefaultGrokModel()
}

export function setGrokModel(chatId: string, model: string): void {
  chatModel.set(chatId, model)
}

export function clearGrokHistory(chatId: string): void {
  chatHistory.delete(chatId)
}

export function getGrokStatus(chatId: string): string {
  const m = getGrokModel(chatId)
  const label = m === 'latest' || m === 'auto' ? 'latest (auto)' : m
  return `grok/${label} via ${describeXaiAuth()}`
}

export { isXaiAvailable as isGrokAvailable, listXaiModels as listGrokModels, describeXaiAuth }

function grokSystemPrompt(): string {
  // Same PersonalOS environment + tools as Qwen, with a Grok identity line.
  const base = buildSystemPrompt()
  return (
    base.replace(
      /^Today is .*?\./,
      (m) =>
        `${m} You are PersonalOS-CB running on Grok (xAI). Same tools and workspace as the local Qwen path.`
    ) +
    `\n\nGROK NOTES:\n- You are a strong frontier model — prefer finishing with tools over escalating.\n- escalate only if Claude-specific project setup is required.\n- Prefer create_presentation for decks (deck-spec JSON, not free-form HTML).`
  )
}

async function callGrok(
  messages: GrokMessage[],
  model: string,
  token: string,
  withTools: boolean,
  abortSignal?: AbortSignal
): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.4,
    stream: false,
  }
  if (withTools) {
    body.tools = TOOLS
    body.tool_choice = 'auto'
  }

  const res = await fetch(`${XAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: abortSignal ?? AbortSignal.timeout(XAI_TIMEOUT_MS),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    if (res.status === 401) {
      const err = new Error(
        `xAI auth failed (401). ${errText.slice(0, 200)}`
      ) as Error & { status?: number }
      err.status = 401
      throw err
    }
    throw new Error(`xAI API ${res.status}: ${errText.slice(0, 500)}`)
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: ToolCall[] }
      finish_reason?: string
    }>
  }
  const msg = data.choices?.[0]?.message
  return {
    content: msg?.content ?? null,
    tool_calls: msg?.tool_calls,
  }
}

export type GrokProgressFn = (u: {
  phase: 'start' | 'thinking' | 'tool_start' | 'tool_done' | 'done' | 'error'
  tool?: string
  loop?: number
  maxLoops?: number
  toolsDone?: number
  detail?: string
}) => void

export async function queryGrok(
  chatId: string,
  message: string,
  onTyping?: () => void,
  options?: { locked?: boolean; onProgress?: GrokProgressFn }
): Promise<string> {
  // Auto-refresh OAuth when near expiry (plan login, not API key)
  let creds = await resolveXaiCredentials()
  if (!creds.token) {
    return (
      'Grok is not authenticated (monthly plan OAuth).\n\n' +
      'In Telegram: /groklogin  (opens a code you enter on any phone/browser)\n' +
      'Or on the machine: grok login --oauth\n\n' +
      `Status: ${describeXaiAuth()}`
    )
  }
  if (creds.refreshed) {
    logger.info({ chatId, expiresAt: creds.expiresAt }, 'Grok token auto-refreshed before request')
  }

  const model = await resolveGrokModel(chatId)
  // Cache resolved id so subsequent turns and status stay concrete
  if (!chatModel.has(chatId) || chatModel.get(chatId) === 'latest' || chatModel.get(chatId) === 'auto') {
    chatModel.set(chatId, model)
  }
  let history = chatHistory.get(chatId)
  if (!history || history.length === 0 || history[0].role !== 'system') {
    history = [{ role: 'system', content: grokSystemPrompt() }]
    chatHistory.set(chatId, history)
  }

  history.push({ role: 'user', content: message })

  // Trim history
  if (history.length > MAX_HISTORY + 1) {
    const sys = history[0]
    history = [sys, ...history.slice(-(MAX_HISTORY))]
    chatHistory.set(chatId, history)
  }

  onTyping?.()
  const onProgress = options?.onProgress
  let toolsDone = 0
  onProgress?.({ phase: 'start', loop: 0, maxLoops: MAX_TOOL_LOOPS, toolsDone: 0 })

  let did401Refresh = false

  try {
    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      onTyping?.()
      onProgress?.({
        phase: 'thinking',
        loop: loop + 1,
        maxLoops: MAX_TOOL_LOOPS,
        toolsDone,
      })
      let result
      try {
        result = await callGrok(history, model, creds.token, true)
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 401 && !did401Refresh) {
          did401Refresh = true
          logger.info({ chatId }, 'Grok 401 — forcing OAuth refresh and retry')
          const r = await refreshGrokAccessToken()
          if (r.ok) {
            creds = await resolveXaiCredentials()
            if (creds.token) {
              result = await callGrok(history, model, creds.token, true)
            } else {
              throw err
            }
          } else {
            return (
              `Grok auth expired and auto-refresh failed.\n${r.error}\n\n` +
              'Send /groklogin to re-authenticate with your monthly plan (no API key).'
            )
          }
        } else {
          throw err
        }
      }

      const toolCalls = result.tool_calls
      if (toolCalls && toolCalls.length > 0) {
        history.push({
          role: 'assistant',
          content: result.content,
          tool_calls: toolCalls,
        })

        for (const tc of toolCalls) {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
          } catch {
            args = {}
          }
          // Strip escalate when locked
          if (options?.locked && tc.function.name === 'escalate') {
            history.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: 'Escalation disabled while /lock is active.',
            })
            continue
          }
          logger.info({ chatId, tool: tc.function.name }, 'Grok tool call')
          onProgress?.({
            phase: 'tool_start',
            tool: tc.function.name,
            loop: loop + 1,
            maxLoops: MAX_TOOL_LOOPS,
            toolsDone,
          })
          const toolResult = await executeTool(tc.function.name, args, chatId)
          toolsDone++
          onProgress?.({
            phase: 'tool_done',
            tool: tc.function.name,
            loop: loop + 1,
            maxLoops: MAX_TOOL_LOOPS,
            toolsDone,
          })
          history.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolResult.slice(0, 48_000),
          })
        }
        continue
      }

      const text = (result.content ?? '').trim()
      history.push({ role: 'assistant', content: text })
      chatHistory.set(chatId, history)

      if (text.startsWith(LM_ESCALATION_PREFIX) || text.startsWith('__ESCALATE__')) {
        onProgress?.({ phase: 'done', toolsDone, maxLoops: MAX_TOOL_LOOPS })
        return text.startsWith('__ESCALATE__') ? text : text
      }
      onProgress?.({ phase: 'done', toolsDone, maxLoops: MAX_TOOL_LOOPS })
      return text || '(empty response from Grok)'
    }

    onProgress?.({ phase: 'done', toolsDone, maxLoops: MAX_TOOL_LOOPS })
    return 'Grok hit the tool-loop limit. Try a narrower ask, or /model opus for a long multi-step job.'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err, chatId }, 'Grok query failed')
    onProgress?.({ phase: 'error', detail: msg.slice(0, 80), toolsDone })
    return `Grok error: ${msg}`
  }
}
