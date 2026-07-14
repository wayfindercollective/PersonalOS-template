import { execSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ANSI colors
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const ok = (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`)
const warn = (msg: string) => console.log(`${YELLOW}⚠${RESET} ${msg}`)
const fail = (msg: string) => console.log(`${RED}✗${RESET} ${msg}`)
const header = (msg: string) =>
  console.log(`\n${BOLD}${msg}${RESET}\n${'─'.repeat(50)}`)

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> =>
  new Promise((res) => rl.question(`${q} `, res))

const BANNER = `
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝  Setup Wizard
`

async function main() {
  console.log(BANNER)

  // --- Check requirements ---
  header('Checking requirements')

  // Node version
  const nodeVersion = process.version.replace('v', '')
  const nodeMajor = parseInt(nodeVersion.split('.')[0])
  if (nodeMajor >= 20) {
    ok(`Node.js ${nodeVersion}`)
  } else {
    fail(`Node.js ${nodeVersion} (need >= 20)`)
    process.exit(1)
  }

  // Claude CLI
  try {
    const claudeVersion = execSync(
      process.platform === 'win32' ? 'claude --version' : 'claude --version',
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? { shell: 'cmd.exe' } : {}),
      },
    ).trim()
    ok(`Claude CLI: ${claudeVersion}`)
  } catch {
    fail('Claude CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code')
    process.exit(1)
  }

  // Build project
  header('Building project')
  try {
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' })
    ok('TypeScript compiled')
  } catch {
    fail('Build failed. Fix TypeScript errors and try again.')
    process.exit(1)
  }

  // --- Collect config ---
  header('Configuration')

  const envPath = resolve(PROJECT_ROOT, '.env')
  const config: Record<string, string> = {}

  // Load existing .env if present
  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, 'utf-8')
    for (const line of existing.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let val = trimmed.slice(eqIdx + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      config[key] = val
    }
  }

  // Telegram bot token
  console.log(`
To get a Telegram bot token:
  1. Open Telegram and search for @BotFather
  2. Send /newbot
  3. Choose a name (e.g. "My Claude Assistant")
  4. Choose a username ending in "bot" (e.g. "myclaudebot")
  5. Copy the token it gives you
`)
  const token = await ask('Telegram bot token:')
  if (token.trim()) config['TELEGRAM_BOT_TOKEN'] = token.trim()

  // Whisper URL
  const whisperUrl = await ask(
    `Whisper WebSocket URL [${config['WHISPER_WS_URL'] ?? 'ws://127.0.0.1:9090'}]:`
  )
  config['WHISPER_WS_URL'] = whisperUrl.trim() || config['WHISPER_WS_URL'] || 'ws://127.0.0.1:9090'

  // Google API key (for video analysis)
  console.log(`
For video analysis, you need a Google API key:
  1. Go to https://aistudio.google.com
  2. Get an API key (free tier available)
`)
  const googleKey = await ask('Google API key (or press Enter to skip):')
  if (googleKey.trim()) config['GOOGLE_API_KEY'] = googleKey.trim()

  // Scheduler
  const enableScheduler = await ask('Enable scheduler? [Y/n]:')
  config['SCHEDULER_ENABLED'] =
    enableScheduler.trim().toLowerCase() !== 'n' ? 'true' : 'false'

  // WhatsApp
  const enableWa = await ask('Enable WhatsApp bridge? [y/N]:')
  config['WA_ENABLED'] =
    enableWa.trim().toLowerCase() === 'y' ? 'true' : 'false'

  // Write .env
  const envContent = Object.entries(config)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  writeFileSync(envPath, envContent + '\n')
  ok('Wrote .env')

  // --- Open CLAUDE.md for editing ---
  header('Personalize CLAUDE.md')
  const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'notepad' : 'nano')
  console.log(
    `Opening CLAUDE.md in ${editor}. Fill in [YOUR NAME] and [YOUR ASSISTANT NAME] placeholders.`
  )
  const editNow = await ask('Open editor now? [Y/n]:')
  if (editNow.trim().toLowerCase() !== 'n') {
    spawnSync(editor, [resolve(PROJECT_ROOT, 'CLAUDE.md')], {
      stdio: 'inherit',
    })
    ok('CLAUDE.md updated')
  } else {
    warn('Skipped. Edit CLAUDE.md manually before first use.')
  }

  // --- Install systemd service ---
  header('Background service')
  const installService = await ask('Install as systemd user service? [Y/n]:')

  if (installService.trim().toLowerCase() !== 'n') {
    const serviceDir = resolve(
      process.env.HOME ?? '~',
      '.config',
      'systemd',
      'user'
    )
    mkdirSync(serviceDir, { recursive: true })

    const nodePath = process.execPath
    const servicePath = resolve(serviceDir, 'personalos.service')

    const serviceContent = `[Unit]
Description=PersonalOS - Personal AI Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${resolve(PROJECT_ROOT, 'dist', 'index.js')}
WorkingDirectory=${PROJECT_ROOT}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`

    writeFileSync(servicePath, serviceContent)
    ok(`Service file written: ${servicePath}`)

    try {
      execSync('systemctl --user daemon-reload')
      execSync('systemctl --user enable personalos.service')
      ok('Service enabled (will start on login)')

      const startNow = await ask('Start service now? [Y/n]:')
      if (startNow.trim().toLowerCase() !== 'n') {
        execSync('systemctl --user start personalos.service')
        ok('Service started')
      }
    } catch (err) {
      warn(
        `Could not configure systemd: ${err instanceof Error ? err.message : String(err)}`
      )
      console.log('You can start manually with: npm run start')
    }
  }

  // --- Get chat ID ---
  header('Get your Chat ID')
  console.log(`
Now open Telegram, find your bot, and send it: /chatid

It will reply with your chat ID. Paste it here.
If the bot is running as a service, it's already listening.
Otherwise, open another terminal and run: npm run start
`)

  const chatId = await ask('Your Telegram chat ID (or press Enter to set later):')
  if (chatId.trim()) {
    config['ALLOWED_CHAT_ID'] = chatId.trim()
    const envFinal = Object.entries(config)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
    writeFileSync(envPath, envFinal + '\n')
    ok(`Chat ID saved: ${chatId.trim()}`)

    // Restart service if running
    try {
      execSync('systemctl --user restart personalos.service 2>/dev/null')
      ok('Service restarted with new config')
    } catch {
      // not running or not installed
    }
  } else {
    warn(
      'Chat ID not set. Send /chatid to your bot, then add ALLOWED_CHAT_ID to .env'
    )
  }

  // --- Done ---
  header('Setup complete')
  console.log(`
${GREEN}PersonalOS is ready.${RESET}

Next steps:
  • If you didn't install the service: ${BOLD}npm run start${RESET}
  • Check status: ${BOLD}npm run status${RESET}
  • View logs: ${BOLD}journalctl --user -u personalos -f${RESET}
  • Create a scheduled task: ${BOLD}npm run schedule -- create "prompt" "0 9 * * *" YOUR_CHAT_ID${RESET}
  • Edit your assistant personality: ${BOLD}$EDITOR CLAUDE.md${RESET}

Send a message to your bot on Telegram. Have fun.
`)

  rl.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
