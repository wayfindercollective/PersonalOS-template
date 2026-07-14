import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  AttachmentBuilder,
  type VoiceChannel,
  type Message,
  type Attachment
} from 'discord.js'
import { existsSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { DISCORD_BOT_TOKEN, DISCORD_ALLOWED_USER_IDS, UPLOADS_DIR } from '../config.js'
import { logger } from '../logger.js'
import { runAgent } from '../agent.js'
import { buildMemoryContext, saveConversationTurn } from '../memory.js'
import { joinChannel, leaveChannel, isInVoiceChannel, speak } from './voice.js'

const log = logger.child({ module: 'discord' })

let client: Client | null = null

// Session storage per guild
const sessions = new Map<string, { sessionId?: string }>()

/**
 * Extract file paths from response and send as Discord attachments
 */
async function extractAndSendFiles(message: Message, response: string): Promise<void> {
  const pathRegex = /(?:^|\s|`)(\/[\w./-]+\.(?:pdf|png|jpg|jpeg|gif|csv|xlsx|docx|zip|txt|json|mp3|mp4))\b/gi
  const workspaceRegex = /(?:^|\s|`)(workspace\/[\w./-]+\.(?:pdf|png|jpg|jpeg|gif|csv|xlsx|docx|zip|txt|json|mp3|mp4))\b/gi

  const filePaths = new Set<string>()

  let match
  while ((match = pathRegex.exec(response)) !== null) {
    filePaths.add(match[1])
  }
  while ((match = workspaceRegex.exec(response)) !== null) {
    filePaths.add(`./${match[1]}`)
  }

  for (const filePath of filePaths) {
    if (existsSync(filePath)) {
      try {
        const attachment = new AttachmentBuilder(filePath, { name: basename(filePath) })
        await message.reply({ files: [attachment] })
        log.info({ filePath }, 'Sent file to Discord')
      } catch (err) {
        log.error({ err, filePath }, 'Failed to send file to Discord')
      }
    }
  }
}

/**
 * Initialize Discord bot
 */
export async function initDiscord(): Promise<void> {
  if (!DISCORD_BOT_TOKEN) {
    log.info('DISCORD_BOT_TOKEN not set, skipping Discord init')
    return
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates
    ]
  })

  client.once(Events.ClientReady, (c) => {
    log.info({ user: c.user.tag }, 'Discord bot ready')
  })

  client.on(Events.MessageCreate, handleMessage)
  client.on(Events.InteractionCreate, handleInteraction)

  await client.login(DISCORD_BOT_TOKEN)
}

async function handleInteraction(interaction: import('discord.js').Interaction): Promise<void> {
  if (!interaction.isButton()) return
  const id = interaction.customId
  const match = id.match(/^web_(approve|deny|cancel):([^:]+):(.+)$/)
  if (!match) return
  if (!isUserAllowed(interaction.user.id)) {
    await interaction.reply({ content: 'not authorised', ephemeral: true })
    return
  }
  const decision = match[1] as 'approve' | 'deny' | 'cancel'
  const jobId = match[2]!
  const approvalId = match[3]!
  const { decideWebApproval } = await import('../web-agent.js')
  try {
    await decideWebApproval(jobId, approvalId, decision)
    await interaction.update({
      content: `${interaction.message.content}\n\n→ ${decision}d by ${interaction.user.username}`,
      components: [],
    })
  } catch (err) {
    await interaction.reply({ content: `error: ${(err as Error).message.slice(0, 200)}`, ephemeral: true })
  }
}

/**
 * Shutdown Discord bot
 */
export async function shutdownDiscord(): Promise<void> {
  if (client) {
    log.info('Shutting down Discord bot')
    client.destroy()
    client = null
  }
}

/**
 * Handle incoming messages
 */
async function handleMessage(message: Message): Promise<void> {
  // Ignore bots
  if (message.author.bot) return

  // Check user allowed
  if (!isUserAllowed(message.author.id)) return

  const content = message.content.trim()

  // Voice commands
  if (content === '!join' || content === '/join') {
    await handleJoinCommand(message)
    return
  }

  if (content === '!leave' || content === '/leave') {
    await handleLeaveCommand(message)
    return
  }

  if (content.startsWith('!say ') || content.startsWith('/say ')) {
    await handleSayCommand(message, content.slice(5).trim())
    return
  }

  if (content.startsWith('!web ') || content.startsWith('/web ')) {
    await handleWebCommand(message, content.slice(5).trim())
    return
  }

  if (content.startsWith('!codex ') || content.startsWith('/codex ')) {
    await handleCodexCommand(message, content.slice(7).trim())
    return
  }
  if (content === '!codex' || content === '/codex') {
    await handleCodexCommand(message, '')
    return
  }

  // Text chat with Claude (all messages from allowed users)
  await handleChatMessage(message)
}

async function handleCodexCommand(message: Message, input: string): Promise<void> {
  if (!input) {
    await message.reply('Usage: !codex <plan, diff, or code to review>')
    return
  }
  const ch = message.channel
  if (!('send' in ch)) return
  const sendable = ch as { send: (payload: unknown) => Promise<unknown> }
  await message.reply('🔍 Reviewing (~30-90s, Qwen 397B)...')
  const { reviewWithCodex } = await import('../codex.js')
  const result = await reviewWithCodex(input)
  if (!result.ok) {
    await sendable.send(`Codex review failed: ${result.error}`)
    return
  }
  const icon = result.verdict === 'APPROVED' ? '✅' : result.verdict === 'REVISE' ? '⚠️' : '❓'
  const header = `${icon} **Codex review** (${result.model}, ${Math.round(result.durationMs / 1000)}s) — VERDICT: ${result.verdict}\n\n`
  const body = header + result.body
  for (let i = 0; i < body.length; i += 1900) {
    try { await sendable.send(body.slice(i, i + 1900)) } catch { /* ignore */ }
  }
}

async function handleWebCommand(message: Message, task: string): Promise<void> {
  if (!task) {
    await message.reply('Usage: !web <natural-language task>')
    return
  }
  const ch = message.channel
  if (!('send' in ch)) {
    await message.reply('web-agent: this channel type is not supported')
    return
  }
  const sendable = ch as { send: (payload: unknown) => Promise<unknown> }
  const discord = await import('discord.js')
  const { createWebTask, pollWebTask } = await import('../web-agent.js')

  let jobId: string
  try {
    jobId = await createWebTask(task, { kind: 'discord', channel: message.channel.id, user_id: message.author.id })
  } catch (err) {
    await message.reply(`web-agent dispatch failed: ${(err as Error).message}`)
    return
  }
  await message.reply(`🕸️ web-agent started (job ${jobId})`)

  void pollWebTask(jobId, {
    onText: async (line) => {
      try { await sendable.send(line.slice(0, 1900)) } catch { /* ignore */ }
    },
    onApproval: async (approvalId, intent, _screenshotPath, url) => {
      const row = new discord.ActionRowBuilder<import('discord.js').ButtonBuilder>().addComponents(
        new discord.ButtonBuilder().setCustomId(`web_approve:${jobId}:${approvalId}`).setLabel('Approve').setStyle(discord.ButtonStyle.Success),
        new discord.ButtonBuilder().setCustomId(`web_deny:${jobId}:${approvalId}`).setLabel('Deny').setStyle(discord.ButtonStyle.Danger),
        new discord.ButtonBuilder().setCustomId(`web_cancel:${jobId}:${approvalId}`).setLabel('Cancel').setStyle(discord.ButtonStyle.Secondary),
      )
      try {
        await sendable.send({
          content: `⚠️ Approval required\nIntent: ${intent.slice(0, 200)}\nURL: ${url ?? '?'}`,
          components: [row],
        })
      } catch { /* ignore */ }
    },
    onDone: async (status, result) => {
      const icon = status === 'completed' ? '✅' : status === 'cancelled' ? '🛑' : '❌'
      const body = result ? `\n${result.slice(0, 1500)}` : ''
      try { await sendable.send(`${icon} web-agent ${status}${body}`) } catch { /* ignore */ }
    },
  }).catch(async (err) => {
    try { await sendable.send(`(poll error: ${(err as Error).message})`) } catch { /* ignore */ }
  })
}

/**
 * Handle !join command
 */
async function handleJoinCommand(message: Message): Promise<void> {
  const member = message.member
  if (!member?.voice.channel) {
    await message.reply('Join a voice channel first.')
    return
  }

  const voiceChannel = member.voice.channel as VoiceChannel
  if (voiceChannel.type !== ChannelType.GuildVoice) {
    await message.reply('I can only join regular voice channels.')
    return
  }

  try {
    await message.reply(`Joining ${voiceChannel.name}...`)

    await joinChannel(voiceChannel, async (userId, text) => {
      return await processVoiceInput(message.guildId!, text)
    })

    if ('send' in message.channel) {
      await message.channel.send('Connected. Listening.')
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log.error({ err }, 'Failed to join voice channel')
    await message.reply(`Failed to join voice channel: ${errMsg}`)
  }
}

/**
 * Handle !leave command
 */
async function handleLeaveCommand(message: Message): Promise<void> {
  if (!message.guildId || !isInVoiceChannel(message.guildId)) {
    await message.reply('Not in a voice channel.')
    return
  }

  await leaveChannel(message.guildId)
  await message.reply('Left voice channel.')
}

/**
 * Handle !say command (TTS test)
 */
async function handleSayCommand(message: Message, text: string): Promise<void> {
  if (!text) {
    await message.reply('Usage: !say <text>')
    return
  }

  if (!message.guildId || !isInVoiceChannel(message.guildId)) {
    await message.reply('Not in a voice channel. Use !join first.')
    return
  }

  try {
    await speak(message.guildId, text)
  } catch (err) {
    log.error({ err }, 'TTS failed')
    await message.reply('TTS failed.')
  }
}

// Text-based extensions where we can inline the file content directly
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv',
  '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.xml', '.html', '.htm', '.css', '.js', '.ts',
  '.py', '.sh', '.bash', '.env', '.conf',
])

const MAX_INLINE_BYTES = 100_000

/**
 * Download a Discord attachment and return the local path
 */
async function downloadAttachment(attachment: Attachment): Promise<string> {
  mkdirSync(UPLOADS_DIR, { recursive: true })
  const safeName = (attachment.name ?? 'file').replace(/[^a-zA-Z0-9._-]/g, '-')
  const localPath = join(UPLOADS_DIR, `${Date.now()}_${safeName}`)

  const res = await fetch(attachment.url)
  if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  writeFileSync(localPath, buffer)

  log.info({ localPath, bytes: buffer.length, name: attachment.name }, 'Downloaded Discord attachment')
  return localPath
}

/**
 * Build a message string for an attachment, inlining text content when possible
 */
function buildAttachmentMessage(localPath: string, filename: string): string {
  const ext = extname(filename).toLowerCase()

  if (TEXT_EXTENSIONS.has(ext)) {
    try {
      const stat = statSync(localPath)
      if (stat.size <= MAX_INLINE_BYTES) {
        const content = readFileSync(localPath, 'utf-8')
        return `[Document: ${filename}]\n\n--- File content of ${filename} ---\n${content}\n--- End of file ---\n\nPlease review this document.`
      }
      return `[Document: ${filename} at ${localPath} (${(stat.size / 1024).toFixed(0)}KB -- too large to inline)]\nRead this file with the Read tool and review the document.`
    } catch {
      // fall through
    }
  }

  return `[Document attached: ${filename} at ${localPath}]\nPlease review this document.`
}

/**
 * Handle text chat messages
 */
async function handleChatMessage(message: Message): Promise<void> {
  const chatId = `discord-${message.guildId || message.author.id}`

  // Remove bot mention from message
  let userText = message.content
    .replace(/<@!?\d+>/g, '')
    .trim()

  // Process attachments
  const attachmentParts: string[] = []
  if (message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      try {
        const localPath = await downloadAttachment(attachment)
        attachmentParts.push(buildAttachmentMessage(localPath, attachment.name ?? 'file'))
      } catch (err) {
        log.error({ err, name: attachment.name }, 'Failed to download Discord attachment')
      }
    }
  }

  // Combine text + attachment content
  if (attachmentParts.length > 0) {
    userText = [userText, ...attachmentParts].filter(Boolean).join('\n\n')
  }

  if (!userText) return

  try {
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping()
    }

    const response = await processTextInput(chatId, userText)

    if (response) {
      // Send any files referenced in the response
      await extractAndSendFiles(message, response)

      // Split long messages
      const chunks = splitMessage(response, 2000)
      for (const chunk of chunks) {
        await message.reply(chunk)
      }

      // Save conversation
      await saveConversationTurn(chatId, userText, response)
    }
  } catch (err) {
    log.error({ err }, 'Chat message handling failed')
    await message.reply('Something went wrong.')
  }
}

/**
 * Process voice input and return response
 */
async function processVoiceInput(guildId: string, text: string): Promise<string> {
  const chatId = `discord-${guildId}`
  log.info({ chatId, text }, 'Processing voice input')

  const response = await processTextInput(chatId, `[Voice transcribed]: ${text}`)

  // Save conversation
  if (response) {
    await saveConversationTurn(chatId, text, response)
  }

  return response || "I couldn't process that."
}

/**
 * Process text input through Claude
 */
async function processTextInput(chatId: string, text: string): Promise<string | null> {
  const startTime = Date.now()

  // Get memory context
  const memoryContext = await buildMemoryContext(chatId, text)
  const fullMessage = memoryContext ? `${memoryContext}\n${text}` : text

  // Get or create session
  let session = sessions.get(chatId)
  if (!session) {
    session = {}
    sessions.set(chatId, session)
  }

  // Run agent
  const { text: response, newSessionId } = await runAgent(
    fullMessage,
    session.sessionId
  )

  if (newSessionId) {
    session.sessionId = newSessionId
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  return response ? `${response}\n\n[claude-code -- ${elapsed}s]` : response
}

/**
 * Check if user is allowed
 */
function isUserAllowed(userId: string): boolean {
  // Fail closed: empty allowlist means deny everyone (set DISCORD_ALLOWED_USER_IDS in .env)
  if (DISCORD_ALLOWED_USER_IDS.length === 0) return false
  return DISCORD_ALLOWED_USER_IDS.includes(userId)
}

/**
 * Split long message into chunks
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    // Find last newline or space within limit
    let splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

/**
 * Get Discord client
 */
export function getClient(): Client | null {
  return client
}
