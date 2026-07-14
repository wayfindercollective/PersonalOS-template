/**
 * WhatsApp Bridge Daemon
 *
 * Runs as a separate process from the main bot.
 * Communicates via SQLite tables (wa_messages, wa_outbox).
 *
 * Usage: tsx scripts/wa-daemon.ts
 *
 * First run will display a QR code in the terminal.
 * Scan it with your WhatsApp app to link this device.
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const STORE_DIR = resolve(PROJECT_ROOT, 'store')

mkdirSync(STORE_DIR, { recursive: true })

async function main() {
  // Dynamic imports since whatsapp-web.js has heavy deps
  const { default: pkg } = await import('whatsapp-web.js')
  const { Client, LocalAuth } = pkg
  const qrcode = await import('qrcode-terminal')

  // Import DB functions
  const { initDatabase, saveWaMessage, getPendingWaMessages, markWaSent } =
    await import('../src/db.js')

  initDatabase()

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: resolve(STORE_DIR, 'wa-session') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  })

  client.on('qr', (qr: string) => {
    // Print scannable URL first (always works, even if terminal QR fails)
    console.log('\n=== WhatsApp QR Code ===')
    console.log('Open this URL in a browser to see the QR code:')
    console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`)
    console.log('\nOr scan the terminal QR below:\n')
    qrcode.generate(qr, { small: true }, (qrText: string) => {
      console.log(qrText)
    })
  })

  client.on('ready', () => {
    console.log('WhatsApp client ready')

    // Poll for outgoing messages every 3 seconds
    setInterval(async () => {
      const pending = getPendingWaMessages()
      for (const msg of pending) {
        try {
          await client.sendMessage(msg.wa_chat_id, msg.message)
          markWaSent(msg.id)
          console.log(`Sent to ${msg.wa_chat_id}: ${msg.message.slice(0, 50)}`)
        } catch (err) {
          console.error(`Failed to send to ${msg.wa_chat_id}:`, err)
        }
      }
    }, 3000)
  })

  client.on('message', async (msg: { from: string; body: string; timestamp: number; getChat: () => Promise<{ name: string }> }) => {
    try {
      const chat = await msg.getChat()
      const chatName = chat.name || msg.from
      const sender = msg.from
      const content = msg.body
      const timestamp = msg.timestamp || Math.floor(Date.now() / 1000)

      saveWaMessage(msg.from, chatName, sender, content, timestamp)
      console.log(`[${chatName}] ${sender}: ${content.slice(0, 80)}`)
    } catch (err) {
      console.error('Error processing incoming WA message:', err)
    }
  })

  client.on('disconnected', (reason: string) => {
    console.log('WhatsApp disconnected:', reason)
    process.exit(1) // systemd will restart
  })

  console.log('Starting WhatsApp client...')
  await client.initialize()
}

main().catch((err) => {
  console.error('WA daemon fatal error:', err)
  process.exit(1)
})
