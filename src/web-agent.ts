import { readEnvFile } from './env.js'

const env = readEnvFile()

export const WEB_AGENT_URL = env['WEB_AGENT_URL'] ?? 'http://localhost:7878'
export const WEB_AGENT_TOKEN = env['WEB_AGENT_TOKEN'] ?? ''

interface CreateTaskResponse {
  job_id: string
  status: string
}

export interface WebAgentEvent {
  id: number
  task_id: string
  ts: number
  type: string
  intent: string | null
  url: string | null
  screenshot_path: string | null
  dom_summary: string | null
  reasoning: string | null
  status: string | null
  extra_json: string | null
}

export interface EventsResponse {
  task_status: string
  events: WebAgentEvent[]
}

async function authed(path: string, init?: RequestInit): Promise<Response> {
  if (!WEB_AGENT_TOKEN) throw new Error('WEB_AGENT_TOKEN not set in .env')
  return fetch(`${WEB_AGENT_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${WEB_AGENT_TOKEN}`,
      'Content-Type': 'application/json',
    },
  })
}

export async function createWebTask(
  prompt: string,
  callback: { kind: 'telegram' | 'discord'; channel: string; user_id?: string }
): Promise<string> {
  const res = await authed('/tasks', {
    method: 'POST',
    body: JSON.stringify({ prompt, callback }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>')
    throw new Error(`web-agent ${res.status}: ${text}`)
  }
  const data = (await res.json()) as CreateTaskResponse
  return data.job_id
}

export async function getWebTaskEvents(jobId: string, sinceId: number): Promise<EventsResponse> {
  const res = await authed(`/tasks/${jobId}/events?since=${sinceId}`)
  if (!res.ok) throw new Error(`web-agent events ${res.status}`)
  return (await res.json()) as EventsResponse
}

export async function decideWebApproval(
  jobId: string,
  approvalId: string,
  decision: 'approve' | 'deny' | 'cancel'
): Promise<void> {
  const res = await authed(`/tasks/${jobId}/${decision}`, {
    method: 'POST',
    body: JSON.stringify({ approval_id: approvalId }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>')
    throw new Error(`web-agent ${decision} ${res.status}: ${text}`)
  }
}

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'denied',
  'cancelled',
  'interrupted',
])

export interface ProgressCallbacks {
  onText(line: string): Promise<void>
  onApproval(approvalId: string, intent: string, screenshotPath: string | null, url: string | null): Promise<void>
  onDone(status: string, result: string | null): Promise<void>
}

export async function pollWebTask(
  jobId: string,
  callbacks: ProgressCallbacks,
  pollMs = 2000
): Promise<void> {
  let sinceId = 0
  while (true) {
    let resp: EventsResponse
    try {
      resp = await getWebTaskEvents(jobId, sinceId)
    } catch (err) {
      await callbacks.onText(`(poll error: ${(err as Error).message.slice(0, 200)})`)
      await new Promise((r) => setTimeout(r, pollMs * 2))
      continue
    }

    for (const ev of resp.events) {
      sinceId = Math.max(sinceId, ev.id)
      await handleEvent(jobId, ev, callbacks)
    }

    if (TERMINAL_STATUSES.has(resp.task_status)) {
      const last = resp.events[resp.events.length - 1]
      let result: string | null = null
      if (last?.extra_json) {
        try {
          const extra = JSON.parse(last.extra_json) as { result?: string }
          result = extra.result ?? null
        } catch {
          // ignore
        }
      }
      await callbacks.onDone(resp.task_status, result ?? last?.reasoning ?? null)
      return
    }

    await new Promise((r) => setTimeout(r, pollMs))
  }
}

async function handleEvent(jobId: string, ev: WebAgentEvent, callbacks: ProgressCallbacks): Promise<void> {
  switch (ev.type) {
    case 'task_started':
      await callbacks.onText(`▶️ Task started`)
      return
    case 'plan':
      if (ev.reasoning) await callbacks.onText(`🧠 ${ev.reasoning.slice(0, 200)}`)
      return
    case 'navigate':
      await callbacks.onText(`🌐 navigate → ${ev.url ?? '?'}`)
      return
    case 'act':
      await callbacks.onText(`👆 act: ${ev.intent ?? '?'} — ${ev.status?.slice(0, 100) ?? ''}`)
      return
    case 'observe':
      await callbacks.onText(`👀 ${ev.status ?? 'observed'}`)
      return
    case 'extract':
      await callbacks.onText(`📋 ${ev.status?.slice(0, 200) ?? 'extracted'}`)
      return
    case 'pending_approval': {
      let approvalId = ''
      if (ev.extra_json) {
        try {
          const extra = JSON.parse(ev.extra_json) as { approval_id?: string }
          approvalId = extra.approval_id ?? ''
        } catch {
          // ignore
        }
      }
      if (approvalId) {
        await callbacks.onApproval(approvalId, ev.intent ?? '(unknown)', ev.screenshot_path, ev.url)
      }
      return
    }
    case 'task_completed':
    case 'task_failed':
      // Handled when terminal status is observed in pollWebTask
      return
  }
}
