import { readEnvFile } from './env.js'

const env = readEnvFile()

const LMSTUDIO_URL = env['LMSTUDIO_URL'] ?? ''
const LMSTUDIO_API_KEY = env['LMSTUDIO_API_KEY'] ?? ''
const LMSTUDIO_MODEL = env['LMSTUDIO_MODEL'] ?? 'qwen3.5-397b-a17b'
const TIMEOUT_MS = Number(env['CODEX_TIMEOUT_MS'] ?? env['LMSTUDIO_TIMEOUT_MS'] ?? 600000)

// Top-10 pre-flight checklist for OpenClaw / PersonalOS-style services.
// These are the failure modes that have actually bitten this stack: hardening EROFS, bare-model
// 404s, root-owned cron output, mock-vs-prod drift, thinking-model token starvation, etc.
const CODEX_CHECKLIST = `## Pre-Flight Checklist for OpenClaw/PersonalOS-style Services

Score each item: PASS / FAIL / WARN / N/A. Be terse but specific. Cite line numbers or paths when relevant.

1. **Filesystem safety** — Does this write outside intended project dirs (workspace/, store/, tmp)? Avoid shelling out to package installers or writing secrets into the repo.

2. **Approval gates for irreversible operations** — Money spent, public posts, account creation, file deletion, raw shell commands: is there a per-action approval that surfaces to the chat surface? Default to paranoid (every action) for v1; relax only after failure modes are understood.

3. **Multi-tenancy & user-gating** — Entry point checks requesting user against slack-allowFrom.json / isAuthorised(chat_id) / Discord allowlist BEFORE executing? The platform's user ID is the only auth surface — verify it explicitly.

4. **Model identifier hygiene** — If the change involves model strings: never pass bare \`claude\` as a model ID (404s). Use a family alias (\`opus\`/\`sonnet\`/\`haiku\` auto-tracks latest) or a full ID (\`claude-opus-4-8\`). Validate on write (when the row is created), not just on read.

5. **Subprocess lifecycle** — If spawning the Claude CLI / playwright / any child: explicit timeout? stderr streamed to a log? Killed on cancel/abort? Non-zero exit surfaced? The web-agent and backfill.ts zombie process incidents both stem from this.

6. **Persistent state & restart-safety** — better-sqlite3 in WAL mode? Long-running jobs persist \`started_at\` so a restart marks them \`interrupted\` instead of dropping silently? Cron jobs idempotent so a double-fire is safe? Cron output files NOT owned by root (else EACCES bites the user-mode service).

7. **Auth path clarity** — One unambiguous auth path per call site: Claude OAuth (\`~/.claude/.credentials.json\`), LM Studio bearer token, Ollama base URL, OR Anthropic API key — pick ONE and verify it exists at startup. Don't silently fall through. NEVER accept secrets via chat messages (transcript leak).

8. **Chat-surface compat** — Slack: preserve \`thread_ts\` through async work; respect 4000-char message limit; use Block Kit for structured replies. Telegram: avoid HTML/Markdown parse-mode pitfalls; default to plain text. Discord: 2000-char limit; respect 5-buttons-per-action-row limit. Don't generate output the platform will silently truncate or reject.

9. **Audit & observability without secret leaks** — Each meaningful action emits a structured log row (SQLite events table or pino JSON). Screenshots / DOM snapshots / tool call args captured. Logs do NOT echo API keys / OAuth tokens, but DO capture user intent + outcome so post-mortems are possible.

10. **Failure narration honesty** — When something fails, narrate the ACTUAL failure, not a guess. EROFS ≠ "host is read-only" (it's hardening). 30s timeout ≠ "the model is broken" (it's the timeout). Empty LLM response ≠ silent retry (say "model returned empty content, likely truncated by max_tokens or thinking-budget"). Mis-narration burns trust faster than the underlying bug.

## Output format

Top: one-line summary of what's being reviewed.

Then a numbered list 1-10 in this exact shape:
\`\`\`
1. Hardening fit: PASS — <one-line rationale>
2. Approval gates: WARN — <specific concern + file:line if applicable>
...
\`\`\`

Then a "Highest-priority concerns" section with up to 3 bullet points.

End with one of these lines, on its own:
- \`VERDICT: APPROVED\` — no blocking issues
- \`VERDICT: REVISE\` — at least one FAIL or two+ WARNs that should be addressed before execution`

const CODEX_SYSTEM = `You are a code/plan reviewer for long-running chat-bot services (PersonalOS and similar assistants). You enforce a fixed 10-item checklist tuned for this stack. Be specific, terse, and honest. PASS means you actively verified; N/A means the item doesn't apply to this change. Never invent file paths or line numbers. If the input is ambiguous, score what you can and call out what's missing in "Highest-priority concerns".`

export interface CodexReviewResult {
  ok: true
  verdict: 'APPROVED' | 'REVISE' | 'UNKNOWN'
  body: string
  model: string
  durationMs: number
}

export interface CodexErrorResult {
  ok: false
  error: string
  durationMs: number
}

export async function reviewWithCodex(planOrCode: string): Promise<CodexReviewResult | CodexErrorResult> {
  if (!LMSTUDIO_URL || !LMSTUDIO_API_KEY) {
    return { ok: false, error: 'LMSTUDIO_URL/LMSTUDIO_API_KEY not set in .env', durationMs: 0 }
  }
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${LMSTUDIO_URL.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LMSTUDIO_API_KEY}`,
      },
      body: JSON.stringify({
        model: LMSTUDIO_MODEL,
        messages: [
          { role: 'system', content: CODEX_SYSTEM },
          {
            role: 'user',
            content: `${CODEX_CHECKLIST}\n\n---\n\nHere is the plan / diff / code to review:\n\n${planOrCode.slice(0, 30000)}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 10000,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable>')
      return { ok: false, error: `LM Studio ${res.status}: ${text.slice(0, 400)}`, durationMs: Date.now() - start }
    }
    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content: string
          reasoning_content?: string
          provider_specific_fields?: { reasoning_content?: string }
        }
        finish_reason: string | null
      }>
    }
    const choice = data.choices[0]
    const rawContent = choice?.message?.content ?? ''
    const reasoning =
      choice?.message?.reasoning_content ??
      choice?.message?.provider_specific_fields?.reasoning_content ??
      ''
    const body = rawContent.trim().length > 0 ? rawContent : reasoning
    if (!body || body.trim().length === 0) {
      return {
        ok: false,
        error: `model returned empty (finish=${choice?.finish_reason ?? '?'})`,
        durationMs: Date.now() - start,
      }
    }
    const verdict: CodexReviewResult['verdict'] = /VERDICT:\s*APPROVED/i.test(body)
      ? 'APPROVED'
      : /VERDICT:\s*REVISE/i.test(body)
        ? 'REVISE'
        : 'UNKNOWN'
    return {
      ok: true,
      verdict,
      body,
      model: LMSTUDIO_MODEL,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      durationMs: Date.now() - start,
    }
  } finally {
    clearTimeout(timer)
  }
}
