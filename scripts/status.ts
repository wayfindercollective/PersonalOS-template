import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const ok = (label: string, detail: string) =>
  console.log(`  ${GREEN}✓${RESET} ${label}: ${detail}`)
const fail = (label: string, detail: string) =>
  console.log(`  ${RED}✗${RESET} ${label}: ${detail}`)
const warn = (label: string, detail: string) =>
  console.log(`  ${YELLOW}⚠${RESET} ${label}: ${detail}`)

function readEnv(): Record<string, string> {
  const envPath = resolve(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return {}
  const result: Record<string, string> = {}
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    result[t.slice(0, eq).trim()] = val
  }
  return result
}

async function main() {
  console.log(`\n${BOLD}PersonalOS Status${RESET}\n${'─'.repeat(40)}`)

  // Node
  const nodeMajor = parseInt(process.version.replace('v', '').split('.')[0])
  if (nodeMajor >= 20) ok('Node.js', process.version)
  else fail('Node.js', `${process.version} (need >= 20)`)

  // Claude CLI
  try {
    const v = execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
    ok('Claude CLI', v)
  } catch {
    fail('Claude CLI', 'not found')
  }

  // .env
  const env = readEnv()
  if (Object.keys(env).length > 0) ok('.env', 'present')
  else fail('.env', 'missing')

  // Bot token
  if (env['TELEGRAM_BOT_TOKEN']) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env['TELEGRAM_BOT_TOKEN']}/getMe`
      )
      const data = (await res.json()) as { ok: boolean; result?: { username: string } }
      if (data.ok) ok('Telegram bot', `@${data.result!.username}`)
      else fail('Telegram bot', 'invalid token')
    } catch {
      fail('Telegram bot', 'could not validate token')
    }
  } else {
    fail('Telegram bot', 'TELEGRAM_BOT_TOKEN not set')
  }

  // Chat ID
  if (env['ALLOWED_CHAT_ID']) ok('Chat ID', env['ALLOWED_CHAT_ID'])
  else warn('Chat ID', 'not set (first-run mode, accepts all)')

  // Whisper
  if (env['WHISPER_WS_URL']) ok('Whisper STT', env['WHISPER_WS_URL'])
  else warn('Whisper STT', 'not configured')

  // Google API
  if (env['GOOGLE_API_KEY']) ok('Google API', 'configured')
  else warn('Google API', 'not set (video analysis disabled)')

  // Scheduler
  if (env['SCHEDULER_ENABLED'] === 'true') ok('Scheduler', 'enabled')
  else warn('Scheduler', 'disabled')

  // WhatsApp
  if (env['WA_ENABLED'] === 'true') ok('WhatsApp', 'enabled')
  else warn('WhatsApp', 'disabled')

  // Systemd service
  try {
    const status = execSync(
      'systemctl --user is-active personalos.service 2>/dev/null',
      { encoding: 'utf-8' }
    ).trim()
    if (status === 'active') ok('Service', 'running')
    else warn('Service', status)
  } catch {
    warn('Service', 'not installed')
  }

  // Database
  const dbPath = resolve(PROJECT_ROOT, 'store', 'personalos.db')
  if (existsSync(dbPath)) {
    ok('Database', dbPath)
    try {
      // Quick memory count
      const { default: Database } = await import('better-sqlite3')
      const db = new Database(dbPath, { readonly: true })
      const memRow = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }
      const taskRow = db.prepare('SELECT COUNT(*) as c FROM scheduled_tasks').get() as { c: number }
      console.log(`    Memories: ${memRow.c} | Tasks: ${taskRow.c}`)
      db.close()
    } catch {
      // tables might not exist yet
    }
  } else {
    warn('Database', 'not created yet (starts on first run)')
  }

  // PID
  const pidPath = resolve(PROJECT_ROOT, 'store', 'personalos.pid')
  if (existsSync(pidPath)) {
    const pid = readFileSync(pidPath, 'utf-8').trim()
    try {
      process.kill(parseInt(pid), 0)
      ok('Process', `PID ${pid} (running)`)
    } catch {
      warn('Process', `PID ${pid} (stale)`)
    }
  }

  console.log()
}

main().catch(console.error)
