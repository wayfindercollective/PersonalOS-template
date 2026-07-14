import { execSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path, { extname } from 'node:path'
import { logger } from './logger.js'
import { readEnvFile } from './env.js'
import {
  saveLMStudioHistory as dbSave,
  loadAllLMStudioHistories,
  clearLMStudioHistoryDb,
  getAllTasks,
  createTask,
  setTaskStatus,
  setTaskOneShot,
  deleteTask as dbDeleteTask,
  getDb,
  logConversationTurn,
  type ScheduledTask,
} from './db.js'
import { navigateTo, clickElement, fillField, takeScreenshot, getPageContent } from './browser.js'
import { getCalendar, getTasks, getGmail } from './google.js'
import { randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'

const env = readEnvFile()

// ============================================================
// LM Studio (OpenAI-compatible) client
// Connects to Qwen 3.5 397B on your LM Studio host
// ============================================================

const LMSTUDIO_URL = env['LMSTUDIO_URL'] ?? 'http://127.0.0.1:8080'
const LMSTUDIO_API_KEY = env['LMSTUDIO_API_KEY'] ?? ''
const LMSTUDIO_DEFAULT_MODEL = env['LMSTUDIO_MODEL'] ?? 'qwen3.5-397b-a17b'
const LMSTUDIO_TIMEOUT_MS = Number(env["LMSTUDIO_TIMEOUT_MS"] ?? 600000) // 10 min
const GOOGLE_API_KEY_VAL = env['GOOGLE_API_KEY'] ?? ''
const MAX_TOOL_LOOPS = 10

// GitHub default repo for gh_* tools when none is specified.
const GITHUB_DEFAULT_REPO = env['GITHUB_DEFAULT_REPO'] ?? ''
// Convex project root: where to invoke `npx convex run` from.
const CONVEX_PROJECT_DIR = env['CONVEX_PROJECT_DIR'] ?? ''
// Long-runner wrapper script path.
const LONG_RUNNER_SCRIPT = env['LONG_RUNNER_SCRIPT'] ?? './scripts/long-runner.sh'
// project E2E runner + status scripts.
const E2E_RUNNER_SCRIPT = env['E2E_RUNNER_SCRIPT'] ?? './scripts/e2e-runner.sh'
const E2E_STATUS_SCRIPT = env['E2E_STATUS_SCRIPT'] ?? './scripts/e2e-status.sh'

// US state code → full name, used by the weather tool to disambiguate cities
// like "Portsmouth NH" since Open-Meteo's geocoder ignores state qualifiers.
const US_STATE_NAMES: Record<string, string> = {
  AL: 'ALABAMA', AK: 'ALASKA', AZ: 'ARIZONA', AR: 'ARKANSAS', CA: 'CALIFORNIA',
  CO: 'COLORADO', CT: 'CONNECTICUT', DE: 'DELAWARE', FL: 'FLORIDA', GA: 'GEORGIA',
  HI: 'HAWAII', ID: 'IDAHO', IL: 'ILLINOIS', IN: 'INDIANA', IA: 'IOWA',
  KS: 'KANSAS', KY: 'KENTUCKY', LA: 'LOUISIANA', ME: 'MAINE', MD: 'MARYLAND',
  MA: 'MASSACHUSETTS', MI: 'MICHIGAN', MN: 'MINNESOTA', MS: 'MISSISSIPPI', MO: 'MISSOURI',
  MT: 'MONTANA', NE: 'NEBRASKA', NV: 'NEVADA', NH: 'NEW HAMPSHIRE', NJ: 'NEW JERSEY',
  NM: 'NEW MEXICO', NY: 'NEW YORK', NC: 'NORTH CAROLINA', ND: 'NORTH DAKOTA', OH: 'OHIO',
  OK: 'OKLAHOMA', OR: 'OREGON', PA: 'PENNSYLVANIA', RI: 'RHODE ISLAND', SC: 'SOUTH CAROLINA',
  SD: 'SOUTH DAKOTA', TN: 'TENNESSEE', TX: 'TEXAS', UT: 'UTAH', VT: 'VERMONT',
  VA: 'VIRGINIA', WA: 'WASHINGTON', WV: 'WEST VIRGINIA', WI: 'WISCONSIN', WY: 'WYOMING',
  DC: 'DISTRICT OF COLUMBIA',
}

// Build a minimal RFC 822 message for Gmail send/draft.
function buildRfc822(args: {
  to: string
  cc?: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string
}): string {
  const lines: string[] = []
  lines.push(`To: ${args.to}`)
  if (args.cc) lines.push(`Cc: ${args.cc}`)
  lines.push(`Subject: ${args.subject}`)
  if (args.inReplyTo) lines.push(`In-Reply-To: ${args.inReplyTo}`)
  if (args.references) lines.push(`References: ${args.references}`)
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset=UTF-8')
  lines.push('')
  lines.push(args.body)
  return lines.join('\r\n')
}

// Extract a readable plain-text body from a Gmail message payload.
function extractGmailBody(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  type Part = { mimeType?: string; body?: { data?: string; size?: number }; parts?: Part[] }
  const p = payload as Part
  // BFS preferring text/plain
  const stack: Part[] = [p]
  let htmlFallback = ''
  while (stack.length) {
    const cur = stack.shift()!
    if (cur.mimeType === 'text/plain' && cur.body?.data) {
      return Buffer.from(cur.body.data, 'base64').toString('utf-8')
    }
    if (cur.mimeType === 'text/html' && cur.body?.data && !htmlFallback) {
      const decoded = Buffer.from(cur.body.data, 'base64').toString('utf-8')
      htmlFallback = decoded
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim()
    }
    if (cur.parts) stack.push(...cur.parts)
  }
  return htmlFallback || '(empty body)'
}

// ============================================================
// Vision preprocessing — Gemini sees, Qwen thinks
// ============================================================
const VISION_DESCRIBE_PROMPT = 'Describe this image in detail. Include all visible text, numbers, labels, objects, colors, and context.'

// Request mutex -- the 397B model processes one request at a time.
// Without this, concurrent requests queue on the server and burn through
// their timeout waiting, causing false "unreachable" escalations.
//
// currentHolder is the human-readable label of whoever is running fn() right
// now (e.g. "your previous message" or "scheduled task: Daily parable...").
// When a new caller enters withRequestLock and finds currentHolder !== null,
// it fires onQueued(currentHolder) so the caller can tell the user EXACTLY
// what they're waiting behind -- no 30s timer guess.
let requestLock: Promise<void> = Promise.resolve()
let currentHolder: string | null = null

function withRequestLock<T>(
  fn: () => Promise<T>,
  holderLabel: string,
  onQueued?: (aheadOf: string) => void
): Promise<T> {
  const prev = requestLock
  let release: () => void
  requestLock = new Promise((resolve) => { release = resolve })

  // Synchronous snapshot: if someone holds the lock right now, we're queued.
  // Notify the caller immediately so the user knows exactly what's ahead.
  const aheadOf = currentHolder
  if (aheadOf !== null && onQueued) {
    Promise.resolve().then(() => onQueued(aheadOf)).catch((err) => {
      logger.warn({ err }, 'onQueued callback threw')
    })
  }

  return prev
    .then(async () => {
      currentHolder = holderLabel
      try {
        return await fn()
      } finally {
        currentHolder = null
      }
    })
    .finally(() => release!())
}

// Per-chat model override
const chatModel = new Map<string, string>()

// Vision content block types for multimodal messages
interface TextBlock {
  type: 'text'
  text: string
}
interface ImageUrlBlock {
  type: 'image_url'
  image_url: { url: string }
}
type ContentBlock = TextBlock | ImageUrlBlock

// Per-chat conversation history (supports tool messages and vision)
interface LMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ContentBlock[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

const chatHistory = new Map<string, LMMessage[]>()
const MAX_HISTORY = 50

// Load persisted histories from SQLite on startup
export function initLMStudioHistory(): void {
  try {
    const saved = loadAllLMStudioHistories()
    for (const [chatId, messages] of saved) {
      chatHistory.set(chatId, messages as LMMessage[])
    }
    if (saved.size > 0) {
      logger.info({ chats: saved.size }, 'Loaded LM Studio history from DB')
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load LM Studio history from DB')
  }
}

// Save current history to DB (call after each exchange)
function persistHistory(chatId: string): void {
  const history = chatHistory.get(chatId)
  if (!history || history.length === 0) return
  // Only persist user/assistant turns (skip system, tool messages with binary content)
  const toSave = history.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : contentToString(m.content),
  }))
  dbSave(chatId, toSave)
}

export function buildSystemPrompt(): string {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Chicago',
  })
  return `Today is ${today}. You are PersonalOS, a personal AI assistant running on the user's computer (Linux, macOS, or Windows). You are chill, grounded, and straight up. No em dashes. No AI cliches. No sycophancy. If you don't know something, say so plainly. Keep responses tight and readable.

ENVIRONMENT:
- Home directory: the user's home folder (cross-platform; use relative paths under the project when possible)
- PersonalOS project: ./
- Workspace: ./workspace/
  - workspace/projects/ -- ongoing project docs (nh-move.md, jeep-xj-2000.md, investment-thesis.md, etc.)
  - workspace/memory/ -- daily memory logs (YYYY-MM-DD.md)
  - workspace/uploads/ -- files the user sends via Telegram
  - workspace/life-plan/ -- life plan docs
- Personal projects: ./data/my-home/ (listing monitor at lists/listing-monitor.mjs)
- Optional work codebase: set CONVEX_PROJECT_DIR / WORK_PROJECT_DIR in .env if you want the agent to edit a specific app repo
- Schedule CLI: node ./dist/schedule-cli.js create "PROMPT" "CRON" CHAT_ID
  - Cron examples: "0 12 * * *" (daily noon), "0 9 * * 1" (Mon 9am). Timezone: America/Chicago.
- Scheduled tasks DB: ./store/personalos.db (SQLite, table: scheduled_tasks)

TOOLS:
- bash: Run shell commands (60s timeout). For weather: curl -s "https://wttr.in/City?format=3"
- read_file / write_file / list_directory: Direct file access. DO NOT use read_file on .pdf files -- it returns raw binary garbage.

UPLOADED FILES (workspace/uploads/):
- Files the user sends via Telegram land in ./workspace/uploads/ -- the message you receive will contain a "[Document attached: /path]" or "[Photo attached: /path]" marker with the absolute path.
- PDFs: extract text with bash. Default: bash 'pdftotext "/path/to/file.pdf" -' (the trailing "-" sends output to stdout). For layout-preserving extraction: bash 'pdftotext -layout "/path" -'. If pdftotext fails, fall back to bash 'python3 -c "import pdfminer.high_level as p; print(p.extract_text(\"/path\"))"'.
- Office docs (.docx, .xlsx): bash 'pandoc "/path" -t plain' or unzip + parse XML.
- Audio (.ogg/.mp3 from voice messages): the transcription is already in the message text -- ignore the file path. If a voice arrived WITHOUT a "[Voice transcribed]:" or "[Voice re-transcribed]:" prefix, the transcription pipeline failed -- do NOT improvise with bash/ffmpeg/whisper/python, those aren't wired into the real pipeline. Ask the user to resend the voice or to type what he said.
- Plain text/markdown/json/csv: read_file is fine.

GENERATING & SENDING FILES (PDFs, images, reports):
- To send ANY file to the user, write it into ./workspace/uploads/ -- files written there are AUTOMATICALLY sent to this chat. You DO have this ability; never say you "can't send files" or "don't have a tool to send files."
- Make a PDF with weasyprint (renders HTML/CSS, already installed): write your HTML to /tmp/doc.html, then bash 'weasyprint /tmp/doc.html ./workspace/uploads/NAME.pdf'. Then just confirm it's done -- it auto-sends. Do NOT dump a giant table inline instead; produce the actual PDF.
- Use a simple filename and reference the exact path you wrote, so the auto-sender picks it up.

PRESENTATIONS (slides / deck / pptx / pitch):
- YOU emit content only (deck-spec). Scripts coerce, validate, render. NEVER write HTML or python-pptx yourself.
- Tool: create_presentation({title, slides, theme?, brand?, motif?, vibe?, accent?, format?}). Default format=both.
- Design knobs (enums only): brand personalos|wayfinder|none; motif orbs|mesh|grid|bars|aurora|none; vibe keynote|product|technical|bold; accent default|electric|amber|mint|rose|violet. Per-slide layout: content list|cards|numbered|spotlight; title center|left|bold.
- Slide types: title|section|content|two-column|compare|stats|quote|code. Prefer 8-12 slides, short bullets.
- Returns JSON. On ok:false fix listed errors and retry (max 3). On ok:true always give the user PRESENT_URL.
- PRESENT_URL https://your-host.tailnet.ts.net/presentations/NAME.html — Skill: skills/presentation/SKILL.md
- grounded_search: Use for current events, news, prices, product info, release dates, anything time-sensitive. Returns a synthesized answer with citations from Google. NEVER say "I can't access real-time data" -- use this tool. (web_search is an alias for the same thing.)
- web_fetch: Read a specific URL. browse_url: Fetch with JS rendering.
- browser_navigate / browser_click / browser_fill / browser_screenshot / browser_get_content: Persistent browser for interactive web tasks. Sessions persist across messages. Use named profiles to keep separate logins.
- When a task needs deep analysis, code generation, or multi-step work you're struggling with, tell the user to switch to Claude (/model opus).

SCHEDULED TASKS (natural-language scheduling for the user):
- schedule_task: Create a scheduled task. Pass a prompt (what to do when it fires) and a cron expression you derive from your words. Timezone is America/Chicago.
  - DEFAULT one_shot=true. Only set one_shot=false when your message contains explicit recurring language: "every", "daily", "weekly", "monthly", "yearly", "each", "recurring", "always", "every [day/Monday/week/month/year]". One-shots auto-pause after the first successful run so they stay in the DB but never fire again.
  - "Remind me to call the dentist Friday" -> one_shot=true, cron pointed at the next Friday.
  - "Every Monday at 9am check my calendar" -> one_shot=false, cron "0 9 * * 1".
  - "Tomorrow at 3pm" -> one_shot=true, cron "0 15 D M *" where D/M = tomorrow's date.
- list_tasks: Show your scheduled tasks (active by default; pass include_paused=true to show all).
- pause_task / resume_task / delete_task: Take a "match" string. Match is fuzzy against task prompts -- the user says "the hardware report" or "Vipassana reminder", not task IDs. If multiple tasks match, the tool returns a disambiguation list; ask the user which one.
- update_task: Change schedule, prompt, or one_shot flag on an existing task by fuzzy match.

Never ask the user for a task ID. Always match by what the task is about.

GOOGLE CALENDAR (work@example.com = work, you@example.com = personal):
- calendar_list_events: see what's scheduled. Default account is work. Natural dates ("today", "this week", "mon") are accepted.
- calendar_create_event: book something. If attendees are passed, Google sends invites — confirm with the user first.
- calendar_find_free_slot: find a gap of N minutes. Use this before suggesting meeting times.
- calendar_cancel_event / calendar_update_event: changes notify attendees. Confirm before acting when attendees are involved.

GOOGLE TASKS (your actual todo list, visible in Calendar sidebar and mobile):
- task_create: add a real item to Google Tasks. Use this when the user says "add to my todos" or "remind me to X" with no specific time.
- task_list: show what's open.
- task_complete: mark done by fuzzy match.
- task_create vs schedule_task: pick by intent. "remind me at 3pm Friday" -> schedule_task (time-triggered Telegram message). "add to my todo list" -> task_create (real Google Task).

GMAIL (personal=you@example.com, work=work@example.com; default=personal):
- gmail_list_unread / gmail_search / gmail_read_email: read the inbox. Gmail search syntax accepted (from:, subject:, after:, has:attachment, label:, is:unread, etc.).
- gmail_draft_reply: SAFE — creates a draft the user reviews. Use freely.
- gmail_send_email: SENDS IMMEDIATELY to real humans. NEVER call without an explicit "send" or "yes send it" from the user in the current turn. When unsure, draft instead.

GITHUB (gh CLI):
- gh_create_issue: file an issue. Uses GITHUB_DEFAULT_REPO from env when set. Voice notes describing bugs ("the Stripe webhook drops signups") should become issues automatically.
- gh_list_issues / gh_search_code / gh_pr_status / gh_recent_commits: read-only investigation.
- Never close issues without explicit instruction. Never approve or merge PRs.

WAYFINDER OS (Convex DB):
- convex_query: read business state. Default env is dev. Use prod only when the user says "production" or "prod".
- convex_run: WRITES data. Requires confirm="yes mutate dev" or confirm="yes mutate prod" exactly. NEVER call mutation on prod without the user typing those exact words in the same turn.

LONG-RUNNING COMMANDS:
- bash has a 60-second timeout. For anything that takes longer (scraping, ffmpeg, big migrations, dataset downloads), use run_long_command — it forks the command detached and posts a Telegram message with the exit code and output when it finishes.
- Do NOT use this for quick commands; the notification overhead is wasted.

UTILITY TOOLS:
- search_my_chats: full-text search of conversation history when the user asks "what did I say about X" or "what did you tell me last week".
- stock_price / stock_news: live market data (US tickers). Use stock_price for one or more symbols; stock_news for headlines.
- get_weather: current + forecast for any location. Open-Meteo, no key required.
- shorten_url: tighten a long URL via is.gd before quoting it in voice.
- generate_qr: make a QR PNG (the user receives it as a photo). Use for "make me a QR for this URL/wifi/contact".
- calculate: ALWAYS offload arithmetic to this tool. You are bad at math — calculate is mathjs and handles units (e.g. "3 inches to cm", "180 mph in km/h", "(450 * 1.0875) / 12").
- convert_file: format conversions. PDF→txt, image format/resize, audio re-encode. Output lands in workspace/uploads/.
- quick_note: append to your scratchpad (workspace/scratchpad.md). Different from memory — this is your notebook for ideas. Use when the user says "add to my notes", "jot this down", "remember this idea".
- system_status: aggregate health check. Run when the user asks "is everything ok?", "any system issues?", or before major actions.

APPLE (optional — Reminders/Notes via SSH to a Mac; set MAC_SSH_TARGET):
- apple_reminder_add / apple_reminders_list: real Apple Reminders that sync to your phone and watch.
- apple_notes_search / apple_note_create: your Apple Notes app.
- All require MAC_SSH_TARGET in .env and SSH key auth set up. Tool returns a clear setup hint if not configured.

WAYFINDER OS E2E TESTS:
- run_e2e_tests: launch the Playwright E2E suite. Detached — returns immediately with "Launched". the user gets a Telegram summary when done.
- Default project="full" (~30-45 min). Use project="light" for the 2-3 min pre-push smoke. Use project="qa" only when the user explicitly asks for the QA suite.
- Default mode="dev" (Next.js dev server on :3001). Use mode="prod" for an E2E_PROD=1 production-build run on :3002 — the user must explicitly say "prod" or "production" build to trigger this.
- Pass spec= for a --grep pattern to narrow the run (e.g. spec="calendar" or spec="persistent-meetings").
- Only one run at a time (flock). If the user asks while a run is in-flight, call e2e_status instead of launching a second one.
- e2e_status: peek at in-progress runs. Shows progress markers, tallies seen so far, and tail of the log.
- DO NOT call run_e2e_tests or e2e_status when the user asks about "failed scheduled tasks", "the digest", "why did these tasks fail", or anything else from the weekly failure digest. Those are tracked separately (see SCHEDULED TASKS below). e2e_status only knows about Playwright E2E runs; using it for scheduled-task questions sends you chasing the wrong bug.

SCHEDULED TASKS:
- Failures are recorded in store/personalos.db -> table task_failures (id, task_id, task_prompt, chat_id, error_message, occurred_at, reported). Query with sqlite3 when the user asks about scheduled-task failures.
- The weekly digest message ("Scheduled task failure digest (N failures this week): ...") is emitted by scheduler.ts. To investigate, read error_message from task_failures for the relevant rows; if you need more, journalctl --user -u personalos since the occurred_at timestamp.
- If a scheduled task fails with permission or read-only filesystem errors, fix permissions/paths on the host rather than retrying blindly.

APPROACH: Use tools to look things up rather than guessing. Check workspace/projects/ for existing context before answering project-related questions.
- If 2-3 tool calls return empty results for the same query, stop and tell the user honestly what you couldn't find.
- Prefer answering from memory or conversation context before reaching for tools.`
}

// ============================================================
// Vision helper — converts [Photo attached: /path] markers to base64 image_url blocks
// ============================================================

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const PHOTO_MARKER = /\[Photo attached: ([^\]]+)\]/g

function buildVisionContent(message: string): string | ContentBlock[] {
  const imagePaths: string[] = []
  let textPart = message

  // Extract all [Photo attached: /path] markers
  const matches = [...message.matchAll(PHOTO_MARKER)]
  if (matches.length === 0) return message

  for (const match of matches) {
    const filePath = match[1].trim()
    if (existsSync(filePath) && IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())) {
      imagePaths.push(filePath)
    }
  }

  if (imagePaths.length === 0) return message

  // Strip the markers from the text portion
  textPart = message.replace(PHOTO_MARKER, '').replace(/\s+/g, ' ').trim()

  const blocks: ContentBlock[] = []

  for (const filePath of imagePaths) {
    try {
      const data = readFileSync(filePath)
      const b64 = data.toString('base64')
      const ext = extname(filePath).toLowerCase().slice(1)
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'png' ? 'image/png'
        : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp'
        : 'image/jpeg'
      blocks.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } })
      logger.info({ filePath, mime, bytes: data.length }, 'Encoded image for LM Studio vision')
    } catch (err) {
      logger.warn({ filePath, err }, 'Failed to read image for vision, skipping')
    }
  }

  if (blocks.length === 0) return message

  blocks.push({ type: 'text', text: textPart || 'Please analyze this image.' })
  return blocks
}

// Stringify content for history seed/export (arrays become "[image + text]" placeholder)
function contentToString(content: string | null | ContentBlock[]): string {
  if (content === null) return ''
  if (typeof content === 'string') return content
  const text = content.find((b): b is TextBlock => b.type === 'text')?.text ?? ''
  const imgCount = content.filter((b) => b.type === 'image_url').length
  return imgCount > 0 ? `[${imgCount} image(s)] ${text}`.trim() : text
}

// Pick the assistant's user-facing content. Qwen 3.5 thinking models can
// exhaust their token budget on reasoning_content and return empty content;
// in that case fall back to the reasoning trace so the user gets something.
export function pickAssistantContent(
  msg: { content?: string | null; reasoning_content?: string | null }
): { content: string | null; usedReasoningFallback: boolean } {
  if (msg.content) return { content: msg.content, usedReasoningFallback: false }
  if (msg.reasoning_content) return { content: msg.reasoning_content, usedReasoningFallback: true }
  return { content: msg.content ?? null, usedReasoningFallback: false }
}

// ============================================================
// Vision preprocessing — Gemini Flash describes images
// ============================================================

async function describeImage(base64: string, mimeType: string): Promise<string | null> {
  if (!GOOGLE_API_KEY_VAL) {
    logger.warn('[Vision] No Gemini key available, cannot describe image')
    return null
  }
  const gStart = Date.now()
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_API_KEY_VAL}`
    const res = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            { text: VISION_DESCRIBE_PROMPT },
          ],
        }],
        generationConfig: { maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      const body = await res.text()
      logger.warn({ status: res.status, body: body.slice(0, 200) }, '[Vision] Gemini API error')
      return null
    }
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
    logger.info({ ms: Date.now() - gStart }, '[Vision] Gemini described image')
    return text || null
  } catch (err) {
    logger.warn({ err, ms: Date.now() - gStart }, '[Vision] Gemini describe failed')
    return null
  }
}

function applyVisionDescriptions(message: string, descMap: Map<string, string>): string {
  return message.replace(new RegExp(PHOTO_MARKER.source, 'g'), (_, filePath) => {
    const desc = descMap.get(filePath.trim())
    return desc ? `[Image analysis by Gemini: ${desc}]` : '[Image: could not be analyzed]'
  })
}

async function preprocessPhotoMessage(
  rawMessage: string,
  augmentedMessage: string,
): Promise<{ processedRaw: string; processedMessage: string } | null> {
  const photoMatches = [...rawMessage.matchAll(new RegExp(PHOTO_MARKER.source, 'g'))]
  if (photoMatches.length === 0) return { processedRaw: rawMessage, processedMessage: augmentedMessage }

  const descMap = new Map<string, string>()
  for (const match of photoMatches) {
    const filePath = match[1].trim()
    if (descMap.has(filePath)) continue
    if (!existsSync(filePath) || !IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())) {
      descMap.set(filePath, '')
      continue
    }
    try {
      const imgData = readFileSync(filePath)
      const b64 = imgData.toString('base64')
      const ext = extname(filePath).toLowerCase().slice(1)
      const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
        : ext === 'png' ? 'image/png'
        : ext === 'gif' ? 'image/gif'
        : 'image/webp'
      const description = await describeImage(b64, mime)
      if (description === null && descMap.size === 0) {
        // Vision API unreachable — continue with empty descriptions (placeholder text)
        // Do NOT return null, which would trigger base64 fallback and cause context overflow
      }
      descMap.set(filePath, description ?? '')
    } catch (err) {
      logger.warn({ filePath, err }, '[Vision] Failed to read image for preprocessing')
      descMap.set(filePath, '')
    }
  }

  return {
    processedRaw: applyVisionDescriptions(rawMessage, descMap),
    processedMessage: applyVisionDescriptions(augmentedMessage, descMap),
  }
}

// ============================================================
// Tool definitions (OpenAI function calling format)
// ============================================================

export const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description: 'Run a shell command on this machine. Returns stdout/stderr. Prefer portable commands.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ssh_remote-host',
      description: 'Run a shell command on an optional remote machine via SSH. Requires REMOTE_SSH_TARGET in .env (e.g. user@host). 5-minute timeout. Only enable if you trust that host.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run on REMOTE_SSH_TARGET (ssh).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file and return its contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates or overwrites.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'The content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'List files in a directory with type and size.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the web. Alias for grounded_search -- returns a synthesized answer with citations from Google.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return readable text content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          max_chars: { type: 'number', description: 'Max characters to return (default 4000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browse_url',
      description: 'Fetch a URL using a headless browser (renders JavaScript). Use for pages that web_fetch returns little content from.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to browse' },
          max_chars: { type: 'number', description: 'Max characters to return (default 8000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'escalate',
      description: 'Hand off to Claude (smarter model) when the task needs deep analysis, code generation, complex multi-step work, or you are struggling to produce a good answer.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Brief reason for escalation' },
          context: { type: 'string', description: 'Key context to pass to Claude' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_navigate',
      description: 'Navigate to a URL in a persistent browser session. Returns page text content. Login sessions are preserved across calls. Use for interactive browsing when browse_url is not enough.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          profile: { type: 'string', description: 'Browser profile name (default: "default"). Use named profiles for separate login sessions.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_click',
      description: 'Click an element on the current browser page by CSS selector or text content.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector or text:="visible text" to click' },
          profile: { type: 'string', description: 'Browser profile (default: "default")' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_fill',
      description: 'Fill a form field with text in the browser.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input field' },
          value: { type: 'string', description: 'Text to type into the field' },
          profile: { type: 'string', description: 'Browser profile (default: "default")' },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current browser page. Returns the file path of the saved screenshot.',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Browser profile (default: "default")' },
          full_page: { type: 'boolean', description: 'Capture full scrollable page (default: false)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_get_content',
      description: 'Get the text content of the current browser page without navigating.',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Browser profile (default: "default")' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'grounded_search',
      description: 'Search the web using Google Gemini with search grounding. Returns a synthesized answer with citations from real-time Google Search results. Use this for current events, factual lookups, research questions, and anything that needs up-to-date web information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query or question' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'schedule_task',
      description: 'Create a scheduled task that fires at a cron-defined time. Timezone: America/Chicago. IMPORTANT: default one_shot=true. Only pass one_shot=false when the user explicitly used recurring language ("every", "daily", "weekly", "monthly", "yearly", "each", "recurring"). One-shots auto-pause after running so they fire exactly once. For "just run this shell command on a schedule" pass task_type="raw" — the scheduler will execSync the prompt without invoking an LLM, which is faster and frees the 397B model.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'For task_type=llm (default): what the model should do when it fires. For task_type=raw: the literal shell command to execSync.' },
          cron: { type: 'string', description: 'Cron expression in 5-field format: "MIN HOUR DOM MONTH DOW". Examples: "0 9 * * 1" (Mon 9am), "0 15 23 5 *" (May 23 3pm), "0 12 1-7 * 1" (first Monday of month at noon).' },
          one_shot: { type: 'boolean', description: 'Default true. Set false ONLY if the user said "every", "daily", "weekly", "monthly", "yearly", "each", or "recurring".' },
          task_type: { type: 'string', description: '"llm" (default) or "raw". Raw skips the LLM and just execSyncs the prompt as a shell command.' },
          raw_output_mode: { type: 'string', description: 'For raw tasks: "chat" (default, sends stdout to chat) or "log" (silent — only journal).' },
        },
        required: ['prompt', 'cron'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_tasks',
      description: "List your scheduled tasks. Returns id, status, schedule, next-run, one_shot, and prompt snippet.",
      parameters: {
        type: 'object',
        properties: {
          include_paused: { type: 'boolean', description: 'If true, include paused tasks (default false: active only).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'pause_task',
      description: 'Pause a scheduled task by fuzzy match against its prompt. Match against keywords the user used (e.g. "May to-do check-in", "hardware report"). If multiple tasks match, the tool returns a list -- ask the user which one.',
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Words from the task description to match against. Do not use task IDs.' },
        },
        required: ['match'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'resume_task',
      description: 'Resume a paused scheduled task by fuzzy match against its prompt.',
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Words from the task description to match against.' },
        },
        required: ['match'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_task',
      description: 'Permanently delete a scheduled task by fuzzy match against its prompt. If multiple tasks match, returns a disambiguation list.',
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Words from the task description to match against.' },
        },
        required: ['match'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description: 'Update an existing scheduled task by fuzzy match. Change any subset of: cron schedule, prompt text, or one_shot flag.',
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Words from the task description to match against.' },
          cron: { type: 'string', description: 'New cron expression (5-field). Omit to leave unchanged.' },
          prompt: { type: 'string', description: 'New prompt text. Omit to leave unchanged.' },
          one_shot: { type: 'boolean', description: 'New one_shot flag. Omit to leave unchanged.' },
        },
        required: ['match'],
      },
    },
  },
  // ============================================================
  // Google Calendar
  // ============================================================
  {
    type: 'function' as const,
    function: {
      name: 'calendar_list_events',
      description: 'List events on the user\'s Google Calendar. Default account is "work" (work@example.com). Accepts natural dates like "today", "tomorrow", "this week", "next week", weekday names, or ISO datetimes.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '"personal" (you@example.com) or "work" (work@example.com). Default: work.' },
          start: { type: 'string', description: 'Window start. Natural ("today") or ISO. Default: now.' },
          end: { type: 'string', description: 'Window end. Natural or ISO. Default: 7 days from start.' },
          max: { type: 'number', description: 'Max events to return (cap 50). Default 20.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'calendar_create_event',
      description: 'Create a new calendar event. If attendees are provided, Google sends invites — confirm with the user first.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '"personal" or "work". Default: work.' },
          title: { type: 'string', description: 'Event title.' },
          start: { type: 'string', description: 'ISO datetime or natural ("tomorrow 2pm" — but be careful, prefer ISO).' },
          end: { type: 'string', description: 'ISO datetime. Required.' },
          description: { type: 'string' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite.' },
          location: { type: 'string' },
        },
        required: ['title', 'start', 'end'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'calendar_find_free_slot',
      description: 'Find the first contiguous free slot of N minutes in the window. Use before suggesting meeting times.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '"personal" or "work". Default: work.' },
          duration_minutes: { type: 'number', description: 'Required slot length in minutes.' },
          start: { type: 'string', description: 'Window start. Default: now.' },
          end: { type: 'string', description: 'Window end. Default: 7 days from start.' },
          business_hours_only: { type: 'boolean', description: 'Restrict to Mon-Fri 9am-6pm CT. Default true.' },
        },
        required: ['duration_minutes'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'calendar_cancel_event',
      description: 'Cancel a calendar event by id, or by fuzzy match against summaries in the next 14 days. If the event has attendees, this notifies them — confirm with the user first.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '"personal" or "work". Default: work.' },
          event_id: { type: 'string', description: 'Exact Google event id.' },
          match: { type: 'string', description: 'Fuzzy match against event summaries.' },
          window_days: { type: 'number', description: 'Fuzzy match scope in days. Default 14.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'calendar_update_event',
      description: 'Update an existing calendar event by id. Title/time/attendees changes notify existing attendees.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '"personal" or "work". Default: work.' },
          event_id: { type: 'string', description: 'Required.' },
          title: { type: 'string' },
          start: { type: 'string', description: 'ISO datetime.' },
          end: { type: 'string', description: 'ISO datetime.' },
          description: { type: 'string' },
          add_attendees: { type: 'array', items: { type: 'string' } },
          remove_attendees: { type: 'array', items: { type: 'string' } },
        },
        required: ['event_id'],
      },
    },
  },
  // ============================================================
  // Google Tasks
  // ============================================================
  {
    type: 'function' as const,
    function: {
      name: 'task_create',
      description: 'Create a Google Tasks item in the user\'s todo list. Use this for "add to my todos" intent — distinct from schedule_task (which fires a time-triggered reminder message).',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '"personal" or "work". Default: work.' },
          title: { type: 'string' },
          notes: { type: 'string' },
          due: { type: 'string', description: 'ISO date (YYYY-MM-DD) or natural ("tomorrow"). Optional.' },
          list: { type: 'string', description: 'Task list name. Default: primary.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task_list',
      description: 'List open Google Tasks.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '"personal" or "work". Default: work.' },
          list: { type: 'string', description: 'Task list name. Default: primary.' },
          show_completed: { type: 'boolean', description: 'Include completed items. Default false.' },
          max: { type: 'number', description: 'Cap on items returned. Default 20.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task_complete',
      description: 'Mark a Google Tasks item as completed by fuzzy match against title.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '"personal" or "work". Default: work.' },
          match: { type: 'string', description: 'Words from the task title.' },
        },
        required: ['match'],
      },
    },
  },
  // ============================================================
  // Gmail
  // ============================================================
  {
    type: 'function' as const,
    function: {
      name: 'gmail_list_unread',
      description: 'List unread emails in the inbox. Default account: personal (you@example.com).',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '"personal" or "work". Default: personal.' },
          max: { type: 'number', description: 'Max emails to list (cap 30). Default 10.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gmail_read_email',
      description: 'Fetch the full plain-text body of a Gmail message by id.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string' },
          message_id: { type: 'string' },
        },
        required: ['message_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gmail_search',
      description: 'Search Gmail using Gmail query syntax (from:, to:, subject:, after:, before:, has:attachment, label:, is:unread/important/starred).',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string' },
          query: { type: 'string' },
          max: { type: 'number', description: 'Default 10, cap 30.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gmail_draft_reply',
      description: 'SAFE — creates a draft reply that the user reviews in Gmail. Does NOT send. Use this freely.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string' },
          thread_id: { type: 'string', description: 'Gmail thread id to reply to.' },
          body: { type: 'string' },
        },
        required: ['thread_id', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gmail_send_email',
      description: 'SENDS EMAIL IMMEDIATELY. Never call without explicit "send" intent from the user in the current turn. Prefer gmail_draft_reply when in doubt.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string' },
          to: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string' },
          cc: { type: 'array', items: { type: 'string' } },
          reply_to_thread_id: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  // ============================================================
  // GitHub (via gh CLI)
  // ============================================================
  {
    type: 'function' as const,
    function: {
      name: 'gh_create_issue',
      description: 'File a GitHub issue. Uses GITHUB_DEFAULT_REPO from env (owner/name). Pass repo= to override.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name. Optional.' },
          title: { type: 'string' },
          body: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          assignees: { type: 'array', items: { type: 'string' } },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gh_list_issues',
      description: 'List GitHub issues.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          state: { type: 'string', description: '"open" | "closed" | "all". Default open.' },
          label: { type: 'string' },
          assignee: { type: 'string' },
          max: { type: 'number', description: 'Default 20.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gh_search_code',
      description: 'Search code in a GitHub repo. Uses GitHub code search syntax.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          query: { type: 'string' },
          max: { type: 'number', description: 'Default 15.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gh_pr_status',
      description: 'List open PRs in a repo or get a single PR by number.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          pr_number: { type: 'number', description: 'If omitted, lists open PRs.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gh_recent_commits',
      description: 'List recent commits on a branch.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          branch: { type: 'string', description: 'Default "dev".' },
          since: { type: 'string', description: 'ISO date or "1 week ago". Optional.' },
          max: { type: 'number', description: 'Default 20.' },
        },
      },
    },
  },
  // ============================================================
  // Convex (Convex DB)
  // ============================================================
  {
    type: 'function' as const,
    function: {
      name: 'convex_query',
      description: 'Run a read-only Convex query against your Convex project. Use env="prod" only when the user explicitly says "production" or "prod".',
      parameters: {
        type: 'object',
        properties: {
          env: { type: 'string', description: '"dev" (default) or "prod".' },
          function_name: { type: 'string', description: 'e.g. "coaches:list", "billing:revenueByMonth".' },
          args: { type: 'object', description: 'Function arguments as a JSON object.' },
        },
        required: ['function_name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'convex_run',
      description: 'Run a Convex MUTATION. Writes data. Requires confirm="yes mutate dev" or confirm="yes mutate prod" in the args — the user must say those exact words in the current turn.',
      parameters: {
        type: 'object',
        properties: {
          env: { type: 'string', description: '"dev" or "prod".' },
          function_name: { type: 'string' },
          args: { type: 'object' },
          confirm: { type: 'string', description: 'Required. Must equal "yes mutate dev" or "yes mutate prod" exactly.' },
        },
        required: ['env', 'function_name', 'confirm'],
      },
    },
  },
  // ============================================================
  // Long-running command wrapper
  // ============================================================
  {
    type: 'function' as const,
    function: {
      name: 'run_long_command',
      description: 'Run a shell command in the background (detached). Returns immediately. The actual command runs with no time limit from the bot — when it finishes, the user gets a Telegram message with the exit code and last 1000 chars of output. Use for anything >60s (bash tool has a 60s timeout). Same label = dedup via flock.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          label: { type: 'string', description: 'Short human-readable label, e.g. "data export", "ffmpeg convert".' },
          silent: { type: 'boolean', description: 'If true, no notification on success (failure still notifies). Default false.' },
          timeout_minutes: { type: 'number', description: 'Hard timeout in minutes (1-120, default 30).' },
        },
        required: ['command', 'label'],
      },
    },
  },
  // ============================================================
  // Utility tools
  // ============================================================
  {
    type: 'function' as const,
    function: {
      name: 'search_my_chats',
      description: "Full-text search your own chat history (conversation_log + LM Studio history). Useful for 'what did you tell me about X two weeks ago' or 'what did I say about NH housing'.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', description: 'Max matches to return. Default 15, cap 50.' },
          role: { type: 'string', description: '"user", "assistant", or "any" (default).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'stock_price',
      description: 'Current price + day stats for one or more tickers (US markets). Yahoo Finance unauth endpoint.',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, description: 'Ticker symbols, e.g. ["AAPL","TSLA"].' },
        },
        required: ['symbols'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'stock_news',
      description: 'Recent news headlines for a ticker via Yahoo Finance RSS.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          max: { type: 'number', description: 'Default 8.' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Current weather + 3-day forecast for a location. Free, no key (Open-Meteo).',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name or "lat,lon". E.g. "Austin TX", "Portsmouth NH".' },
          days: { type: 'number', description: 'Forecast days (1-7, default 3).' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'shorten_url',
      description: 'Shorten a URL via is.gd. Returns the short link.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_qr',
      description: 'Generate a QR code for arbitrary text or a URL. Saves a PNG to workspace/uploads which is then sent as a photo.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          size: { type: 'number', description: 'Pixel width (default 400).' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'calculate',
      description: 'Evaluate a math expression. Handles arithmetic, units (e.g. "3 inches to cm"), trig, percentages. Use this for any math — qwen is bad at arithmetic.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'convert_file',
      description: 'Convert a file between formats. Supports: pdf->text, doc/docx->text via pandoc, image resize/format change (png/jpg/webp), audio re-encode (ogg/mp3/wav). Output lands in workspace/uploads/.',
      parameters: {
        type: 'object',
        properties: {
          input_path: { type: 'string' },
          output_format: { type: 'string', description: 'e.g. "txt", "png", "jpg", "webp", "mp3", "wav", "ogg".' },
          options: { type: 'object', description: 'Optional flags. For images: { width: number, height: number }.' },
        },
        required: ['input_path', 'output_format'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'quick_note',
      description: "Append a quick note to your running scratchpad (workspace/scratchpad.md). For voice-dictated ideas and stray thoughts. Distinct from memory — this is your notebook, not Qwen's context.",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          tag: { type: 'string', description: 'Optional category tag (e.g. "work", "home", "idea"). Becomes a Markdown tag.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'system_status',
      description: 'Aggregate health check: host system (RAM/disk/uptime/service), LM Studio reachability + models, your Mac (optional) if MAC_SSH_TARGET is set, Convex if configured. One command.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_presentation',
      description:
        'Build a presentation from content-only deck-spec (NOT HTML/python). Pipeline: coerce→validate→render HTML+PPTX→Funnel URL. Returns JSON with PRESENT_URL. On ok:false, fix listed fields and retry (max 3). Prefer 8-12 slides, short bullets.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Deck title.' },
          author: { type: 'string' },
          subtitle: { type: 'string' },
          theme: {
            type: 'string',
            description: 'midnight (default) | charcoal | light | coral | forest',
          },
          brand: {
            type: 'string',
            description: 'personalos (default, logo mark) | wayfinder | none. Or pass logo path via logo field.',
          },
          logo: { type: 'string', description: 'Optional logo file path or URL (embedded in HTML).' },
          logo_text: { type: 'string', description: 'Wordmark next to logo.' },
          motif: {
            type: 'string',
            description: 'Background motif: orbs|mesh|grid|bars|aurora|none. Default orbs.',
          },
          vibe: {
            type: 'string',
            description: 'Typography/feel: keynote|product|technical|bold. Default keynote.',
          },
          accent: {
            type: 'string',
            description: 'Accent override: default|electric|amber|mint|rose|violet.',
          },
          format: {
            type: 'string',
            description: 'both (default) | html | pptx. Use both unless asked otherwise.',
          },
          output_format: { type: 'string', description: 'Same as format.' },
          filename: { type: 'string', description: 'Output basename without extension.' },
          publish: {
            type: 'boolean',
            description: 'Public Funnel PRESENT_URL (default true).',
          },
          slides: {
            type: 'array',
            description:
              'Slides. type: title|section|content|two-column|compare|stats|quote|code. Optional layout: content list|cards|numbered|spotlight; title center|left|bold.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                layout: { type: 'string' },
                title: { type: 'string' },
                subtitle: { type: 'string' },
                eyebrow: { type: 'string' },
                body: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
                notes: { type: 'string' },
                quote: { type: 'string' },
                attribution: { type: 'string' },
                code: { type: 'string' },
                language: { type: 'string' },
                left_title: { type: 'string' },
                right_title: { type: 'string' },
                left: {},
                right: {},
                stats: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string' },
                      label: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        required: ['title', 'slides'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'apple_reminder_add',
      description: 'Add a new Apple Reminders item via SSH to the your Mac (optional). Requires MAC_SSH_TARGET env (e.g. "user@127.0.0.1") and SSH key auth.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          due: { type: 'string', description: 'ISO datetime or natural ("tomorrow 9am"). Optional.' },
          list: { type: 'string', description: 'Reminders list name. Optional.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'apple_reminders_list',
      description: 'List open Apple Reminders via SSH to your Mac (set MAC_SSH_TARGET).',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string', description: 'Filter to one list by name.' },
          max: { type: 'number', description: 'Default 20.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'apple_notes_search',
      description: 'Search Apple Notes by title/body via SSH to your Mac (set MAC_SSH_TARGET).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'apple_note_create',
      description: 'Create a new Apple Note via SSH to your Mac (set MAC_SSH_TARGET).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['title', 'body'],
      },
    },
  },
  // ============================================================
  // project E2E (Playwright)
  // ============================================================
  {
    type: 'function' as const,
    function: {
      name: 'run_e2e_tests',
      description: 'Launch the project Playwright E2E suite on this machine (requires E2E scripts + WORK_PROJECT_DIR). Detached — returns immediately. Manages the server (starts dev on :3001 or E2E_PROD prod on :3002, killing stale listeners on that port first), runs tests, and posts a Telegram summary when done. Full suite takes 30-45 min; light is 2-3 min. flock prevents concurrent runs.',
      parameters: {
        type: 'object',
        properties: {
          spec: { type: 'string', description: 'Optional --grep pattern (test file name or tag), e.g. "calendar" or "persistent-meetings".' },
          workers: { type: 'number', description: 'Parallel workers. Default 2.' },
          project: { type: 'string', description: '"full" (default, ~30-45 min), "light" (~2-3 min, @light-tagged only), or "qa" (on-demand niche tests).' },
          mode: { type: 'string', description: '"dev" (default, Next.js dev server on :3001) or "prod" (E2E_PROD=1 prod build on :3002).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'e2e_status',
      description: 'Report status of the current or last E2E run: in-progress flag, dev-server health, latest log size, last progress markers, and tail of the log.',
      parameters: { type: 'object', properties: {} },
    },
  },
]

// Escalation marker -- bot.ts checks for this prefix to trigger Claude fallback
const ESCALATION_PREFIX = '__ESCALATE__'

// ============================================================
// Safety (mirrors ollama.ts safety checks)
// ============================================================


function resolveUserPath(p: string): string {
  if (path.isAbsolute(p)) return path.normalize(p)
  return path.join(os.homedir(), p)
}

const WRITABLE_PATHS = [os.homedir() + path.sep, os.tmpdir() + path.sep, path.resolve('.') + path.sep]

const BLOCKED_READ_PATHS = [
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), '.env'),
  '/etc/shadow',
  '/etc/passwd',
]

const BLOCKED_COMMANDS = [
  /\bsudo\b/,
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/i,
  /\brm\s+-[a-z]*R/i,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\bformat\b/,
  /\bshred\b/,
  /\bwipe\b/,
  /\b(shutdown|reboot|poweroff|halt|init\s+[0-6])\b/,
  /\bsystemctl\s+(stop|disable|mask|restart)\s+(?!--user)/,
  /\bchmod\s+[0-7]*777\b/,
  /\bchown\b/,
  /\bcurl\s.*\|\s*(ba)?sh\b/,
  /\bwget\s.*\|\s*(ba)?sh\b/,
  />\s*\/dev\/sd/,
  />\s*\/etc\//,
  />\s*\/boot\//,
  /\biptables\b/,
  /\bkill\s+-9\b/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bnohup\b.*&/,
  /\bcrontab\s+-r\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /:\(\)\s*\{\s*:\|:&\s*\}/,
]

function isBashBlocked(command: string): string | null {
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) return `Blocked: ${pattern.source}`
  }
  return null
}

function isPathBlocked(path: string, write: boolean): string | null {
  const resolved = resolveUserPath(path)
  for (const blocked of BLOCKED_READ_PATHS) {
    if (resolved.startsWith(blocked) || resolved === blocked) {
      return `Blocked path: ${blocked}`
    }
  }
  if (write && !WRITABLE_PATHS.some((p) => resolved.startsWith(p))) {
    return `Write not allowed outside: ${WRITABLE_PATHS.join(', ')}`
  }
  return null
}

// ============================================================
// Tool execution
// ============================================================

// ============================================================
// Fuzzy match scheduled tasks by prompt keywords
// ============================================================

const FUZZY_STOPWORDS = new Set([
  'the','a','an','and','or','but','my','me','for','of','to','in','on','at','task','tasks','one','shot','oneshot',
  'reminder','remind','schedule','scheduled','that','this','please','about','update','change','set',
])

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length >= 3 && !FUZZY_STOPWORDS.has(t))
}

function findTaskByMatch(match: string, opts: { includePaused?: boolean } = {}): { task?: ScheduledTask; candidates: ScheduledTask[] } {
  const all = getAllTasks().filter(t => opts.includePaused ? true : t.status === 'active')
  const tokens = tokenize(match)
  if (tokens.length === 0) return { candidates: [] }

  // Allow exact id-prefix match as a power-user shortcut
  const idMatch = all.find(t => t.id.startsWith(match.toLowerCase().trim()) && match.trim().length >= 4)
  if (idMatch) return { task: idMatch, candidates: [idMatch] }

  const scored = all
    .map(t => {
      const haystack = t.prompt.toLowerCase()
      const score = tokens.reduce((acc, tok) => acc + (haystack.includes(tok) ? 1 : 0), 0)
      return { t, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.t.created_at - a.t.created_at)

  if (scored.length === 0) return { candidates: [] }
  // Unique top score wins
  const top = scored[0]
  const tied = scored.filter(s => s.score === top.score)
  if (tied.length === 1) return { task: top.t, candidates: scored.map(s => s.t) }
  return { candidates: tied.map(s => s.t) }
}

function formatTaskRow(t: ScheduledTask): string {
  const next = new Date(t.next_run * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' })
  const snippet = t.prompt.replace(/\s+/g, ' ').slice(0, 70)
  const oneShot = t.one_shot ? ' [one-shot]' : ''
  return `${t.id} | ${t.status} | ${t.schedule} | next: ${next}${oneShot} | ${snippet}`
}

function formatCandidates(cands: ScheduledTask[]): string {
  return cands.slice(0, 10).map(formatTaskRow).join('\n')
}

export async function executeTool(name: string, args: Record<string, unknown>, chatId: string): Promise<string> {
  switch (name) {
    case 'bash': {
      const command = String(args.command ?? '')
      const blocked = isBashBlocked(command)
      if (blocked) {
        logger.warn({ tool: name, command, reason: blocked }, 'BLOCKED tool call')
        return `BLOCKED: ${blocked}. Try a different approach.`
      }
      try {
        const result = execSync(command, {
          encoding: 'utf-8',
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        return (result.slice(0, 8000) || '(no output)')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `Error: ${msg.slice(0, 2000)}`
      }
    }

    case 'ssh_remote-host': {
      const command = String(args.command ?? '')
      if (!command.trim()) return 'Error: empty command'
      try {
        const remoteTarget = env['REMOTE_SSH_TARGET'] || ''
        if (!remoteTarget) return 'REMOTE_SSH_TARGET not set in .env — optional remote SSH disabled.'
        const result = spawnSync('ssh', [remoteTarget, command], {
          encoding: 'utf-8',
          timeout: 300_000,
          maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        if (result.error) return `Error invoking ssh: ${String(result.error).slice(0, 2000)}`
        const stdout = (result.stdout ?? '').slice(0, 7500)
        const stderr = (result.stderr ?? '').slice(0, 1500)
        let out = stdout
        if (stderr.trim()) out += `\n--- stderr ---\n${stderr}`
        if (result.status !== 0) out = `(exit=${result.status})\n${out}`
        return out || '(no output)'
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `Error: ${msg.slice(0, 2000)}`
      }
    }

    case 'read_file': {
      const path = String(args.path ?? '')
      const blocked = isPathBlocked(path, false)
      if (blocked) return `BLOCKED: ${blocked}`
      // PDFs and other binary formats are unreadable as utf-8 -- redirect the
      // model to the right tool instead of dumping binary garbage.
      const lowerPath = path.toLowerCase()
      if (lowerPath.endsWith('.pdf')) {
        return `BLOCKED: ${path} is a PDF. read_file returns binary garbage for PDFs. Use the bash tool instead:\n  pdftotext "${path}" -\nOr for layout-preserving extraction:\n  pdftotext -layout "${path}" -`
      }
      if (/\.(docx|xlsx|pptx|odt|ods|odp)$/.test(lowerPath)) {
        return `BLOCKED: ${path} is an Office/ODF document. read_file cannot parse it. Use bash:\n  pandoc "${path}" -t plain`
      }
      if (/\.(png|jpg|jpeg|gif|webp|bmp|tiff?|heic|mp3|mp4|mov|m4a|ogg|opus|wav|flac|zip|tar|gz|bz2|7z|exe|dll|so)$/.test(lowerPath)) {
        return `BLOCKED: ${path} is a binary file. read_file only works on text. Use a format-appropriate tool via bash, or skip the file.`
      }
      try {
        const content = readFileSync(path, 'utf-8')
        return content.length > 32000 ? content.slice(0, 32000) + '\n... (truncated)' : content
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'write_file': {
      const path = String(args.path ?? '')
      const blocked = isPathBlocked(path, true)
      if (blocked) return `BLOCKED: ${blocked}`
      try {
        const content = String(args.content ?? '')
        writeFileSync(path, content)
        return `Written ${content.length} bytes to ${path}`
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'list_directory': {
      const path = String(args.path ?? '')
      const blocked = isPathBlocked(path, false)
      if (blocked) return `BLOCKED: ${blocked}`
      try {
        const entries = readdirSync(path)
        const lines = entries.slice(0, 100).map((e) => {
          try {
            const stat = statSync(`${path}/${e}`)
            const type = stat.isDirectory() ? 'dir' : 'file'
            const size = stat.isDirectory() ? '' : ` (${stat.size}b)`
            return `${type}  ${e}${size}`
          } catch {
            return `???  ${e}`
          }
        })
        return lines.join('\n') || '(empty directory)'
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'web_search': {
      // Alias for grounded_search. The old DuckDuckGo HTML scraper got blocked
      // by anti-bot pages, and Gemini grounding works reliably, so web_search
      // now just dispatches to grounded_search.
      return await executeTool('grounded_search', { query: String(args.query ?? '') }, chatId)
    }


    case 'grounded_search': {
      const query = String(args.query ?? '')
      if (!GOOGLE_API_KEY_VAL) return '[Gemini API key not configured]'
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_API_KEY_VAL}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: query }] }],
              tools: [{ google_search: {} }],
            }),
            signal: AbortSignal.timeout(20000),
          }
        )
        const data = await res.json() as any
        if (!res.ok) return `Gemini error ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`
        const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        const grounding = data.candidates?.[0]?.groundingMetadata
        let citations = ''
        if (grounding?.groundingChunks) {
          citations = '\n\nSources:\n' + (grounding.groundingChunks as any[])
            .filter((c: any) => c.web?.uri)
            .map((c: any) => `- ${c.web.title || 'Source'}: ${c.web.uri}`)
            .join('\n')
        }
        return text + citations
      } catch (err) {
        return `grounded_search error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'web_fetch': {
      const url = String(args.url ?? '')
      if (/^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/i.test(url)) {
        return 'BLOCKED: Cannot fetch internal/local URLs'
      }
      const limit = Math.min(Number(args.max_chars ?? 8000), 16000)
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
            Accept: 'text/html,application/xhtml+xml,text/plain',
          },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return `HTTP ${res.status}: Failed to fetch ${url}`
        const contentType = res.headers.get('content-type') ?? ''
        const rawText = await res.text()
        if (contentType.includes('text/plain') || contentType.includes('application/json')) {
          return rawText.slice(0, limit)
        }
        let text = rawText
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
          .replace(/<h[1-6][^>]*>/gi, '\n## ')
          .replace(/<\/h[1-6]>/gi, '\n')
          .replace(/<li[^>]*>/gi, '\n- ')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<p[^>]*>/gi, '\n')
          .replace(/<\/p>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n\s*\n/g, '\n\n')
          .trim()
        if (text.length < 50) return `Page at ${url} returned very little readable text (may require JavaScript).`
        return text.slice(0, limit) + (text.length > limit ? '\n... (truncated)' : '')
      } catch (err) {
        return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'browse_url': {
      const url = String(args.url ?? '')
      if (/^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/i.test(url)) {
        return 'BLOCKED: Cannot fetch internal/local URLs'
      }
      const limit = Math.min(Number(args.max_chars ?? 8000), 16000)
      try {
        // Use Playwright if available, fall back to enhanced fetch
        const result = execSync(
          `node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch({headless:true});const p=await b.newPage();await p.goto(${JSON.stringify(url)},{waitUntil:'networkidle',timeout:30000});const t=await p.innerText('body');await b.close();process.stdout.write(t);})()" 2>/dev/null`,
          { encoding: 'utf-8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024 }
        )
        return result.slice(0, limit) + (result.length > limit ? '\n... (truncated)' : '')
      } catch {
        // Playwright not available -- fall back to curl + readability heuristic
        try {
          const html = execSync(
            `curl -sL --max-time 15 -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" ${JSON.stringify(url)}`,
            { encoding: 'utf-8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }
          )
          let text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s*\n\s*\n/g, '\n\n')
            .trim()
          if (text.length < 50) return `Page at ${url} returned very little readable text (JS-rendered content not available without Playwright).`
          return text.slice(0, limit) + (text.length > limit ? '\n... (truncated)' : '')
        } catch (err) {
          return `Error browsing ${url}: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    case 'escalate': {
      const reason = String(args.reason ?? 'Model requested escalation')
      const context = args.context ? String(args.context) : undefined
      logger.info({ reason, context }, 'LM Studio model requested escalation to Claude')
      return `${ESCALATION_PREFIX}${JSON.stringify({ reason, context })}`
    }

    case 'browser_navigate': {
      const url = String(args.url ?? '')
      if (/^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/i.test(url)) {
        return 'BLOCKED: Cannot browse internal/local URLs'
      }
      const profile = String(args.profile ?? 'default')
      return await navigateTo(url, profile)
    }

    case 'browser_click': {
      const selector = String(args.selector ?? '')
      const profile = String(args.profile ?? 'default')
      return await clickElement(selector, profile)
    }

    case 'browser_fill': {
      const selector = String(args.selector ?? '')
      const value = String(args.value ?? '')
      const profile = String(args.profile ?? 'default')
      return await fillField(selector, value, profile)
    }

    case 'browser_screenshot': {
      const profile = String(args.profile ?? 'default')
      const fullPage = Boolean(args.full_page ?? false)
      const filepath = await takeScreenshot(profile, fullPage)
      return `Screenshot saved: ${filepath}`
    }

    case 'browser_get_content': {
      const profile = String(args.profile ?? 'default')
      return await getPageContent(profile)
    }

    case 'schedule_task': {
      const prompt = String(args.prompt ?? '').trim()
      const cron = String(args.cron ?? '').trim()
      const oneShot = args.one_shot === undefined ? true : Boolean(args.one_shot)
      const taskType = args.task_type === 'raw' ? 'raw' : 'llm'
      const rawOutputMode = taskType === 'raw'
        ? (args.raw_output_mode === 'log' ? 'log' : 'chat')
        : null
      if (!prompt) return 'Error: prompt is required.'
      if (!cron) return 'Error: cron expression is required.'
      if (!/^\d{5,}$/.test(chatId) && !chatId.startsWith('discord-')) {
        return `Error: cannot schedule from chat_id "${chatId}" (must be a numeric Telegram/Discord ID). Tasks created from scheduler-internal sessions are not supported.`
      }
      if (taskType === 'raw') {
        const blocked = isBashBlocked(prompt)
        if (blocked) return `BLOCKED: raw task command rejected -- ${blocked}`
      }
      let nextRun: number
      try {
        const expr = CronExpressionParser.parse(cron, { tz: 'America/Chicago' })
        nextRun = Math.floor(expr.next().getTime() / 1000)
      } catch (err) {
        return `Error: invalid cron expression "${cron}": ${err instanceof Error ? err.message : String(err)}`
      }
      const id = randomUUID().slice(0, 8)
      try {
        createTask(id, chatId, prompt, cron, nextRun, taskType === 'raw' ? undefined : 'lmstudio', oneShot, taskType, rawOutputMode)
      } catch (err) {
        return `Error creating task: ${err instanceof Error ? err.message : String(err)}`
      }
      const nextStr = new Date(nextRun * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' })
      const typeLabel = taskType === 'raw' ? ` (raw shell, output=${rawOutputMode})` : ''
      return `Created task ${id}${oneShot ? ' (one-shot)' : ' (recurring)'}${typeLabel}\n  Schedule: ${cron}\n  Next run: ${nextStr}\n  Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}`
    }

    case 'list_tasks': {
      const includePaused = Boolean(args.include_paused ?? false)
      const tasks = getAllTasks().filter(t => includePaused ? true : t.status === 'active')
      if (tasks.length === 0) return includePaused ? 'No scheduled tasks.' : 'No active scheduled tasks.'
      tasks.sort((a, b) => a.next_run - b.next_run)
      return `${tasks.length} task${tasks.length === 1 ? '' : 's'}:\n` + tasks.map(formatTaskRow).join('\n')
    }

    case 'pause_task': {
      const match = String(args.match ?? '').trim()
      if (!match) return 'Error: match string required.'
      const { task, candidates } = findTaskByMatch(match)
      if (!task) {
        if (candidates.length === 0) return `No active task matches "${match}".`
        return `Ambiguous -- "${match}" matched ${candidates.length} tasks. Ask which one:\n${formatCandidates(candidates)}`
      }
      setTaskStatus(task.id, 'paused')
      return `Paused: ${formatTaskRow({ ...task, status: 'paused' })}`
    }

    case 'resume_task': {
      const match = String(args.match ?? '').trim()
      if (!match) return 'Error: match string required.'
      const { task, candidates } = findTaskByMatch(match, { includePaused: true })
      if (!task) {
        if (candidates.length === 0) return `No task matches "${match}".`
        return `Ambiguous -- "${match}" matched ${candidates.length} tasks:\n${formatCandidates(candidates)}`
      }
      setTaskStatus(task.id, 'active')
      return `Resumed: ${formatTaskRow({ ...task, status: 'active' })}`
    }

    case 'delete_task': {
      const match = String(args.match ?? '').trim()
      if (!match) return 'Error: match string required.'
      const { task, candidates } = findTaskByMatch(match, { includePaused: true })
      if (!task) {
        if (candidates.length === 0) return `No task matches "${match}".`
        return `Ambiguous -- "${match}" matched ${candidates.length} tasks. Ask which one:\n${formatCandidates(candidates)}`
      }
      dbDeleteTask(task.id)
      return `Deleted: ${task.id} -- ${task.prompt.slice(0, 80)}`
    }

    case 'update_task': {
      const match = String(args.match ?? '').trim()
      if (!match) return 'Error: match string required.'
      const { task, candidates } = findTaskByMatch(match, { includePaused: true })
      if (!task) {
        if (candidates.length === 0) return `No task matches "${match}".`
        return `Ambiguous -- "${match}" matched ${candidates.length} tasks:\n${formatCandidates(candidates)}`
      }
      const changes: string[] = []
      if (typeof args.cron === 'string' && args.cron.trim()) {
        const newCron = String(args.cron).trim()
        let nextRun: number
        try {
          const expr = CronExpressionParser.parse(newCron, { tz: 'America/Chicago' })
          nextRun = Math.floor(expr.next().getTime() / 1000)
        } catch (err) {
          return `Error: invalid cron "${newCron}": ${err instanceof Error ? err.message : String(err)}`
        }
        getDb().prepare('UPDATE scheduled_tasks SET schedule = ?, next_run = ? WHERE id = ?').run(newCron, nextRun, task.id)
        changes.push(`schedule=${newCron}`)
      }
      if (typeof args.prompt === 'string' && args.prompt.trim()) {
        getDb().prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?').run(String(args.prompt), task.id)
        changes.push('prompt updated')
      }
      if (typeof args.one_shot === 'boolean') {
        setTaskOneShot(task.id, args.one_shot)
        changes.push(`one_shot=${args.one_shot}`)
      }
      if (changes.length === 0) return `No changes specified for task ${task.id}.`
      return `Updated ${task.id}: ${changes.join(', ')}`
    }

    // ============================================================
    // Google Calendar
    // ============================================================
    case 'calendar_list_events': {
      const account = (args.account === 'personal' ? 'personal' : 'work') as 'personal' | 'work'
      const now = new Date()
      let startDate: Date
      let endDate: Date
      try {
        startDate = parseWhen(args.start as string | undefined, now)
        const defaultEnd = new Date(startDate.getTime() + 7 * 86_400_000)
        endDate = parseWhen(args.end as string | undefined, defaultEnd)
      } catch (e) {
        return `Error: ${(e as Error).message}`
      }
      const max = Math.min(Math.max(Number(args.max ?? 20), 1), 50)
      try {
        const cal = getCalendar(account)
        const res = await cal.events.list({
          calendarId: 'primary',
          timeMin: startDate.toISOString(),
          timeMax: endDate.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: max,
        })
        const items = res.data.items ?? []
        if (items.length === 0) return `No events on ${account} calendar between ${formatCT(startDate)} and ${formatCT(endDate)}.`
        const lines = items.map(ev => {
          const start = ev.start?.dateTime ?? ev.start?.date ?? '?'
          const end = ev.end?.dateTime ?? ev.end?.date ?? '?'
          const startStr = formatCT(new Date(start))
          const endStr = ev.start?.date ? '(all day)' : new Date(end).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })
          const attendees = ev.attendees?.length ? ` (${ev.attendees.length} attendees)` : ''
          return `  ${ev.id}  ${startStr}${ev.start?.dateTime ? `-${endStr}` : ' ' + endStr}  ${ev.summary ?? '(no title)'}${attendees}`
        })
        return `Events on ${account} calendar (${items.length}):\n${lines.join('\n')}`
      } catch (err) {
        return `Calendar error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'calendar_create_event': {
      const account = (args.account === 'personal' ? 'personal' : 'work') as 'personal' | 'work'
      const title = String(args.title ?? '').trim()
      if (!title) return 'Error: title is required.'
      const startRaw = String(args.start ?? '').trim()
      const endRaw = String(args.end ?? '').trim()
      if (!startRaw || !endRaw) return 'Error: start and end are required.'
      let startDate: Date, endDate: Date
      try {
        startDate = parseWhen(startRaw, new Date())
        endDate = parseWhen(endRaw, new Date(startDate.getTime() + 30 * 60_000))
      } catch (e) {
        return `Error: ${(e as Error).message}`
      }
      if (endDate <= startDate) return 'Error: end must be after start.'
      const attendees = Array.isArray(args.attendees)
        ? (args.attendees as unknown[]).map(a => ({ email: String(a) }))
        : undefined
      try {
        const cal = getCalendar(account)
        const res = await cal.events.insert({
          calendarId: 'primary',
          sendUpdates: attendees ? 'all' : 'none',
          requestBody: {
            summary: title,
            description: args.description ? String(args.description) : undefined,
            location: args.location ? String(args.location) : undefined,
            start: { dateTime: startDate.toISOString(), timeZone: 'America/Chicago' },
            end: { dateTime: endDate.toISOString(), timeZone: 'America/Chicago' },
            attendees,
          },
        })
        return `Created event ${res.data.id} on ${account} calendar: "${title}" ${formatCT(startDate)}. ${res.data.htmlLink ?? ''}`
      } catch (err) {
        return `Calendar error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'calendar_find_free_slot': {
      const account = (args.account === 'personal' ? 'personal' : 'work') as 'personal' | 'work'
      const minutes = Math.max(Number(args.duration_minutes ?? 0), 1)
      if (!minutes) return 'Error: duration_minutes is required and must be > 0.'
      const businessOnly = args.business_hours_only === undefined ? true : Boolean(args.business_hours_only)
      const now = new Date()
      let startDate: Date, endDate: Date
      try {
        startDate = parseWhen(args.start as string | undefined, now)
        const defaultEnd = new Date(startDate.getTime() + 7 * 86_400_000)
        endDate = parseWhen(args.end as string | undefined, defaultEnd)
      } catch (e) {
        return `Error: ${(e as Error).message}`
      }
      try {
        const cal = getCalendar(account)
        const res = await cal.events.list({
          calendarId: 'primary',
          timeMin: startDate.toISOString(),
          timeMax: endDate.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 200,
        })
        const busy = (res.data.items ?? [])
          .filter(ev => ev.start?.dateTime && ev.end?.dateTime)
          .map(ev => ({ s: new Date(ev.start!.dateTime!), e: new Date(ev.end!.dateTime!) }))
          .sort((a, b) => a.s.getTime() - b.s.getTime())
        const slot = findGap(startDate, endDate, busy, minutes, businessOnly)
        if (!slot) return `No free ${minutes}-minute slot between ${formatCT(startDate)} and ${formatCT(endDate)}${businessOnly ? ' (business hours)' : ''}.`
        return `Free slot: ${formatCT(slot)} — ${minutes} min. ISO: ${slot.toISOString()}`
      } catch (err) {
        return `Calendar error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'calendar_cancel_event': {
      const account = (args.account === 'personal' ? 'personal' : 'work') as 'personal' | 'work'
      const eventId = args.event_id ? String(args.event_id) : undefined
      const match = args.match ? String(args.match) : undefined
      if (!eventId && !match) return 'Error: provide event_id or match.'
      try {
        const cal = getCalendar(account)
        let targetId = eventId
        let targetSummary = ''
        if (!targetId && match) {
          const windowDays = Math.max(Number(args.window_days ?? 14), 1)
          const now = new Date()
          const end = new Date(now.getTime() + windowDays * 86_400_000)
          const res = await cal.events.list({
            calendarId: 'primary',
            timeMin: now.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 100,
          })
          const items = res.data.items ?? []
          const tokens = match.toLowerCase().split(/\s+/).filter(t => t.length >= 3)
          const scored = items
            .map(ev => ({ ev, score: tokens.reduce((acc, t) => acc + ((ev.summary ?? '').toLowerCase().includes(t) ? 1 : 0), 0) }))
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
          if (scored.length === 0) return `No event matches "${match}" in next ${windowDays} days.`
          if (scored.length > 1 && scored[0].score === scored[1].score) {
            const top = scored.filter(s => s.score === scored[0].score).slice(0, 10)
            return `Ambiguous -- "${match}" matched ${top.length} events:\n` + top.map(s => `  ${s.ev.id}  ${formatCT(new Date(s.ev.start?.dateTime ?? s.ev.start?.date ?? ''))}  ${s.ev.summary}`).join('\n')
          }
          targetId = scored[0].ev.id!
          targetSummary = scored[0].ev.summary ?? ''
        }
        const ev = await cal.events.get({ calendarId: 'primary', eventId: targetId! }).catch(() => null)
        const hasAttendees = (ev?.data?.attendees?.length ?? 0) > 0
        await cal.events.delete({
          calendarId: 'primary',
          eventId: targetId!,
          sendUpdates: hasAttendees ? 'all' : 'none',
        })
        return `Cancelled: ${targetSummary || targetId}${hasAttendees ? ' (attendees notified)' : ''}`
      } catch (err) {
        return `Calendar error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'calendar_update_event': {
      const account = (args.account === 'personal' ? 'personal' : 'work') as 'personal' | 'work'
      const eventId = String(args.event_id ?? '').trim()
      if (!eventId) return 'Error: event_id is required.'
      try {
        const cal = getCalendar(account)
        const existing = await cal.events.get({ calendarId: 'primary', eventId })
        const patch: Record<string, unknown> = {}
        if (args.title) patch.summary = String(args.title)
        if (args.description) patch.description = String(args.description)
        if (args.start) {
          const d = parseWhen(String(args.start), new Date())
          patch.start = { dateTime: d.toISOString(), timeZone: 'America/Chicago' }
        }
        if (args.end) {
          const d = parseWhen(String(args.end), new Date())
          patch.end = { dateTime: d.toISOString(), timeZone: 'America/Chicago' }
        }
        if (Array.isArray(args.add_attendees) || Array.isArray(args.remove_attendees)) {
          const current = (existing.data.attendees ?? []).map(a => a.email!).filter(Boolean)
          const add = Array.isArray(args.add_attendees) ? (args.add_attendees as unknown[]).map(String) : []
          const remove = new Set(Array.isArray(args.remove_attendees) ? (args.remove_attendees as unknown[]).map(String) : [])
          const final = [...new Set([...current, ...add])].filter(e => !remove.has(e))
          patch.attendees = final.map(email => ({ email }))
        }
        if (Object.keys(patch).length === 0) return 'No changes specified.'
        const hasAttendees = ((patch.attendees as Array<unknown>)?.length ?? existing.data.attendees?.length ?? 0) > 0
        const res = await cal.events.patch({
          calendarId: 'primary',
          eventId,
          requestBody: patch,
          sendUpdates: hasAttendees ? 'all' : 'none',
        })
        return `Updated ${eventId}: ${Object.keys(patch).join(', ')}. ${res.data.htmlLink ?? ''}`
      } catch (err) {
        return `Calendar error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // ============================================================
    // Google Tasks
    // ============================================================
    case 'task_create': {
      const account = (args.account === 'personal' ? 'personal' : 'work') as 'personal' | 'work'
      const title = String(args.title ?? '').trim()
      if (!title) return 'Error: title is required.'
      try {
        const t = getTasks(account)
        const listId = await resolveTaskList(t, args.list ? String(args.list) : undefined)
        const due = args.due ? parseWhen(String(args.due), new Date()).toISOString() : undefined
        const res = await t.tasks.insert({
          tasklist: listId,
          requestBody: {
            title,
            notes: args.notes ? String(args.notes) : undefined,
            due,
          },
        })
        return `Created task ${res.data.id}: "${title}"${due ? ` (due ${formatCT(new Date(due))})` : ''}`
      } catch (err) {
        return `Tasks error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'task_list': {
      const account = (args.account === 'personal' ? 'personal' : 'work') as 'personal' | 'work'
      const showCompleted = Boolean(args.show_completed)
      const max = Math.min(Math.max(Number(args.max ?? 20), 1), 100)
      try {
        const t = getTasks(account)
        const listId = await resolveTaskList(t, args.list ? String(args.list) : undefined)
        const res = await t.tasks.list({
          tasklist: listId,
          showCompleted,
          showHidden: false,
          maxResults: max,
        })
        const items = res.data.items ?? []
        if (items.length === 0) return showCompleted ? 'No tasks.' : 'No open tasks.'
        return `Tasks (${items.length}):\n` + items.map(it => {
          const status = it.status === 'completed' ? '[x]' : '[ ]'
          const due = it.due ? ` due ${formatCT(new Date(it.due))}` : ''
          const notes = it.notes ? ` -- ${it.notes.replace(/\s+/g, ' ').slice(0, 80)}` : ''
          return `  ${status} ${it.id}  ${it.title ?? '(no title)'}${due}${notes}`
        }).join('\n')
      } catch (err) {
        return `Tasks error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'task_complete': {
      const account = (args.account === 'personal' ? 'personal' : 'work') as 'personal' | 'work'
      const match = String(args.match ?? '').trim()
      if (!match) return 'Error: match is required.'
      try {
        const t = getTasks(account)
        const listId = await resolveTaskList(t, undefined)
        const res = await t.tasks.list({ tasklist: listId, showCompleted: false, maxResults: 100 })
        const items = res.data.items ?? []
        const tokens = match.toLowerCase().split(/\s+/).filter(s => s.length >= 3)
        const scored = items
          .map(it => ({ it, score: tokens.reduce((acc, tok) => acc + ((it.title ?? '').toLowerCase().includes(tok) ? 1 : 0), 0) }))
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score)
        if (scored.length === 0) return `No open task matches "${match}".`
        if (scored.length > 1 && scored[0].score === scored[1].score) {
          const top = scored.filter(s => s.score === scored[0].score).slice(0, 10)
          return `Ambiguous -- "${match}" matched ${top.length} tasks:\n` + top.map(s => `  ${s.it.id}  ${s.it.title}`).join('\n')
        }
        await t.tasks.patch({ tasklist: listId, task: scored[0].it.id!, requestBody: { status: 'completed' } })
        return `Completed: ${scored[0].it.title}`
      } catch (err) {
        return `Tasks error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // ============================================================
    // Gmail
    // ============================================================
    case 'gmail_list_unread': {
      const account = (args.account === 'work' ? 'work' : 'personal') as 'personal' | 'work'
      const max = Math.min(Math.max(Number(args.max ?? 10), 1), 30)
      try {
        const gmail = getGmail(account)
        const list = await gmail.users.messages.list({
          userId: 'me',
          q: 'is:unread in:inbox',
          maxResults: max,
        })
        const ids = (list.data.messages ?? []).map(m => m.id!)
        if (ids.length === 0) return `No unread messages on ${account} account.`
        const fetched = await Promise.all(ids.map(id =>
          gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
        ))
        const lines = fetched.map((res, i) => {
          const headers = res.data.payload?.headers ?? []
          const h = (k: string) => headers.find(hh => hh.name?.toLowerCase() === k.toLowerCase())?.value ?? ''
          const snippet = (res.data.snippet ?? '').replace(/\s+/g, ' ').slice(0, 120)
          return `${i + 1}. ${ids[i]}  from: ${h('From')}\n   subject: ${h('Subject')}\n   ${snippet}`
        })
        return `Unread on ${account} (${lines.length}):\n${lines.join('\n')}`
      } catch (err) {
        return `Gmail error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'gmail_read_email': {
      const account = (args.account === 'work' ? 'work' : 'personal') as 'personal' | 'work'
      const messageId = String(args.message_id ?? '').trim()
      if (!messageId) return 'Error: message_id is required.'
      try {
        const gmail = getGmail(account)
        const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
        const headers = msg.data.payload?.headers ?? []
        const h = (k: string) => headers.find(hh => hh.name?.toLowerCase() === k.toLowerCase())?.value ?? ''
        const body = extractGmailBody(msg.data.payload)
        const out = [
          `From: ${h('From')}`,
          `To: ${h('To')}`,
          `Subject: ${h('Subject')}`,
          `Date: ${h('Date')}`,
          `Thread: ${msg.data.threadId}`,
          '',
          body,
        ].join('\n')
        return out.length > 8000 ? out.slice(0, 8000) + '\n... (truncated)' : out
      } catch (err) {
        return `Gmail error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'gmail_search': {
      const account = (args.account === 'work' ? 'work' : 'personal') as 'personal' | 'work'
      const query = String(args.query ?? '').trim()
      if (!query) return 'Error: query is required.'
      const max = Math.min(Math.max(Number(args.max ?? 10), 1), 30)
      try {
        const gmail = getGmail(account)
        const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max })
        const ids = (list.data.messages ?? []).map(m => m.id!)
        if (ids.length === 0) return `No matches for "${query}" on ${account}.`
        const fetched = await Promise.all(ids.map(id =>
          gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
        ))
        const lines = fetched.map((res, i) => {
          const headers = res.data.payload?.headers ?? []
          const h = (k: string) => headers.find(hh => hh.name?.toLowerCase() === k.toLowerCase())?.value ?? ''
          const snippet = (res.data.snippet ?? '').replace(/\s+/g, ' ').slice(0, 120)
          return `${i + 1}. ${ids[i]}  ${h('Date')}\n   from: ${h('From')} | subject: ${h('Subject')}\n   ${snippet}`
        })
        return `Matches for "${query}" on ${account} (${lines.length}):\n${lines.join('\n')}`
      } catch (err) {
        return `Gmail error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'gmail_draft_reply': {
      const account = (args.account === 'work' ? 'work' : 'personal') as 'personal' | 'work'
      const threadId = String(args.thread_id ?? '').trim()
      const body = String(args.body ?? '').trim()
      if (!threadId || !body) return 'Error: thread_id and body are required.'
      try {
        const gmail = getGmail(account)
        // Fetch the thread to pull headers for the reply.
        const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'] })
        const lastMsg = thread.data.messages?.[thread.data.messages.length - 1]
        const headers = lastMsg?.payload?.headers ?? []
        const h = (k: string) => headers.find(hh => hh.name?.toLowerCase() === k.toLowerCase())?.value ?? ''
        const replyTo = h('From')
        const subj = h('Subject')
        const inReplyTo = h('Message-ID')
        const refs = h('References')
        const rfc822 = buildRfc822({
          to: replyTo,
          subject: subj.toLowerCase().startsWith('re:') ? subj : `Re: ${subj}`,
          body,
          inReplyTo,
          references: refs ? `${refs} ${inReplyTo}`.trim() : inReplyTo,
        })
        const raw = Buffer.from(rfc822).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        const draft = await gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { threadId, raw } },
        })
        return `Draft saved: ${draft.data.id}. Subject: "${subj}". Review in Gmail before sending.`
      } catch (err) {
        return `Gmail error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'gmail_send_email': {
      const account = (args.account === 'work' ? 'work' : 'personal') as 'personal' | 'work'
      const to = Array.isArray(args.to) ? (args.to as unknown[]).map(String) : []
      const subject = String(args.subject ?? '').trim()
      const body = String(args.body ?? '').trim()
      const cc = Array.isArray(args.cc) ? (args.cc as unknown[]).map(String) : []
      const threadId = args.reply_to_thread_id ? String(args.reply_to_thread_id) : undefined
      if (to.length === 0 || !subject || !body) return 'Error: to (non-empty), subject, and body are required.'
      // Defensive guard against accidental sends.
      if (/\[draft\]|\[review\]/i.test(body)) return 'Refused: body contains [draft] or [review] marker. Use gmail_draft_reply if this should be a draft.'
      try {
        const gmail = getGmail(account)
        const rfc822 = buildRfc822({ to: to.join(', '), cc: cc.join(', '), subject, body })
        const raw = Buffer.from(rfc822).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: threadId ? { raw, threadId } : { raw },
        })
        return `Sent: ${res.data.id} to ${to.join(', ')}`
      } catch (err) {
        return `Gmail error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // ============================================================
    // GitHub (gh CLI)
    // ============================================================
    case 'gh_create_issue': {
      const repo = String(args.repo ?? GITHUB_DEFAULT_REPO).trim()
      const title = String(args.title ?? '').trim()
      if (!title) return 'Error: title is required.'
      const body = String(args.body ?? '').trim()
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map(String).join(',') : ''
      const assignees = Array.isArray(args.assignees) ? (args.assignees as unknown[]).map(String).join(',') : ''
      try {
        const argv = ['issue', 'create', '--repo', repo, '--title', title]
        if (body) argv.push('--body', body)
        if (labels) argv.push('--label', labels)
        if (assignees) argv.push('--assignee', assignees)
        const out = spawnSync('gh', argv, { encoding: 'utf-8', timeout: 30_000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        if (out.error) return `gh error: ${String(out.error).slice(0, 500)}`
        if (out.status !== 0) return `gh failed (exit ${out.status}): ${(out.stderr ?? '').slice(0, 500)}`
        return (out.stdout ?? '').trim() || `Created.`
      } catch (err) {
        return `gh error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'gh_list_issues': {
      const repo = String(args.repo ?? GITHUB_DEFAULT_REPO).trim()
      const state = (args.state === 'closed' || args.state === 'all') ? String(args.state) : 'open'
      const max = Math.min(Math.max(Number(args.max ?? 20), 1), 50)
      const argv = ['issue', 'list', '--repo', repo, '--state', state, '--limit', String(max), '--json', 'number,title,state,labels,assignees,createdAt,url']
      if (args.label) argv.push('--label', String(args.label))
      if (args.assignee) argv.push('--assignee', String(args.assignee))
      try {
        const out = spawnSync('gh', argv, { encoding: 'utf-8', timeout: 30_000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        if (out.error || out.status !== 0) return `gh failed: ${(out.stderr ?? out.error ?? '').toString().slice(0, 500)}`
        const items = JSON.parse(out.stdout || '[]') as Array<{ number: number; title: string; state: string; labels: Array<{ name: string }>; assignees: Array<{ login: string }>; createdAt: string; url: string }>
        if (items.length === 0) return `No issues (${state}) in ${repo}.`
        return `Issues in ${repo} (${state}, ${items.length}):\n` + items.map(it => {
          const labels = it.labels.map(l => l.name).join(',')
          const assignees = it.assignees.map(a => a.login).join(',')
          return `  #${it.number}  ${it.title}\n    ${labels ? `labels:[${labels}] ` : ''}${assignees ? `assignees:[${assignees}] ` : ''}${it.url}`
        }).join('\n')
      } catch (err) {
        return `gh error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'gh_search_code': {
      const repo = String(args.repo ?? GITHUB_DEFAULT_REPO).trim()
      const query = String(args.query ?? '').trim()
      if (!query) return 'Error: query is required.'
      const max = Math.min(Math.max(Number(args.max ?? 15), 1), 30)
      try {
        const out = spawnSync('gh', ['search', 'code', query, '--repo', repo, '--limit', String(max), '--json', 'path,url,textMatches'], { encoding: 'utf-8', timeout: 30_000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        if (out.error || out.status !== 0) return `gh failed: ${(out.stderr ?? out.error ?? '').toString().slice(0, 500)}`
        const items = JSON.parse(out.stdout || '[]') as Array<{ path: string; url: string; textMatches?: Array<{ fragment: string }> }>
        if (items.length === 0) return `No matches for "${query}" in ${repo}.`
        return `Code matches for "${query}" in ${repo} (${items.length}):\n` + items.map(it => {
          const frag = (it.textMatches?.[0]?.fragment ?? '').replace(/\s+/g, ' ').slice(0, 120)
          return `  ${it.path}\n    ${frag}\n    ${it.url}`
        }).join('\n')
      } catch (err) {
        return `gh error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'gh_pr_status': {
      const repo = String(args.repo ?? GITHUB_DEFAULT_REPO).trim()
      if (args.pr_number) {
        const num = String(args.pr_number)
        try {
          const out = spawnSync('gh', ['pr', 'view', num, '--repo', repo, '--json', 'number,title,state,statusCheckRollup,reviewDecision,url,headRefName,baseRefName'], { encoding: 'utf-8', timeout: 30_000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
          if (out.error || out.status !== 0) return `gh failed: ${(out.stderr ?? out.error ?? '').toString().slice(0, 500)}`
          const pr = JSON.parse(out.stdout || '{}') as { number: number; title: string; state: string; statusCheckRollup: Array<{ name: string; status: string; conclusion: string }>; reviewDecision: string; url: string; headRefName: string; baseRefName: string }
          const checks = (pr.statusCheckRollup ?? []).slice(0, 8).map(c => `    ${c.name}: ${c.conclusion ?? c.status}`).join('\n')
          return `PR #${pr.number}  ${pr.title}\n  state: ${pr.state}  review: ${pr.reviewDecision ?? '-'}\n  ${pr.headRefName} -> ${pr.baseRefName}\n  ${pr.url}\n  checks:\n${checks || '    (none)'}`
        } catch (err) {
          return `gh error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      try {
        const out = spawnSync('gh', ['pr', 'list', '--repo', repo, '--limit', '20', '--json', 'number,title,state,reviewDecision,url'], { encoding: 'utf-8', timeout: 30_000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        if (out.error || out.status !== 0) return `gh failed: ${(out.stderr ?? out.error ?? '').toString().slice(0, 500)}`
        const items = JSON.parse(out.stdout || '[]') as Array<{ number: number; title: string; state: string; reviewDecision: string; url: string }>
        if (items.length === 0) return `No open PRs in ${repo}.`
        return `Open PRs in ${repo} (${items.length}):\n` + items.map(p => `  #${p.number}  ${p.title}  [${p.reviewDecision ?? '-'}]  ${p.url}`).join('\n')
      } catch (err) {
        return `gh error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'gh_recent_commits': {
      const repo = String(args.repo ?? GITHUB_DEFAULT_REPO).trim()
      const branch = String(args.branch ?? 'dev').trim()
      const max = Math.min(Math.max(Number(args.max ?? 20), 1), 100)
      const sinceArg = args.since ? `&since=${encodeURIComponent(String(args.since))}` : ''
      try {
        const out = spawnSync('gh', ['api', `repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${max}${sinceArg}`], { encoding: 'utf-8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        if (out.error || out.status !== 0) return `gh failed: ${(out.stderr ?? out.error ?? '').toString().slice(0, 500)}`
        const items = JSON.parse(out.stdout || '[]') as Array<{ sha: string; commit: { author: { name: string; date: string }; message: string } }>
        if (items.length === 0) return `No commits on ${repo}@${branch}.`
        return `Recent commits on ${repo}@${branch} (${items.length}):\n` + items.map(c => {
          const subject = (c.commit.message ?? '').split('\n')[0].slice(0, 100)
          return `  ${c.sha.slice(0, 8)}  ${c.commit.author?.date?.slice(0, 10) ?? '????-??-??'}  ${c.commit.author?.name ?? '?'}  ${subject}`
        }).join('\n')
      } catch (err) {
        return `gh error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // ============================================================
    // Convex (your app)
    // ============================================================
    case 'convex_query': {
      const env = args.env === 'prod' ? 'prod' : 'dev'
      const fnName = String(args.function_name ?? '').trim()
      if (!fnName) return 'Error: function_name is required.'
      const fnArgs = (args.args && typeof args.args === 'object') ? args.args as Record<string, unknown> : {}
      try {
        const argv = ['convex', 'run']
        if (env === 'prod') argv.push('--prod')
        argv.push(fnName, JSON.stringify(fnArgs))
        const out = spawnSync('npx', argv, {
          encoding: 'utf-8',
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
          cwd: CONVEX_PROJECT_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        })
        if (out.error) return `convex error: ${String(out.error).slice(0, 500)}`
        if (out.status !== 0) return `convex failed (exit ${out.status}): ${(out.stderr ?? '').slice(0, 1500)}`
        const stdout = (out.stdout ?? '').trim()
        // Try to pretty-print JSON; fall back to raw text
        try {
          const parsed = JSON.parse(stdout)
          const pretty = JSON.stringify(parsed, null, 2)
          return pretty.length > 8000 ? pretty.slice(0, 8000) + '\n... (truncated)' : pretty
        } catch {
          return stdout.length > 8000 ? stdout.slice(0, 8000) + '\n... (truncated)' : (stdout || '(no output)')
        }
      } catch (err) {
        return `convex error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'convex_run': {
      const env = args.env === 'prod' ? 'prod' : args.env === 'dev' ? 'dev' : null
      if (!env) return 'Error: env must be "dev" or "prod".'
      const fnName = String(args.function_name ?? '').trim()
      if (!fnName) return 'Error: function_name is required.'
      const confirm = String(args.confirm ?? '').trim()
      const expected = `yes mutate ${env}`
      if (confirm !== expected) {
        return `BLOCKED: convex_run requires confirm="${expected}" exactly to mutate ${env}. the user must say those words in the current turn.`
      }
      const fnArgs = (args.args && typeof args.args === 'object') ? args.args as Record<string, unknown> : {}
      try {
        const argv = ['convex', 'run']
        if (env === 'prod') argv.push('--prod')
        argv.push(fnName, JSON.stringify(fnArgs))
        const out = spawnSync('npx', argv, {
          encoding: 'utf-8',
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
          cwd: CONVEX_PROJECT_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        })
        if (out.error) return `convex error: ${String(out.error).slice(0, 500)}`
        if (out.status !== 0) return `convex failed (exit ${out.status}): ${(out.stderr ?? '').slice(0, 1500)}`
        return (out.stdout ?? '').trim() || `Mutation ${fnName} on ${env} returned no output.`
      } catch (err) {
        return `convex error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // ============================================================
    // Long-running command wrapper
    // ============================================================
    case 'run_long_command': {
      const command = String(args.command ?? '').trim()
      const label = String(args.label ?? '').trim()
      if (!command || !label) return 'Error: command and label are required.'
      const blocked = isBashBlocked(command)
      if (blocked) return `BLOCKED: ${blocked}. Try a different approach.`
      const silent = Boolean(args.silent)
      const timeoutMin = Math.min(Math.max(Number(args.timeout_minutes ?? 30), 1), 120)
      try {
        const argv = [LONG_RUNNER_SCRIPT, '--cmd', command, '--label', label, '--notify-chat', chatId, '--timeout-min', String(timeoutMin)]
        if (silent) argv.push('--silent')
        const out = spawnSync('bash', argv, { encoding: 'utf-8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        if (out.error) return `long-runner error: ${String(out.error).slice(0, 500)}`
        if (out.status !== 0) return `long-runner failed (exit ${out.status}): ${(out.stderr ?? '').slice(0, 500)}`
        return (out.stdout ?? '').trim() || `Launched: ${label}`
      } catch (err) {
        return `long-runner error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // ============================================================
    // Utility tools
    // ============================================================
    case 'search_my_chats': {
      const query = String(args.query ?? '').trim()
      if (!query) return 'Error: query is required.'
      const limit = Math.min(Math.max(Number(args.limit ?? 15), 1), 50)
      const role = args.role === 'user' || args.role === 'assistant' ? String(args.role) : null
      try {
        const d = getDb()
        const like = `%${query.replace(/[%_]/g, m => '\\' + m)}%`
        const sql = role
          ? `SELECT role, content, model, created_at FROM conversation_log WHERE chat_id = ? AND role = ? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`
          : `SELECT role, content, model, created_at FROM conversation_log WHERE chat_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`
        const params: unknown[] = role ? [chatId, role, like, limit] : [chatId, like, limit]
        const rows = d.prepare(sql).all(...params) as Array<{ role: string; content: string; model: string; created_at: number }>
        if (rows.length === 0) return `No matches for "${query}" in your chat history.`
        return `Matches for "${query}" (${rows.length}):\n` + rows.map(r => {
          const when = new Date(r.created_at * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          const snippet = r.content.replace(/\s+/g, ' ').slice(0, 180)
          return `  ${when} [${r.role}/${r.model}] ${snippet}`
        }).join('\n')
      } catch (err) {
        return `search error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'stock_price': {
      const symbols = Array.isArray(args.symbols) ? (args.symbols as unknown[]).map(String).map(s => s.toUpperCase()) : []
      if (symbols.length === 0) return 'Error: symbols array is required.'
      try {
        const lines: string[] = []
        for (const sym of symbols.slice(0, 10)) {
          const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(10000),
          })
          if (!res.ok) { lines.push(`  ${sym}: HTTP ${res.status}`); continue }
          const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number; currency?: string; exchangeName?: string } }>; error?: { description?: string } } }
          const meta = data.chart?.result?.[0]?.meta
          if (!meta || meta.regularMarketPrice === undefined) {
            lines.push(`  ${sym}: ${data.chart?.error?.description ?? 'no data'}`)
            continue
          }
          const price = meta.regularMarketPrice
          const prev = meta.previousClose ?? price
          const delta = price - prev
          const pct = prev ? (delta / prev) * 100 : 0
          const sign = delta >= 0 ? '+' : ''
          lines.push(`  ${sym} (${meta.exchangeName ?? '?'}): ${price.toFixed(2)} ${meta.currency ?? ''}  ${sign}${delta.toFixed(2)} (${sign}${pct.toFixed(2)}%)`)
        }
        return `Stock prices:\n${lines.join('\n')}`
      } catch (err) {
        return `stock_price error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'stock_news': {
      const symbol = String(args.symbol ?? '').toUpperCase().trim()
      if (!symbol) return 'Error: symbol is required.'
      const max = Math.min(Math.max(Number(args.max ?? 8), 1), 20)
      try {
        const res = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) return `stock_news HTTP ${res.status}`
        const xml = await res.text()
        const items: Array<{ title: string; link: string; date: string }> = []
        const itemRegex = /<item>([\s\S]*?)<\/item>/g
        let m: RegExpExecArray | null
        while ((m = itemRegex.exec(xml)) !== null && items.length < max) {
          const body = m[1]
          const title = (body.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? '').trim()
          const link = (body.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '').trim()
          const date = (body.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '').trim()
          if (title) items.push({ title, link, date })
        }
        if (items.length === 0) return `No news for ${symbol}.`
        return `News for ${symbol}:\n` + items.map(i => `  ${i.date}\n    ${i.title}\n    ${i.link}`).join('\n')
      } catch (err) {
        return `stock_news error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'get_weather': {
      const location = String(args.location ?? '').trim()
      if (!location) return 'Error: location is required.'
      const days = Math.min(Math.max(Number(args.days ?? 3), 1), 7)
      try {
        let lat: number, lon: number, displayName: string
        if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(location)) {
          const [latStr, lonStr] = location.split(',').map(s => s.trim())
          lat = Number(latStr); lon = Number(lonStr); displayName = location
        } else {
          // Open-Meteo's geocoder ignores state qualifiers. Parse "City ST"
          // or "City, ST" out so we can filter results by US state code.
          const stateMatch = location.match(/^(.*?)[\s,]+([A-Z]{2})$/i)
          const baseQuery = stateMatch ? stateMatch[1].trim() : location
          const stateHint = stateMatch ? stateMatch[2].toUpperCase() : null
          const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(baseQuery)}&count=10`, { signal: AbortSignal.timeout(8000) })
          if (!geo.ok) return `Geocoding error HTTP ${geo.status}`
          const gd = await geo.json() as { results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; admin1_code?: string; country_code?: string }> }
          let hits = gd.results ?? []
          if (stateHint && hits.length > 0) {
            const filtered = hits.filter(h => {
              if (h.country_code !== 'US') return false
              const a1 = (h.admin1 ?? '').toUpperCase()
              return a1.startsWith(stateHint) || a1 === US_STATE_NAMES[stateHint]
            })
            if (filtered.length > 0) hits = filtered
          }
          const hit = hits[0]
          if (!hit) return `Could not geocode "${location}".`
          lat = hit.latitude; lon = hit.longitude
          displayName = `${hit.name}${hit.admin1 ? ', ' + hit.admin1 : ''}${hit.country_code ? ' ' + hit.country_code : ''}`
        }
        const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=${days}`
        const wx = await fetch(wxUrl, { signal: AbortSignal.timeout(8000) })
        if (!wx.ok) return `Weather HTTP ${wx.status}`
        const data = await wx.json() as {
          current?: { temperature_2m: number; relative_humidity_2m: number; wind_speed_10m: number; weather_code: number }
          daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[] }
        }
        const wcDesc = (c: number) => {
          if (c === 0) return 'clear'
          if (c <= 3) return 'mostly clear'
          if (c <= 48) return 'cloudy/fog'
          if (c <= 67) return 'rain'
          if (c <= 77) return 'snow'
          if (c <= 82) return 'showers'
          return 'thunderstorm'
        }
        const out: string[] = [`Weather for ${displayName}:`]
        if (data.current) {
          out.push(`  Now: ${data.current.temperature_2m.toFixed(0)}°F  ${wcDesc(data.current.weather_code)}  humidity ${data.current.relative_humidity_2m}%  wind ${data.current.wind_speed_10m.toFixed(0)} mph`)
        }
        if (data.daily) {
          out.push(`  Forecast:`)
          for (let i = 0; i < data.daily.time.length; i++) {
            out.push(`    ${data.daily.time[i]}  ${data.daily.temperature_2m_min[i].toFixed(0)}-${data.daily.temperature_2m_max[i].toFixed(0)}°F  ${wcDesc(data.daily.weather_code[i])}  ${data.daily.precipitation_probability_max[i]}% precip`)
          }
        }
        return out.join('\n')
      } catch (err) {
        return `get_weather error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'shorten_url': {
      const url = String(args.url ?? '').trim()
      if (!url) return 'Error: url is required.'
      try {
        const res = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) })
        const text = (await res.text()).trim()
        if (!res.ok || !text.startsWith('http')) return `shorten_url failed: ${text.slice(0, 200)}`
        return text
      } catch (err) {
        return `shorten_url error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'generate_qr': {
      const text = String(args.text ?? '').trim()
      if (!text) return 'Error: text is required.'
      const size = Math.min(Math.max(Number(args.size ?? 400), 100), 1200)
      try {
        const qrcode = await import('qrcode')
        const toFile = (qrcode as { toFile?: typeof qrcode.toFile; default?: { toFile: typeof qrcode.toFile } }).toFile
          ?? (qrcode as { default?: { toFile: typeof qrcode.toFile } }).default?.toFile
        if (!toFile) return 'generate_qr error: qrcode.toFile unavailable'
        const filename = `qr-${Date.now()}.png`
        const outPath = `./workspace/uploads/${filename}`
        await toFile(outPath, text, { width: size, margin: 2 })
        return `QR code written to workspace/uploads/${filename}\nContent: ${text.slice(0, 200)}`
      } catch (err) {
        return `generate_qr error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'calculate': {
      const expression = String(args.expression ?? '').trim()
      if (!expression) return 'Error: expression is required.'
      try {
        const { evaluate, createUnit } = await import('mathjs')
        // Register common shorthand units that mathjs doesn't ship with by
        // default. Wrapped in try/catch because createUnit throws if the alias
        // is already registered (harmless on a repeat call).
        try { createUnit('mph', { definition: '1 mile/hour', aliases: ['MPH'] }) } catch { /* already defined */ }
        try { createUnit('kph', { definition: '1 km/hour', aliases: ['KPH'] }) } catch { /* already defined */ }
        try { createUnit('fps', { definition: '1 foot/second', aliases: ['FPS'] }) } catch { /* already defined */ }
        const result = evaluate(expression)
        const formatted = typeof result === 'object' && result !== null && 'toString' in result
          ? (result as { toString: () => string }).toString()
          : String(result)
        return `${expression} = ${formatted}`
      } catch (err) {
        return `calculate error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'convert_file': {
      const inputPath = String(args.input_path ?? '').trim()
      const outputFormat = String(args.output_format ?? '').toLowerCase().trim().replace(/^\./, '')
      if (!inputPath || !outputFormat) return 'Error: input_path and output_format are required.'
      const inBlocked = isPathBlocked(inputPath, false)
      if (inBlocked) return `BLOCKED: ${inBlocked}`
      if (!existsSync(inputPath)) return `Error: ${inputPath} does not exist.`
      const inExt = extname(inputPath).toLowerCase().slice(1)
      const stamp = Date.now()
      const baseName = inputPath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'output'
      const outFile = `./workspace/uploads/${baseName}-${stamp}.${outputFormat}`
      const options = (args.options && typeof args.options === 'object') ? args.options as Record<string, unknown> : {}
      try {
        // PDF -> text
        if (inExt === 'pdf' && outputFormat === 'txt') {
          execSync(`pdftotext ${JSON.stringify(inputPath)} ${JSON.stringify(outFile)}`, { timeout: 60_000, stdio: ['ignore', 'ignore', 'pipe'] })
          return `Wrote ${outFile}`
        }
        // Image conversions / resize via ImageMagick
        if (/^(png|jpg|jpeg|gif|webp|bmp|tiff)$/.test(inExt) && /^(png|jpg|jpeg|gif|webp)$/.test(outputFormat)) {
          const resizeArg = options.width || options.height
            ? `-resize ${Number(options.width ?? '') || ''}x${Number(options.height ?? '') || ''}`
            : ''
          execSync(`convert ${JSON.stringify(inputPath)} ${resizeArg} ${JSON.stringify(outFile)}`, { timeout: 60_000, stdio: ['ignore', 'ignore', 'pipe'] })
          return `Wrote ${outFile}`
        }
        // Audio re-encode via ffmpeg
        if (/^(mp3|wav|ogg|m4a|opus|flac|aac)$/.test(inExt) && /^(mp3|wav|ogg|opus)$/.test(outputFormat)) {
          execSync(`ffmpeg -y -i ${JSON.stringify(inputPath)} ${JSON.stringify(outFile)} -loglevel error`, { timeout: 120_000, stdio: ['ignore', 'ignore', 'pipe'] })
          return `Wrote ${outFile}`
        }
        return `Unsupported conversion: .${inExt} -> .${outputFormat}. Supported: pdf->txt, image->image (resize via options.width/height), audio re-encode.`
      } catch (err) {
        return `convert_file error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'quick_note': {
      const text = String(args.text ?? '').trim()
      if (!text) return 'Error: text is required.'
      const tag = args.tag ? String(args.tag).trim().replace(/[^a-zA-Z0-9_-]/g, '') : ''
      const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      const tagSuffix = tag ? `  #${tag}` : ''
      const entry = `\n- [${stamp}]${tagSuffix} ${text}`
      try {
        const path = './workspace/scratchpad.md'
        if (!existsSync(path)) writeFileSync(path, '# Scratchpad\n')
        const cur = readFileSync(path, 'utf-8')
        writeFileSync(path, cur + entry)
        return `Noted${tag ? ' #' + tag : ''}: ${text.slice(0, 100)}`
      } catch (err) {
        return `quick_note error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'create_presentation': {
      // Content-only IR → coerce/validate/render. Always return JSON for the agent loop.
      const extractJson = (text: string): string => {
        const t = text.trim()
        if (t.startsWith('{')) {
          // First JSON object (render_deck prints JSON then PRESENT_URL lines)
          const end = t.indexOf('\nPRESENT_URL=')
          return end === -1 ? t : t.slice(0, end).trim()
        }
        const m = t.match(/\{[\s\S]*\}/)
        return m ? m[0] : t
      }

      const title = String(args.title ?? '').trim()
      if (!title) {
        return JSON.stringify({
          ok: false,
          stage: 'input',
          errors: ['title is required'],
          hint: 'Pass title + slides[]. Types: title|section|content|two-column|compare|stats|quote|code',
        })
      }
      let slides = args.slides
      if (typeof slides === 'string') {
        try {
          slides = JSON.parse(slides)
        } catch {
          return JSON.stringify({
            ok: false,
            stage: 'parse',
            errors: ['slides must be a JSON array'],
            hint: 'deck-spec only — no HTML, no python.',
          })
        }
      }
      if (!Array.isArray(slides) || slides.length === 0) {
        return JSON.stringify({
          ok: false,
          stage: 'input',
          errors: ['slides must be a non-empty array'],
          hint: 'Add slides with type + title (and bullets/stats/quote as needed).',
        })
      }
      const theme = String(args.theme ?? 'midnight').trim() || 'midnight'
      let format = String(args.output_format ?? args.format ?? 'both').trim().toLowerCase() || 'both'
      if (format === 'ppt' || format === 'powerpoint') format = 'pptx'
      if (format === 'all') format = 'both'
      const allowedFmt = ['html', 'pptx', 'both', 'marp-html', 'marp-pdf']
      if (!allowedFmt.includes(format)) format = 'both'
      const author = args.author != null ? String(args.author) : ''
      const subtitle = args.subtitle != null ? String(args.subtitle) : ''
      const rawName = args.filename != null ? String(args.filename) : title
      const safeName = rawName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'presentation'
      const deck: Record<string, unknown> = {
        title,
        author,
        subtitle,
        theme,
        output_format: format,
        slides,
      }
      // Optional design knobs (constrained enums / logo path)
      for (const key of ['brand', 'logo', 'logo_text', 'motif', 'vibe', 'accent'] as const) {
        if (args[key] != null && String(args[key]).trim()) deck[key] = String(args[key]).trim()
      }
      if (args.show_logo != null) deck.show_logo = Boolean(args.show_logo)
      const deckPath = `/tmp/personalos-deck-${Date.now()}.json`
      const outPrefix = `./workspace/uploads/${safeName}`
      const renderer = './scripts/presentation/render_deck.py'
      try {
        writeFileSync(deckPath, JSON.stringify(deck, null, 2))
        const publish = args.publish === false || args.publish === 'false' ? false : true
        const publishFlag = publish ? '' : '--no-publish'
        const result = execSync(
          `python3 ${JSON.stringify(renderer)} ${JSON.stringify(deckPath)} --format ${JSON.stringify(format)} --out ${JSON.stringify(outPrefix)} ${publishFlag}`.trim(),
          { timeout: 120_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
        )
        const body = extractJson(result.toString())
        return body || result.toString().trim()
      } catch (err) {
        const stdout = (err as { stdout?: string | Buffer }).stdout
        const stderr = (err as { stderr?: string | Buffer }).stderr
        const out = stdout ? extractJson(stdout.toString()) : ''
        if (out.startsWith('{')) return out
        return JSON.stringify({
          ok: false,
          stage: 'render',
          errors: [
            err instanceof Error ? err.message : String(err),
            stderr ? stderr.toString().slice(0, 600) : '',
          ].filter(Boolean),
          hint: 'Fix deck-spec and retry create_presentation (max 3). Never rewrite render scripts.',
        })
      }
    }

    case 'system_status': {
      const lines: string[] = ['System status:']
      // host local
      try {
        const free = execSync('free -h | head -2 | tail -1', { encoding: 'utf-8', timeout: 5000 }).trim()
        const df = execSync("df -h / | tail -1 | awk '{print $3\"/\"$2\" (\"$5\")\"}'", { encoding: 'utf-8', timeout: 5000 }).trim()
        const uptime = execSync('uptime -p', { encoding: 'utf-8', timeout: 5000 }).trim()
        const ccActive = execSync('systemctl --user is-active personalos', { encoding: 'utf-8', timeout: 5000 }).trim()
        lines.push(`  host:`)
        lines.push(`    uptime: ${uptime}`)
        lines.push(`    mem: ${free.split(/\s+/).slice(0, 4).join(' ')}`)
        lines.push(`    disk /: ${df}`)
        lines.push(`    personalos service: ${ccActive}`)
      } catch (e) {
        lines.push(`  host: probe failed (${(e as Error).message.slice(0, 80)})`)
      }
      // LM Studio
      try {
        const r = await fetch(`${LMSTUDIO_URL}/v1/models`, { signal: AbortSignal.timeout(5000), headers: LMSTUDIO_API_KEY ? { Authorization: `Bearer ${LMSTUDIO_API_KEY}` } : {} })
        if (r.ok) {
          const d = await r.json() as { data?: Array<{ id: string }> }
          const models = (d.data ?? []).map(m => m.id).join(', ')
          lines.push(`  LM Studio (${LMSTUDIO_URL}): UP. models: ${models || 'none'}`)
        } else {
          lines.push(`  LM Studio: HTTP ${r.status}`)
        }
      } catch (e) {
        lines.push(`  LM Studio: unreachable (${(e as Error).message.slice(0, 80)})`)
      }
      // your Mac (optional) (if configured)
      const macTarget = env['MAC_SSH_TARGET']
      if (macTarget) {
        try {
          const out = execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${macTarget} "vm_stat | head -5 ; sysctl -n hw.memsize"`, { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
          lines.push(`  your Mac (optional) (${macTarget}): reachable`)
          lines.push('    ' + out.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 200))
        } catch (e) {
          lines.push(`  your Mac (optional): ssh failed (${(e as Error).message.slice(0, 80)})`)
        }
      } else {
        lines.push(`  your Mac (optional): MAC_SSH_TARGET not set; skipping`)
      }
      return lines.join('\n')
    }

    case 'apple_reminder_add': {
      const title = String(args.title ?? '').trim()
      if (!title) return 'Error: title is required.'
      const due = args.due ? String(args.due) : undefined
      const list = args.list ? String(args.list) : ''
      return runOsascriptOnMac(buildReminderAddScript(title, due, list))
    }

    case 'apple_reminders_list': {
      const list = args.list ? String(args.list) : ''
      const max = Math.min(Math.max(Number(args.max ?? 20), 1), 100)
      return runOsascriptOnMac(buildRemindersListScript(list, max))
    }

    case 'apple_notes_search': {
      const query = String(args.query ?? '').trim()
      if (!query) return 'Error: query is required.'
      return runOsascriptOnMac(buildNotesSearchScript(query))
    }

    case 'apple_note_create': {
      const title = String(args.title ?? '').trim()
      const body = String(args.body ?? '').trim()
      if (!title || !body) return 'Error: title and body are required.'
      return runOsascriptOnMac(buildNoteCreateScript(title, body))
    }

    // ============================================================
    // project E2E
    // ============================================================
    case 'run_e2e_tests': {
      const spec = args.spec ? String(args.spec).trim() : ''
      const workers = Math.min(Math.max(Number(args.workers ?? 2), 1), 8)
      const project = (args.project === 'light' || args.project === 'qa') ? String(args.project) : 'full'
      const mode = args.mode === 'prod' ? 'prod' : 'dev'
      const argv: string[] = [E2E_RUNNER_SCRIPT, '--workers', String(workers), '--project', project, '--mode', mode, '--notify-chat', chatId]
      if (spec) argv.push('--spec', spec)
      try {
        const out = spawnSync('bash', argv, { encoding: 'utf-8', timeout: 15_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        if (out.error) return `e2e launch error: ${String(out.error).slice(0, 500)}`
        if (out.status !== 0) return `e2e launch failed (exit ${out.status}): ${(out.stderr ?? '').slice(0, 500)}`
        const launchMsg = (out.stdout ?? '').trim() || `Launched E2E (mode=${mode}, project=${project})`
        return `${launchMsg}\n\nThe full suite takes ~30-45 min; light ~2-3 min. You'll get a Telegram message with the summary when done. Use e2e_status to peek at progress.`
      } catch (err) {
        return `e2e launch error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'e2e_status': {
      try {
        const out = spawnSync('bash', [E2E_STATUS_SCRIPT], { encoding: 'utf-8', timeout: 10_000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        if (out.error) return `e2e_status error: ${String(out.error).slice(0, 500)}`
        return (out.stdout ?? '').trim() || '(no status output)'
      } catch (err) {
        return `e2e_status error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    default:
      return `Unknown tool: ${name}`
  }
}

// ============================================================
// Helpers for Apple integration (osascript via SSH)
// ============================================================

function runOsascriptOnMac(script: string): string {
  const target = env['MAC_SSH_TARGET']
  if (!target) {
    return 'Mac SSH not configured. Set MAC_SSH_TARGET in .env (e.g. "user@your-mac.local") if you want Apple Reminders/Notes tools.'
  }
  try {
    // Use spawnSync to avoid shell-escaping the script. SSH executes the
    // remote shell which we invoke with osascript -e for each line.
    const lines = script.split('\n').filter(Boolean)
    const osaArgs = lines.flatMap(l => ['-e', l])
    const result = spawnSync('ssh', ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', target, 'osascript', ...osaArgs], {
      encoding: 'utf-8',
      timeout: 20_000,
      maxBuffer: 512 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error) return `Mac SSH error: ${String(result.error).slice(0, 300)}`
    if (result.status !== 0) return `osascript failed (exit ${result.status}): ${(result.stderr ?? '').slice(0, 500)}`
    return (result.stdout ?? '').trim() || '(no output)'
  } catch (err) {
    return `Mac SSH error: ${err instanceof Error ? err.message : String(err)}`
  }
}

function escapeAS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildReminderAddScript(title: string, due?: string, list?: string): string {
  const dueLine = due ? `set d to (current date) + (((date "${escapeAS(due)}") - (current date)) as integer)\n` : ''
  const props = due ? `{name:"${escapeAS(title)}", due date:d}` : `{name:"${escapeAS(title)}"}`
  const listClause = list ? `tell list "${escapeAS(list)}" to ` : ''
  return `tell application "Reminders"\n${dueLine}${listClause}make new reminder with properties ${props}\nend tell`
}

function buildRemindersListScript(list: string, max: number): string {
  const listClause = list ? `tell list "${escapeAS(list)}"` : ''
  const endClause = list ? 'end tell' : ''
  return `tell application "Reminders"\n${listClause}\nset out to {}\nset i to 0\nrepeat with r in (reminders whose completed is false)\nif i < ${max} then\nset end of out to ((name of r) as text)\nset i to i + 1\nend if\nend repeat\nset AppleScript's text item delimiters to "\\n"\nreturn out as text\n${endClause}\nend tell`
}

function buildNotesSearchScript(query: string): string {
  return `tell application "Notes"\nset matches to (notes whose body contains "${escapeAS(query)}" or name contains "${escapeAS(query)}")\nset out to {}\nrepeat with n in matches\nset end of out to ((name of n) & " :: " & (modification date of n as text))\nend repeat\nset AppleScript's text item delimiters to "\\n"\nreturn out as text\nend tell`
}

function buildNoteCreateScript(title: string, body: string): string {
  return `tell application "Notes"\nmake new note with properties {name:"${escapeAS(title)}", body:"${escapeAS(body)}"}\nend tell`
}

// ============================================================
// Helpers for Calendar / Tasks
// ============================================================

// Parse a natural-language or ISO time expression to a Date.
// Accepts: ISO datetime, "now", "today", "tomorrow", "yesterday", "this week",
// "next week", weekday names (mon-sun) → next occurrence.
function parseWhen(input: string | undefined, defaultDate: Date): Date {
  if (!input) return defaultDate
  const trimmed = input.trim()
  if (!trimmed) return defaultDate

  // ISO datetime / date — Date.parse handles both
  const isoMs = Date.parse(trimmed)
  if (!isNaN(isoMs)) return new Date(isoMs)

  const lower = trimmed.toLowerCase()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (lower === 'now') return now
  if (lower === 'today') return today
  if (lower === 'tomorrow') return new Date(today.getTime() + 86_400_000)
  if (lower === 'yesterday') return new Date(today.getTime() - 86_400_000)
  if (lower === 'this week') return today
  if (lower === 'next week') {
    const todayDow = today.getDay() // 0=Sun
    const daysUntilNextMon = ((1 - todayDow + 7) % 7) || 7
    return new Date(today.getTime() + daysUntilNextMon * 86_400_000)
  }

  const dowMap: Record<string, number> = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  }
  const dow = dowMap[lower]
  if (dow !== undefined) {
    const todayDow = today.getDay()
    const delta = ((dow - todayDow + 7) % 7) || 7 // always future
    return new Date(today.getTime() + delta * 86_400_000)
  }

  throw new Error(`Unrecognized time expression: "${input}". Accepted: ISO ("2026-06-01T14:00"), "now", "today", "tomorrow", "this week", "next week", "mon"-"sun".`)
}

function formatCT(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

// Walk free gaps between busy intervals. Returns first slot of `minutes` that fits.
function findGap(
  start: Date,
  end: Date,
  busy: Array<{ s: Date; e: Date }>,
  minutes: number,
  businessOnly: boolean,
): Date | null {
  const slotMs = minutes * 60_000
  let cursor = start.getTime()
  const endMs = end.getTime()
  const buckets = [...busy, { s: new Date(endMs), e: new Date(endMs) }]
  for (const b of buckets) {
    const bStart = b.s.getTime()
    while (cursor + slotMs <= bStart && cursor < endMs) {
      const candidate = new Date(cursor)
      if (!businessOnly || inBusinessHours(candidate, slotMs)) {
        return candidate
      }
      cursor = nextBusinessSlotStart(candidate)
    }
    cursor = Math.max(cursor, b.e.getTime())
  }
  return null
}

// Business hours: Mon-Fri, 9am-6pm America/Chicago. We approximate by checking
// the slot in local time (host runs in CT).
function inBusinessHours(d: Date, durationMs: number): boolean {
  const day = d.getDay()
  if (day === 0 || day === 6) return false
  const startH = d.getHours() + d.getMinutes() / 60
  const endH = startH + durationMs / 3_600_000
  return startH >= 9 && endH <= 18
}

function nextBusinessSlotStart(d: Date): number {
  const next = new Date(d)
  const day = next.getDay()
  if (day === 6) next.setDate(next.getDate() + 2)
  else if (day === 0) next.setDate(next.getDate() + 1)
  else if (next.getHours() >= 18 || (next.getHours() === 17 && next.getMinutes() > 0)) {
    next.setDate(next.getDate() + 1)
    if (next.getDay() === 6) next.setDate(next.getDate() + 2)
    else if (next.getDay() === 0) next.setDate(next.getDate() + 1)
  }
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

// Resolve a Google Tasks tasklist by display name (case-insensitive). Falls
// back to the primary list ("@default") when name is missing or unmatched.
async function resolveTaskList(tasksClient: ReturnType<typeof getTasks>, name?: string): Promise<string> {
  if (!name) return '@default'
  const res = await tasksClient.tasklists.list({ maxResults: 50 })
  const match = (res.data.items ?? []).find(l => (l.title ?? '').toLowerCase() === name.toLowerCase())
  return match?.id ?? '@default'
}

// ============================================================
// Public API
// ============================================================

export { ESCALATION_PREFIX as LM_ESCALATION_PREFIX }

// Latest context size (prompt_tokens of the most recent call) per chat — powers the
// lightweight "Nk/96k ctx" indicator so the user can see how full the 96K window is.
const sessionContextTokens = new Map<string, number>()
export function getSessionContextTokens(chatId: string): number {
  return sessionContextTokens.get(chatId) ?? 0
}

export function getLMStudioModel(chatId: string): string {
  return chatModel.get(chatId) ?? LMSTUDIO_DEFAULT_MODEL
}

export function setLMStudioModel(chatId: string, model: string): void {
  chatModel.set(chatId, model)
}

export function clearLMStudioHistory(chatId: string): void {
  chatHistory.delete(chatId)
  sessionContextTokens.delete(chatId)
  clearLMStudioHistoryDb(chatId)
}

export function setLMStudioHistory(
  chatId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): void {
  chatHistory.set(chatId, messages.map((m) => ({ role: m.role, content: m.content })))
}

export function getLMStudioHistory(chatId: string): Array<{ role: string; content: string }> {
  const history = chatHistory.get(chatId) ?? []
  // Return only user/assistant turns (no system, no tool messages) as plain role+content
  // Vision messages are stringified so they can be seeded back into other providers
  return history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: contentToString(m.content) }))
}

export function seedLMStudioHistory(
  chatId: string,
  turns: Array<{ role: string; content: string }>
): void {
  // Only seed if there is no existing history (fresh switch)
  if (chatHistory.has(chatId) && (chatHistory.get(chatId)?.length ?? 0) > 0) return
  if (turns.length === 0) return
  const messages: LMMessage[] = turns.map((t) => ({
    role: t.role as 'user' | 'assistant',
    content: t.content,
  }))
  chatHistory.set(chatId, messages)
}

export function getLMStudioStatus(chatId: string): string {
  const model = getLMStudioModel(chatId)
  return `LM Studio: ${model} @ ${LMSTUDIO_URL} [tools]`
}

export async function isLMStudioAvailable(): Promise<boolean> {
  try {
    const headers: Record<string, string> = {}
    if (LMSTUDIO_API_KEY) {
      headers['Authorization'] = `Bearer ${LMSTUDIO_API_KEY}`
    }
    const res = await fetch(`${LMSTUDIO_URL}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    return res.ok
  } catch (err) {
    logger.warn({ err, url: LMSTUDIO_URL }, 'LM Studio availability check failed')
    return false
  }
}

export async function listLMStudioModels(): Promise<string[]> {
  try {
    const headers: Record<string, string> = {}
    if (LMSTUDIO_API_KEY) {
      headers['Authorization'] = `Bearer ${LMSTUDIO_API_KEY}`
    }
    const res = await fetch(`${LMSTUDIO_URL}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id: string }> }
    return (data.data ?? []).map((m) => m.id)
  } catch (err) {
    logger.warn({ err }, 'Failed to list LM Studio models')
    return []
  }
}

export type LMProgressFn = (u: {
  phase: 'start' | 'thinking' | 'tool_start' | 'tool_done' | 'done' | 'error'
  tool?: string
  loop?: number
  maxLoops?: number
  toolsDone?: number
  detail?: string
}) => void

export function queryLMStudio(
  chatId: string,
  message: string,
  rawMessage: string,
  onTyping?: () => void,
  onQueued?: (aheadOf: string) => void,
  abortSignal?: AbortSignal,
  options?: { locked?: boolean; holderLabel?: string; onProgress?: LMProgressFn }
): Promise<string> {
  const holderLabel = options?.holderLabel
    ?? (chatId.startsWith('sched-') ? `scheduled task ${chatId.slice(6)}` : 'your previous message')
  return withRequestLock(
    () => queryLMStudioInner(chatId, message, rawMessage, onTyping, abortSignal, options),
    holderLabel,
    onQueued
  )
}


// Convert XML-format tool calls (Qwen fallback) to structured ToolCall[].
// Qwen sometimes emits tool calls as text instead of the tool_calls delta,
// typically as <tool_call>{"name":"fn","arguments":{...}}</tool_call> (JSON variant)
// or <tool_call><function=fn><parameter=x>val</parameter></function></tool_call>.
function extractXmlToolCalls(text: string): { calls: ToolCall[]; stripped: string } {
  const calls: ToolCall[] = []
  const xmlBlock = /<tool_call>[\s\S]*?<\/tool_call>/g

  // Variant A: JSON payload inside <tool_call>
  const jsonVariant = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g
  let m: RegExpExecArray | null
  while ((m = jsonVariant.exec(text)) !== null) {
    try {
      const p = JSON.parse(m[1]) as { name?: string; arguments?: unknown }
      if (p.name) {
        calls.push({
          id: `xmltc_${Date.now()}_${calls.length}`,
          type: 'function',
          function: {
            name: p.name,
            arguments: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {}),
          },
        })
      }
    } catch { /* malformed JSON — skip */ }
  }

  // Variant B: attribute-style XML  <function=name><parameter=x>val</parameter></function>
  if (calls.length === 0) {
    const attrVariant = /<tool_call>\s*<function=(\w+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g
    const paramRe = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g
    while ((m = attrVariant.exec(text)) !== null) {
      const args: Record<string, string> = {}
      let pm: RegExpExecArray | null
      paramRe.lastIndex = 0
      while ((pm = paramRe.exec(m[2])) !== null) args[pm[1]] = pm[2].trim()
      calls.push({
        id: `xmltc_${Date.now()}_${calls.length}`,
        type: 'function',
        function: { name: m[1], arguments: JSON.stringify(args) },
      })
    }
  }

  const stripped = calls.length > 0 ? text.replace(xmlBlock, '').trim() : text
  return { calls, stripped }
}

// Parse an OpenAI-compatible SSE streaming response into the same shape we used
// to get from res.json().  Headers arrive immediately so headersTimeout never fires.
interface SSEResult {
  message: {
    content: string | null
    reasoning_content?: string | null
    tool_calls?: ToolCall[]
  }
  finish_reason: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}
async function readSSEResponse(res: Response): Promise<SSEResult> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let reasoning = ''
  let finish_reason = 'stop'
  let usage: SSEResult['usage']
  // Index → partial tool call accumulation
  const tcBufs: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []

  outer: while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''  // keep incomplete line
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (raw === '[DONE]') break outer
      let chunk: any
      try { chunk = JSON.parse(raw) } catch { continue }
      if (chunk.usage) usage = chunk.usage
      const delta = chunk.choices?.[0]?.delta
      const fr = chunk.choices?.[0]?.finish_reason
      if (fr) finish_reason = fr
      if (!delta) continue
      if (typeof delta.content === 'string') content += delta.content
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0
          if (!tcBufs[idx]) {
            tcBufs[idx] = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } }
          }
          if (tc.id) tcBufs[idx].id = tc.id
          if (tc.function?.name) tcBufs[idx].function.name += tc.function.name
          if (tc.function?.arguments) tcBufs[idx].function.arguments += tc.function.arguments
        }
      }
    }
  }

  const tool_calls = tcBufs.length > 0 ? tcBufs.filter(Boolean) as ToolCall[] : undefined
  return {
    message: {
      content: content || null,
      reasoning_content: reasoning || null,
      tool_calls,
    },
    finish_reason,
    usage,
  }
}

async function queryLMStudioInner(
  chatId: string,
  message: string,
  rawMessage: string,
  onTyping?: () => void,
  externalSignal?: AbortSignal,
  options?: { locked?: boolean; onProgress?: LMProgressFn }
): Promise<string> {
  const model = getLMStudioModel(chatId)
  const onProgress = options?.onProgress
  let toolsDone = 0

  // Build message history
  let history = chatHistory.get(chatId)
  if (!history) {
    history = []
    chatHistory.set(chatId, history)
  }

  // Preprocess photos: Gemini describes images, Qwen gets plain text (no base64)
  let processedRaw: string = rawMessage
  let processedMessage: string = message
  const hasPhotoMarkers = rawMessage.includes('[Photo attached:')
  if (hasPhotoMarkers) {
    // preprocessPhotoMessage always returns text (placeholder if vision API fails)
    // Never falls back to base64 — base64 in history causes context overflow
    const visionResult = await preprocessPhotoMessage(rawMessage, message)
    if (visionResult) {
      processedRaw = visionResult.processedRaw
      processedMessage = visionResult.processedMessage
    }
    // If visionResult is null (unexpected), processedRaw/processedMessage stay as rawMessage/message strings
    // which is safe (photo markers become visible text, no base64 injected)
  }

  // If the previous turn was aborted mid-generation, its user entry (with any
  // vision descriptions baked in) is still the last item in history. Merge the
  // new turn into it so Qwen sees one well-formed user->assistant pair AND keeps
  // the prior photo/caption context. Without this merge, follow-up messages lose
  // context like "What's them?" referring to cats from a photo that was aborted.
  const lastEntry = history[history.length - 1]
  if (lastEntry?.role === 'user') {
    const priorContent = typeof lastEntry.content === 'string'
      ? lastEntry.content
      : contentToString(lastEntry.content)
    lastEntry.content = `${priorContent}\n\n${processedRaw}`
    processedRaw = lastEntry.content
    processedMessage = `${priorContent}\n\n${processedMessage}`
  } else {
    history.push({ role: 'user', content: processedRaw })
  }
  const userMessageIndex = history.length - 1

  // Trim history -- ensure we start at a user message to satisfy Qwen's Jinja template
  if (history.length > MAX_HISTORY) {
    let trimTo = history.length - MAX_HISTORY
    // Advance past tool/assistant messages so history always starts with a user message
    while (trimTo < history.length && history[trimTo].role !== 'user') {
      trimTo++
    }
    history.splice(0, trimTo)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (LMSTUDIO_API_KEY) {
    headers['Authorization'] = `Bearer ${LMSTUDIO_API_KEY}`
  }

  logger.info({ chatId, model, historyLen: history.length }, 'Querying LM Studio')

  // Keep typing indicator alive during generation + tool loops
  const typingInterval = onTyping ? setInterval(onTyping, 4000) : null
  onProgress?.({ phase: 'start', loop: 0, maxLoops: MAX_TOOL_LOOPS, toolsDone: 0 })

  try {
    let finalContent = ''
    let loopExhausted = true // set false on clean (no-tool-call) break
    let emptyToolResults = 0
    const EMPTY_RESULT_LIMIT = 3

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      onProgress?.({
        phase: 'thinking',
        loop: loop + 1,
        maxLoops: MAX_TOOL_LOOPS,
        toolsDone,
      })
      // Per-loop fetch signal: each iteration gets its own LMSTUDIO_TIMEOUT_MS
      // budget so a slow tool chain doesn't share one wall clock across all loops.
      // (Before this, a 10 min "per-request" timeout was actually 10 min TOTAL for
      // the whole tool-calling roundtrip -- 3 long thinking loops would burn it.)
      const fetchSignal = externalSignal
        ? AbortSignal.any([externalSignal, AbortSignal.timeout(LMSTUDIO_TIMEOUT_MS)])
        : AbortSignal.timeout(LMSTUDIO_TIMEOUT_MS)
      // Build messages with system prompt, sanitizing for Jinja compatibility
      // Qwen's template chokes on null content and orphaned tool messages.
      // Array content (vision blocks) is passed through as-is.
      // On the first loop only, inject the memory-augmented user message so Qwen
      // has memory context — but we stored the raw message in history so future
      // turns don't accumulate stale [Memory context] blocks.
      // Loop 0 with memory context: send preprocessed+augmented version.
      // Loop 1+: history entry already has processedRaw.
      const augmentedContent = loop === 0 && message !== rawMessage
        ? processedMessage
        : null
      const messages: LMMessage[] = [
        { role: 'system', content: buildSystemPrompt() },
        ...history.map((m, i) => ({
          ...m,
          content: i === userMessageIndex && m.role === 'user'
            ? (augmentedContent ?? m.content ?? '')
            : Array.isArray(m.content) ? m.content : (m.content ?? ''),
        })),
      ]

      // After 4 research loops, nudge model to synthesize instead of calling more tools
      if (loop >= 4) {
        messages.push({
          role: 'user',
          content: '[System: You have gathered enough information. Please synthesize your answer now from what you have. Do not make more tool calls.]',
        })
      }

      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 32768,
        tools: options?.locked ? TOOLS.filter(t => t.function.name !== 'escalate') : TOOLS,
        stream: true,
        // Ask for usage in the final stream chunk so the 96K context gauge can populate
        // (without this, streamed responses carry no token usage -> gauge stays hidden).
        stream_options: { include_usage: true },
        // Usage attribution for the LiteLLM usage_tracker callback (per-consumer).
        metadata: { tags: ['personalos'] },
      }

      const res = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: fetchSignal,
      })

      if (!res.ok) {
        const errBody = await res.text()
        // If Jinja template error (seeded history confuses model), retry with minimal history
        if (loop === 0 && (errBody.includes('jinja') || errBody.includes('No user query') || errBody.includes('user query'))) {
          logger.warn({ chatId, historyLen: history.length }, 'Jinja template error — retrying with clean history')
          history.splice(0, history.length - 1) // keep only the current user message
          const cleanMessages: LMMessage[] = [
            { role: 'system', content: buildSystemPrompt() },
            history[0],
          ]
          const cleanBody = { ...body, messages: cleanMessages }
          const retry = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(cleanBody),
            signal: fetchSignal,
          })
          if (!retry.ok) {
            const retryErr = await retry.text()
            throw new Error(`LM Studio API error ${retry.status}: ${retryErr}`)
          }
          const retryResult = await readSSEResponse(retry)
          finalContent = retryResult.message.content ?? ''
          // Push the assistant reply into history so the next turn sees what we said.
          if (finalContent) history.push({ role: 'assistant', content: finalContent })
          break
        }
        // If tools cause an error, retry without tools (also streaming)
        if (loop === 0 && (errBody.includes('tools') || errBody.includes('function'))) {
          logger.warn({ errBody }, 'LM Studio tool call error, retrying without tools')
          delete body.tools
          const retry = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: fetchSignal,
          })
          if (!retry.ok) {
            const retryErr = await retry.text()
            throw new Error(`LM Studio API error ${retry.status}: ${retryErr}`)
          }
          const retryResult = await readSSEResponse(retry)
          finalContent = retryResult.message.content ?? ''
          // Push the assistant reply into history so the next turn sees what we said.
          if (finalContent) history.push({ role: 'assistant', content: finalContent })
          break
        }
        throw new Error(`LM Studio API error ${res.status}: ${errBody}`)
      }

      const sseResult = await readSSEResponse(res)
      const choice = { message: sseResult.message, finish_reason: sseResult.finish_reason }
      const data = { choices: [choice], usage: sseResult.usage }
      const assistantMsg = choice?.message

      logger.info({
        chatId, model, loop,
        finish_reason: choice?.finish_reason,
        prompt_tokens: data.usage?.prompt_tokens,
        completion_tokens: data.usage?.completion_tokens,
        total_tokens: data.usage?.total_tokens,
        has_content: !!assistantMsg?.content,
        has_reasoning: !!assistantMsg?.reasoning_content,
        reasoning_len: assistantMsg?.reasoning_content?.length ?? 0,
        content_len: assistantMsg?.content?.length ?? 0,
      }, 'LM Studio token usage')

      // Latest prompt_tokens = current session context size (system + full history +
      // this turn). Overwrites each loop so it ends at the turn's peak. For the indicator.
      if (data.usage?.prompt_tokens) sessionContextTokens.set(chatId, data.usage.prompt_tokens)

      if (!assistantMsg) {
        finalContent = '(no response from model)'
        break
      }

      // If content is empty but reasoning_content exists, the model exhausted its token budget
      // on thinking with nothing left for the actual response. Fall back to reasoning_content
      // so the user gets something useful instead of a blank reply.
      const picked = pickAssistantContent(assistantMsg)
      if (picked.usedReasoningFallback) {
        logger.warn({ chatId, model }, 'Qwen returned empty content with only reasoning_content — using reasoning as fallback')
      }
      assistantMsg.content = picked.content

      // Detect XML-format tool calls (Qwen fallback when tool_calls delta was absent)
      if (!assistantMsg.tool_calls?.length && assistantMsg.content?.includes('<tool_call>')) {
        const { calls, stripped } = extractXmlToolCalls(assistantMsg.content)
        if (calls.length > 0) {
          logger.info({ chatId, model, loop, count: calls.length }, 'XML tool calls detected in content — converting to structured calls')
          assistantMsg.tool_calls = calls
          assistantMsg.content = stripped || null
        }
      }

      // Add the assistant message to history
      const historyEntry: LMMessage = {
        role: 'assistant',
        content: assistantMsg.content,
      }
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        historyEntry.tool_calls = assistantMsg.tool_calls
      }
      history.push(historyEntry)

      // If no tool calls, we're done.
      // Preserve any text accumulated from prior tool-calling loops -- if the
      // model emitted prose alongside earlier tool calls, that prose is part
      // of the answer (e.g. the parable text emitted before a write_file call).
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const finalText = (assistantMsg.content ?? '').trim()
        const prior = finalContent.trim()
        finalContent = prior && finalText ? `${prior}\n\n${finalText}` : (finalText || prior)
        loopExhausted = false
        break
      }

      // Execute tool calls
      for (const toolCall of assistantMsg.tool_calls) {
        const fn = toolCall.function
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(fn.arguments)
        } catch (parseErr) {
          logger.warn(
            { chatId, tool: fn.name, rawArgs: fn.arguments?.slice(0, 300), err: parseErr },
            'Tool args JSON.parse failed — passing as _raw'
          )
          args = { _raw: fn.arguments }
        }

        logger.info(
          { chatId, tool: fn.name, args, loop },
          'LM Studio tool call'
        )
        onProgress?.({
          phase: 'tool_start',
          tool: fn.name,
          loop: loop + 1,
          maxLoops: MAX_TOOL_LOOPS,
          toolsDone,
        })

        // Tool exceptions must NOT bubble up. If they do, queryLMStudioInner's
        // catch treats them as a query failure and bot.ts reports "LM Studio
        // unreachable" even when the actual failure was a Playwright crash or
        // a fetch throwing. Convert any exception to an error string so Qwen
        // can read it as a normal tool result and try a different approach.
        let result: string
        try {
          result = await executeTool(fn.name, args as Record<string, string>, chatId)
        } catch (toolErr) {
          const msg = toolErr instanceof Error ? toolErr.message : String(toolErr)
          logger.warn({ chatId, tool: fn.name, err: toolErr }, 'Tool threw -- returning as tool result')
          result = `Tool error (${fn.name}): ${msg.slice(0, 1500)}`
        }

        toolsDone++
        onProgress?.({
          phase: 'tool_done',
          tool: fn.name,
          loop: loop + 1,
          maxLoops: MAX_TOOL_LOOPS,
          toolsDone,
        })

        logger.info(
          { chatId, tool: fn.name, resultLen: result.length, loop },
          'LM Studio tool result'
        )

        // Blocked/paywalled pages return tiny content and waste a loop
        if ((fn.name === 'web_fetch' || fn.name === 'browse_url') && result.trim().length < 300) {
          result = '[Page blocked, paywalled, or empty — move on to another source]'
        }

        // Check for escalation request
        if (result.startsWith(ESCALATION_PREFIX)) {
          finalContent = result
          // Remove the user message we added since Claude will re-process it
          let userIdx = -1; for (let i = history.length - 1; i >= 0; i--) { if (history[i].role === 'user') { userIdx = i; break } }
          if (userIdx >= 0) history.splice(userIdx)
          return finalContent
        }

        // Track empty results to detect thrashing; inject give-up hint after EMPTY_RESULT_LIMIT
        if (!result || result.trim().length < 10 || result === '(no output)') {
          emptyToolResults++
        }
        if (emptyToolResults >= EMPTY_RESULT_LIMIT) {
          history.push({ role: 'tool', content: result, tool_call_id: toolCall.id })
          history.push({
            role: 'user',
            content: '[System: Multiple tool calls returned empty results. Please give the user your best answer now with what you know, or honestly state you cannot find the information.]',
          })
          break
        }

        // Add tool result to history
        history.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        })
      }

      // If the assistant also included text content alongside tool calls, accumulate it.
      // Trim before checking — the model sometimes emits "\n\n" alongside tool calls,
      // which accumulates as whitespace-only content and looks blank to the user.
      const sideContent = (assistantMsg.content ?? '').trim()
      if (sideContent) {
        finalContent += sideContent + '\n'
      }

      // Loop continues -- model will see tool results and respond
    }

    // Add final assistant text to history (if not already the last entry)
    const lastEntry = history[history.length - 1]
    if (lastEntry?.role !== 'assistant' || lastEntry?.tool_calls) {
      // The final text response was already pushed in the loop above
      // Only add if we accumulated content from a tool-calling loop
      if (finalContent && lastEntry?.role === 'tool') {
        history.push({ role: 'assistant', content: finalContent })
      }
    }

    const trimmedContent = finalContent.trim()

    logger.info(
      { chatId, model, responseLen: trimmedContent.length },
      'LM Studio response received'
    )

    // Persist to SQLite so history survives restarts
    persistHistory(chatId)

    // Cross-provider conversation log: lets /model switches see what we just said.
    // Skip empties and the help-text fallback so the log only contains real answers.
    if (trimmedContent && !trimmedContent.startsWith("I wasn't able to find")) {
      try {
        logConversationTurn(chatId, rawMessage, trimmedContent, model)
      } catch (logErr) {
        logger.warn({ err: logErr, chatId }, 'logConversationTurn failed')
      }
    }

    if (!trimmedContent && loopExhausted) {
      onProgress?.({ phase: 'done', toolsDone, maxLoops: MAX_TOOL_LOOPS })
      return "I wasn't able to find that information with the tools available to me. If it's something stored externally (email, calendar, a website), I don't have access to it directly — you may need to share the content with me."
    }
    onProgress?.({ phase: 'done', toolsDone, maxLoops: MAX_TOOL_LOOPS })
    return trimmedContent || '(no response)'
  } catch (err) {
    let userIdx = -1; for (let i = history.length - 1; i >= 0; i--) { if (history[i].role === 'user') { userIdx = i; break } }
    if (err instanceof Error && err.name === 'AbortError') {
      // Abort means a new debounced message is about to retry. Keep the user
      // entry (which has vision descriptions, caption, memory ctx baked in) so
      // the retry preserves context. Drop only orphan assistant/tool entries
      // from this aborted turn so history stays well-formed.
      if (userIdx >= 0 && userIdx + 1 < history.length) {
        history.splice(userIdx + 1)
      }
    } else if (userIdx >= 0) {
      // Other errors (network, timeout, model down) -- full rollback so a
      // future retry doesn't double-push the user message.
      history.splice(userIdx)
    }
    onProgress?.({
      phase: 'error',
      detail: err instanceof Error ? err.message.slice(0, 80) : 'error',
      toolsDone,
    })
    throw err
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }
}
