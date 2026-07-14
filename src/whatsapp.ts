import {
  saveWaMessage,
  getUnnotifiedWaMessages,
  markWaNotified,
  getPendingWaMessages,
  markWaSent,
  queueWaMessage,
  getRecentWaChats,
  getWaChatMessages,
} from './db.js'
import { logger } from './logger.js'

type NotifyFn = (chatId: string, text: string) => Promise<void>

let notifyFn: NotifyFn | undefined
let pollInterval: ReturnType<typeof setInterval> | undefined

// WhatsApp bridge uses a separate wa-daemon process that communicates via SQLite.
// This module handles the Telegram-side integration:
// - Checking for new incoming WA messages and notifying via Telegram
// - Queuing outgoing messages for the daemon to pick up

export function initWhatsApp(notify: NotifyFn, telegramChatId: string): void {
  notifyFn = notify

  // Poll for new incoming WhatsApp messages every 5 seconds
  pollInterval = setInterval(() => {
    checkIncomingMessages(telegramChatId).catch((err) =>
      logger.error({ err }, 'WA incoming check failed')
    )
  }, 5000)

  logger.info('WhatsApp bridge initialized (polling for incoming messages)')
}

export function stopWhatsApp(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = undefined
  }
}

async function checkIncomingMessages(telegramChatId: string): Promise<void> {
  const messages = getUnnotifiedWaMessages()
  if (messages.length === 0) return

  // Group by chat
  const byChat = new Map<
    string,
    Array<{ sender: string; content: string; timestamp: number }>
  >()
  const ids: number[] = []

  for (const msg of messages) {
    const chatName = msg.wa_chat_name ?? msg.wa_chat_id
    if (!byChat.has(chatName)) byChat.set(chatName, [])
    byChat.get(chatName)!.push({
      sender: msg.sender,
      content: msg.content,
      timestamp: msg.timestamp,
    })
    ids.push(msg.id)
  }

  for (const [chatName, msgs] of byChat) {
    const lines = msgs.map((m) => {
      const time = new Date(m.timestamp * 1000).toLocaleTimeString()
      return `[${time}] ${m.sender}: ${m.content}`
    })

    const text = `[WhatsApp: ${chatName}]\n${lines.join('\n')}`

    if (notifyFn) {
      await notifyFn(telegramChatId, text)
    }
  }

  markWaNotified(ids)
}

// Functions used by bot commands

export function sendWhatsAppMessage(waChatId: string, message: string): void {
  queueWaMessage(waChatId, message)
  logger.info({ waChatId }, 'Queued WA message')
}

export function listRecentChats(): string {
  const chats = getRecentWaChats(10)
  if (chats.length === 0) return 'No WhatsApp chats found.'

  const lines = chats.map((c, i) => {
    const name = c.wa_chat_name ?? c.wa_chat_id
    const time = new Date(c.last_msg * 1000).toLocaleString()
    return `${i + 1}. ${name} (${time})`
  })

  return `Recent WhatsApp chats:\n${lines.join('\n')}`
}

export function readChat(waChatId: string): string {
  const messages = getWaChatMessages(waChatId, 20)
  if (messages.length === 0) return 'No messages in this chat.'

  const lines = messages
    .reverse()
    .map((m) => {
      const time = new Date(m.timestamp * 1000).toLocaleTimeString()
      return `[${time}] ${m.sender}: ${m.content}`
    })

  return lines.join('\n')
}
