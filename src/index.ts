import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { resolve } from 'node:path'
import {
  STORE_DIR,
  UPLOADS_DIR,
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  SCHEDULER_ENABLED,
  WA_ENABLED,
  DISCORD_BOT_TOKEN,
  LMSTUDIO_URL,
  LMSTUDIO_API_KEY,
} from './config.js'
import { initDatabase } from './db.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads } from './media.js'
import { createBot, getBotSendFn, pushSharedTurn } from './bot.js'
import { initScheduler, stopScheduler } from './scheduler.js'
import { initWhatsApp, stopWhatsApp } from './whatsapp.js'
import { initDiscord, shutdownDiscord } from './discord/index.js'
import { initLMStudioHistory } from './lmstudio.js'
import { initBrowser, closeBrowser } from './browser.js'
import { startPresentationServer } from './presentations.js'
import { logger } from './logger.js'

const PID_FILE = resolve(STORE_DIR, 'personalos.pid')

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
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
`

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true })

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (oldPid && !isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0) // check if alive
        logger.info({ oldPid }, 'Killing stale instance')
        process.kill(oldPid, 'SIGTERM')
      } catch {
        // process doesn't exist, stale PID file
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid))
}

function releaseLock(): void {
  try {
    unlinkSync(PID_FILE)
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  console.log(BANNER)

  // Validate config
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error(
      'TELEGRAM_BOT_TOKEN is not set. Run `npm run setup` or add it to .env'
    )
    process.exit(1)
  }

  // Warn if LM Studio config looks wrong
  if (!LMSTUDIO_URL) {
    logger.warn({ url: LMSTUDIO_URL }, 'LMSTUDIO_URL looks local-only or unset — set it to your LM Studio / LiteLLM base URL if you use /model lmstudio')
  }
  if (!LMSTUDIO_API_KEY || !LMSTUDIO_API_KEY.startsWith('sk-litellm-')) {
    logger.warn('LMSTUDIO_API_KEY missing or not a LiteLLM key -- check .env')
  }

  // Acquire lock
  acquireLock()

  // Init database
  initDatabase()

  // Restore LM Studio chat history from DB
  initLMStudioHistory()

  // Init browser engine (persistent Playwright sessions)
  await initBrowser()

  // Memory decay sweep (run now + daily)
  runDecaySweep()
  const decayInterval = setInterval(runDecaySweep, 24 * 60 * 60 * 1000)

  // Cleanup old uploads
  mkdirSync(UPLOADS_DIR, { recursive: true })
  cleanupOldUploads()

  // Serve HTML decks on :8787 so Tailscale devices can open them by URL
  // (also hosts /oauth/google/callback for Telegram Gmail re-auth)
  startPresentationServer()

  // Create bot
  const bot = createBot()
  const sendFn = getBotSendFn(bot)

  // Keep Google access tokens fresh in the background. Does NOT Telegram-ping
  // for re-auth (that was spamming). User runs /gmailauth when they want a link.
  // Opt-in only: GOOGLE_REAUTH_AUTO_NOTIFY=1 for a single disk-backed notice.
  const { startGoogleTokenKeeper } = await import('./google.js')
  const googleKeeper = startGoogleTokenKeeper(
    async (msg) => {
      if (ALLOWED_CHAT_ID) await sendFn(ALLOWED_CHAT_ID, msg)
    },
    { chatId: ALLOWED_CHAT_ID || undefined }
  )

  // Init scheduler
  if (SCHEDULER_ENABLED) {
    initScheduler(sendFn, pushSharedTurn)
  }

  // Init WhatsApp bridge
  if (WA_ENABLED && ALLOWED_CHAT_ID) {
    initWhatsApp(sendFn, ALLOWED_CHAT_ID)
  }

  // Init Discord bot
  if (DISCORD_BOT_TOKEN) {
    await initDiscord()
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    clearInterval(decayInterval)
    clearInterval(googleKeeper)
    stopScheduler()
    stopWhatsApp()
    await shutdownDiscord()
    await closeBrowser()
    bot.stop()
    releaseLock()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Start bot
  try {
    await bot.start({
      onStart: () => {
        logger.info('PersonalOS running')
        if (!ALLOWED_CHAT_ID) {
          logger.error(
            'SECURITY: ALLOWED_CHAT_ID is not set — the bot will accept messages from ANY Telegram user with full tool access. Send /chatid, set ALLOWED_CHAT_ID in .env, and restart.'
          )
        }
      },
    })
  } catch (err) {
    logger.error({ err }, 'Failed to start bot. Check TELEGRAM_BOT_TOKEN in .env')
    releaseLock()
    process.exit(1)
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error')
  releaseLock()
  process.exit(1)
})
