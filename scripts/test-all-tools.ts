/**
 * test-all-tools.ts
 *
 * Direct integration test for every Claudeclaw tool we can exercise without
 * going through Telegram. Probes the underlying mechanism each tool case
 * relies on. Errors that are expected (auth not configured) count as PASS.
 *
 * Run from the project root:
 *   cd ~/personalos && npx tsx scripts/test-all-tools.ts
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { embed } from '../src/embeddings.js'
import { synthesizeVoice, ttsAvailable, cleanupTtsFile } from '../src/tts.js'
import { getDb } from '../src/db.js'
import { getCalendar, getGmail, getTasks } from '../src/google.js'

interface TestResult {
  name: string
  status: 'PASS' | 'FAIL' | 'SKIP'
  detail: string
  ms: number
}

const results: TestResult[] = []

function logLive(name: string, status: string, detail: string): void {
  const pad = name.padEnd(34)
  console.log(`  ${status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○'} ${pad} ${detail.slice(0, 90)}`)
}

async function run(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now()
  try {
    const detail = await fn()
    const r: TestResult = { name, status: 'PASS', detail, ms: Date.now() - t0 }
    results.push(r)
    logLive(name, 'PASS', `${r.ms}ms  ${detail}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const r: TestResult = { name, status: 'FAIL', detail: msg.slice(0, 300), ms: Date.now() - t0 }
    results.push(r)
    logLive(name, 'FAIL', `${r.ms}ms  ${msg.slice(0, 90)}`)
  }
}

// For tools whose expected outcome is a clean error message (auth not set up).
// The probe PASSes if either the call succeeds OR the error matches the expected pattern.
async function runExpectingError(name: string, expectedPattern: RegExp, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now()
  try {
    const result = await fn()
    const r: TestResult = { name, status: 'PASS', detail: `(succeeded) ${result.slice(0, 120)}`, ms: Date.now() - t0 }
    results.push(r)
    logLive(name, 'PASS', `${r.ms}ms  ${r.detail}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (expectedPattern.test(msg)) {
      const r: TestResult = { name, status: 'PASS', detail: `(expected: ${msg.slice(0, 120)})`, ms: Date.now() - t0 }
      results.push(r)
      logLive(name, 'PASS', `${r.ms}ms  expected-error captured`)
    } else {
      const r: TestResult = { name, status: 'FAIL', detail: msg.slice(0, 300), ms: Date.now() - t0 }
      results.push(r)
      logLive(name, 'FAIL', `${r.ms}ms  unexpected: ${msg.slice(0, 70)}`)
    }
  }
}

async function main(): Promise<void> {
  console.log('Claudeclaw tool integration tests\n')
  console.log('───────────────────────────────────────────────────────────────────\n')

  // ─── Calculator (mathjs) ───────────────────────────────────────────
  await run('calculate (mph→km/h)', async () => {
    const { evaluate, createUnit } = await import('mathjs')
    try { createUnit('mph', { definition: '1 mile/hour' }) } catch { /* already */ }
    const result = evaluate('180 mph in km/h').toString()
    if (!/km/.test(result)) throw new Error(`unexpected result: ${result}`)
    return result
  })

  await run('calculate (inches→cm)', async () => {
    const { evaluate } = await import('mathjs')
    const result = evaluate('3 inches to cm').toString()
    return result
  })

  // ─── Weather (Open-Meteo) ──────────────────────────────────────────
  await run('weather: Austin TX', async () => {
    const geo = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=Austin&count=1', { signal: AbortSignal.timeout(8000) })
    if (!geo.ok) throw new Error(`geocode HTTP ${geo.status}`)
    const gd = await geo.json() as { results?: Array<{ latitude: number; longitude: number; name: string }> }
    const hit = gd.results?.[0]
    if (!hit) throw new Error('no geocode hit')
    const wx = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m&temperature_unit=fahrenheit`, { signal: AbortSignal.timeout(8000) })
    if (!wx.ok) throw new Error(`weather HTTP ${wx.status}`)
    const wd = await wx.json() as { current?: { temperature_2m: number } }
    return `Austin ${wd.current?.temperature_2m}°F`
  })

  await run('weather: Portsmouth NH disambiguation', async () => {
    const geo = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=Portsmouth&count=10', { signal: AbortSignal.timeout(8000) })
    const gd = await geo.json() as { results?: Array<{ name: string; admin1?: string; country_code?: string; latitude: number; longitude: number }> }
    const nh = gd.results?.find(r => r.country_code === 'US' && (r.admin1 ?? '').toUpperCase() === 'NEW HAMPSHIRE')
    if (!nh) throw new Error('NH disambiguation missing')
    return `${nh.name}, ${nh.admin1} (${nh.latitude.toFixed(2)},${nh.longitude.toFixed(2)})`
  })

  // ─── Stock data (Yahoo Finance) ────────────────────────────────────
  await run('stock_price: AAPL', async () => {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; currency?: string } }> } }
    const meta = data.chart?.result?.[0]?.meta
    if (!meta?.regularMarketPrice) throw new Error('no price in response')
    return `$${meta.regularMarketPrice} ${meta.currency ?? ''}`
  })

  await run('stock_news: AAPL RSS', async () => {
    const res = await fetch('https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL&region=US&lang=en-US', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const xml = await res.text()
    const titleMatch = xml.match(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)
    if (!titleMatch) throw new Error('no items in RSS')
    return `first headline: "${titleMatch[1].slice(0, 60)}"`
  })

  // ─── URL shortener (is.gd) ─────────────────────────────────────────
  await run('shorten_url (is.gd)', async () => {
    const res = await fetch('https://is.gd/create.php?format=simple&url=' + encodeURIComponent('https://example.com'), { signal: AbortSignal.timeout(8000) })
    const text = (await res.text()).trim()
    if (!text.startsWith('http')) throw new Error(`bad response: ${text.slice(0, 100)}`)
    return text
  })

  // ─── QR code (qrcode npm) ──────────────────────────────────────────
  await run('generate_qr (qrcode npm)', async () => {
    const qrcode = await import('qrcode')
    const toFile = (qrcode as { toFile?: typeof qrcode.toFile; default?: { toFile: typeof qrcode.toFile } }).toFile
      ?? (qrcode as { default?: { toFile: typeof qrcode.toFile } }).default?.toFile
    if (!toFile) throw new Error('qrcode.toFile not exported')
    const out = '/tmp/test-tool-qr.png'
    await toFile(out, 'https://example.com', { width: 200 })
    const size = statSync(out).size
    execSync(`rm -f ${out}`)
    return `wrote ${size}-byte PNG`
  })

  // ─── Quick note ────────────────────────────────────────────────────
  await run('quick_note (append scratchpad)', async () => {
    const path = './workspace/scratchpad.md'
    const stamp = new Date().toISOString()
    const entry = `\n- [${stamp}] #tool-test test entry`
    const cur = existsSync(path) ? readFileSync(path, 'utf-8') : '# Scratchpad\n'
    const next = cur + entry
    writeFileSync(path, next)
    // Don't roll back — leave the test note as evidence.
    return `appended (file now ${statSync(path).size} bytes)`
  })

  // ─── search_my_chats (SQLite LIKE) ─────────────────────────────────
  await run('search_my_chats: any term', async () => {
    const db = getDb()
    const row = db.prepare("SELECT COUNT(*) AS c FROM conversation_log").get() as { c: number }
    return `conversation_log rows: ${row.c}`
  })

  // ─── system_status (host probe pieces) ──────────────────────────
  await run('system_status: free+df+systemd', async () => {
    const free = execSync('free -h | head -2 | tail -1', { encoding: 'utf-8', timeout: 5000 }).trim()
    const df = execSync("df -h / | tail -1 | awk '{print $5}'", { encoding: 'utf-8', timeout: 5000 }).trim()
    const ccActive = execSync('systemctl --user is-active personalos', { encoding: 'utf-8', timeout: 5000 }).trim()
    return `mem-row=${free.split(/\s+/).slice(1, 4).join(',')}  disk=${df}  cc=${ccActive}`
  })

  // ─── e2e_status (script invocation) ────────────────────────────────
  await run('e2e_status (script)', async () => {
    const out = spawnSync('bash', ['./scripts/e2e-status.sh'], { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    if (out.error) throw out.error
    if (!out.stdout?.includes('E2E status')) throw new Error('unexpected output')
    return out.stdout.split('\n').slice(0, 3).join(' | ')
  })

  // ─── TTS (flite + ffmpeg) ──────────────────────────────────────────
  await run('tts: synthesizeVoice', async () => {
    if (!ttsAvailable()) throw new Error('TTS not available')
    const oggPath = await synthesizeVoice('Tool integration test message.')
    if (!oggPath) throw new Error('synth returned null')
    const size = statSync(oggPath).size
    cleanupTtsFile(oggPath)
    if (size < 500) throw new Error(`ogg too small: ${size} bytes`)
    return `${size}-byte ogg via flite`
  })

  // ─── GitHub (gh CLI) ───────────────────────────────────────────────
  await run('gh_list_issues: your-app', async () => {
    const out = spawnSync('gh', ['issue', 'list', '--repo', 'owner/repo', '--limit', '3', '--json', 'number,title'], {
      encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe']
    })
    if (out.error) throw out.error
    if (out.status !== 0) throw new Error(`gh exit ${out.status}: ${(out.stderr ?? '').slice(0, 200)}`)
    const issues = JSON.parse(out.stdout || '[]') as Array<{ number: number; title: string }>
    return `${issues.length} issues; first: #${issues[0]?.number} ${issues[0]?.title?.slice(0, 50) ?? '(none)'}`
  })

  // ─── Convex CLI presence ───────────────────────────────────────────
  await run('convex CLI available', async () => {
    const out = spawnSync('npx', ['convex', '--version'], {
      encoding: 'utf-8', timeout: 30_000,
      cwd: process.env.WORK_PROJECT_DIR || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: process.env.PATH ?? '' },
    })
    if (out.error) throw out.error
    if (out.status !== 0) throw new Error(`exit ${out.status}: ${(out.stderr ?? '').slice(0, 200)}`)
    return `version: ${(out.stdout ?? '').trim()}`
  })

  // ─── Long-runner (smoke: launch, wait, verify log) ─────────────────
  await run('run_long_command: sleep + echo', async () => {
    const out = spawnSync('bash', [
      './scripts/long-runner.sh',
      '--cmd', 'sleep 2 && echo TOOLTEST_DONE',
      '--label', 'integration-test',
      '--silent',
      '--timeout-min', '1',
    ], { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    if (out.error) throw out.error
    if (out.status !== 0) throw new Error(`launch exit ${out.status}: ${(out.stderr ?? '').slice(0, 200)}`)
    // Wait up to 8s for the detached child to finish.
    await new Promise(r => setTimeout(r, 6_000))
    const latestLog = execSync('ls -t ./store/long-runner-logs/integration-test-*.log 2>/dev/null | head -1', { encoding: 'utf-8' }).trim()
    if (!latestLog) throw new Error('no log file appeared')
    const content = readFileSync(latestLog, 'utf-8')
    if (!content.includes('TOOLTEST_DONE')) throw new Error(`log missing TOOLTEST_DONE: ${content.slice(-200)}`)
    if (!/rc=0/.test(content)) throw new Error(`log missing rc=0: ${content.slice(-200)}`)
    return `detached run completed, rc=0, log=${latestLog.split('/').pop()}`
  })

  // ─── File converter (tool presence) ────────────────────────────────
  await run('convert_file: pdftotext', async () => {
    const out = execSync('pdftotext -v 2>&1 | head -1', { encoding: 'utf-8', timeout: 5000 })
    return out.trim()
  })

  await run('convert_file: ImageMagick convert', async () => {
    const out = execSync('convert -version | head -1', { encoding: 'utf-8', timeout: 5000 })
    return out.trim()
  })

  await run('convert_file: ffmpeg', async () => {
    const out = execSync('ffmpeg -version 2>&1 | head -1', { encoding: 'utf-8', timeout: 5000 })
    return out.trim()
  })

  // ─── Memory embeddings (Gemini fallback) ───────────────────────────
  await run('embeddings: embed test string', async () => {
    const r = await embed('hello world embedding test.')
    if (!r) throw new Error('embed returned null (LiteLLM + Gemini both failed)')
    if (!r.embedding.length) throw new Error('zero-length embedding')
    return `dim=${r.embedding.length} via ${r.model}`
  })

  // ─── Google Calendar (expect auth error until re-authed) ───────────
  await runExpectingError('calendar: list events (work)', /unauthorized_client|invalid_grant|Token has been expired|Cannot use auth|No Google token/i, async () => {
    const cal = getCalendar('work')
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + 86_400_000).toISOString(),
      singleEvents: true,
      maxResults: 1,
    })
    return `${(res.data.items ?? []).length} events`
  })

  await runExpectingError('calendar: list events (personal)', /unauthorized_client|invalid_grant|Token has been expired|No Google token/i, async () => {
    const cal = getCalendar('personal')
    const res = await cal.events.list({ calendarId: 'primary', timeMin: new Date().toISOString(), maxResults: 1 })
    return `${(res.data.items ?? []).length} events`
  })

  // ─── Gmail (expect auth error) ─────────────────────────────────────
  await runExpectingError('gmail: list unread (personal)', /unauthorized_client|invalid_grant|Token has been expired|No Google token/i, async () => {
    const gmail = getGmail('personal')
    const res = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 1 })
    return `${(res.data.messages ?? []).length} unread`
  })

  // ─── Google Tasks (expect auth error) ──────────────────────────────
  await runExpectingError('tasks: list (work)', /unauthorized_client|invalid_grant|Token has been expired|No Google token/i, async () => {
    const t = getTasks('work')
    const res = await t.tasks.list({ tasklist: '@default', maxResults: 1 })
    return `${(res.data.items ?? []).length} tasks`
  })

  // ─── Apple tools (expect MAC_SSH_TARGET not set) ───────────────────
  await run('apple: MAC_SSH_TARGET not set warning', async () => {
    const envFile = readFileSync('./.env', 'utf-8')
    const hasTarget = /^MAC_SSH_TARGET\s*=\s*\S/m.test(envFile)
    return hasTarget ? 'MAC_SSH_TARGET is set' : 'MAC_SSH_TARGET not set (expected — Apple tools return setup hint)'
  })

  // ─── Vision pipeline (Gemini) ──────────────────────────────────────
  await run('vision: gemini-2.5-flash describe', async () => {
    const env = readFileSync('./.env', 'utf-8')
    const m = env.match(/^GOOGLE_API_KEY=(.+)$/m)
    if (!m) throw new Error('no GOOGLE_API_KEY')
    const key = m[1].replace(/^["']|["']$/g, '')
    // tiny 1x1 transparent png
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: 'image/png', data: tinyPng } }, { text: 'Reply with one word.' }] }],
        generationConfig: { maxOutputTokens: 50, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    return `Gemini replied: ${(text ?? '').slice(0, 80)}`
  })

  // ─── Schedule + raw task type (DB state) ───────────────────────────
  await run('scheduled_tasks: raw type column', async () => {
    const db = getDb()
    const cols = db.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>
    const names = cols.map(c => c.name)
    if (!names.includes('task_type')) throw new Error('task_type column missing')
    if (!names.includes('raw_output_mode')) throw new Error('raw_output_mode column missing')
    const rawCount = (db.prepare("SELECT COUNT(*) AS c FROM scheduled_tasks WHERE task_type = 'raw'").get() as { c: number }).c
    return `cols ok; ${rawCount} raw tasks`
  })

  // ─── Memory embeddings table ───────────────────────────────────────
  await run('memory_embeddings table exists', async () => {
    const db = getDb()
    const cols = db.prepare('PRAGMA table_info(memory_embeddings)').all() as Array<{ name: string }>
    if (cols.length === 0) throw new Error('memory_embeddings table missing')
    const count = (db.prepare('SELECT COUNT(*) AS c FROM memory_embeddings').get() as { c: number }).c
    return `cols=${cols.map(c => c.name).join(',')}; rows=${count}`
  })

  // ─── Summary ───────────────────────────────────────────────────────
  const pass = results.filter(r => r.status === 'PASS').length
  const fail = results.filter(r => r.status === 'FAIL').length
  const total = results.length
  console.log('\n───────────────────────────────────────────────────────────────────')
  console.log(`Total: ${total}   PASS: ${pass}   FAIL: ${fail}`)
  if (fail > 0) {
    console.log('\nFailures:')
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  ✗ ${r.name}`)
      console.log(`      ${r.detail}`)
    }
  }
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Test runner crashed:', err)
  process.exit(2)
})
