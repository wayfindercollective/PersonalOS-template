import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  type VoiceConnection,
  type AudioPlayer
} from '@discordjs/voice'
import type { VoiceChannel, GuildMember } from 'discord.js'
import { writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

/** Optional native dep — install @discordjs/opus for Discord voice receive. */
type OpusEncoderCtor = new (rate: number, channels: number) => {
  encode(buf: Buffer): Buffer
  decode(buf: Buffer): Buffer
}
function loadOpusEncoder(): OpusEncoderCtor | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@discordjs/opus').OpusEncoder as OpusEncoderCtor
  } catch {
    return null
  }
}
const OpusEncoder = loadOpusEncoder()
import { UPLOADS_DIR, DISCORD_ALLOWED_USER_IDS } from '../config.js'
import { logger } from '../logger.js'
import { VAD } from './vad.js'
import { textToSpeech, cleanupTTSFile } from './tts.js'

const log = logger.child({ module: 'discord-voice' })

interface VoiceSession {
  connection: VoiceConnection
  player: AudioPlayer
  vad: VAD
  channelId: string
  guildId: string
  isSpeaking: boolean
  onTranscript: (userId: string, text: string) => Promise<string>
}

const sessions = new Map<string, VoiceSession>()

/**
 * Join a voice channel and start listening
 */
export async function joinChannel(
  channel: VoiceChannel,
  onTranscript: (userId: string, text: string) => Promise<string>
): Promise<void> {
  const guildId = channel.guild.id

  // Leave existing session if any
  await leaveChannel(guildId)

  // Check bot permissions
  const me = channel.guild.members.me
  if (me) {
    const perms = channel.permissionsFor(me)
    log.info({
      guildId,
      channelId: channel.id,
      channelName: channel.name,
      canConnect: perms?.has('Connect'),
      canSpeak: perms?.has('Speak'),
      canViewChannel: perms?.has('ViewChannel'),
    }, 'Joining voice channel')

    if (!perms?.has('Connect')) {
      throw new Error('Bot lacks Connect permission on this voice channel')
    }
    if (!perms?.has('Speak')) {
      throw new Error('Bot lacks Speak permission on this voice channel')
    }
  } else {
    log.info({ guildId, channelId: channel.id, channelName: channel.name }, 'Joining voice channel (could not check perms)')
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    debug: true
  })

  // Log all state changes for debugging
  connection.on('stateChange', (oldState, newState) => {
    log.info({ from: oldState.status, to: newState.status }, 'Voice connection state change')
  })

  connection.on('error', (err) => {
    log.error({ err }, 'Voice connection error')
  })

  // Debug events
  connection.on('debug' as any, (msg: string) => {
    log.debug({ msg }, 'Voice connection debug')
  })

  const player = createAudioPlayer()

  const vad = new VAD({
    threshold: 0.015,
    silenceMs: 1500,
    minSpeechMs: 500
  })

  const session: VoiceSession = {
    connection,
    player,
    vad,
    channelId: channel.id,
    guildId,
    isSpeaking: false,
    onTranscript
  }

  sessions.set(guildId, session)

  // Wait for connection to be ready
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000)
    log.info({ guildId }, 'Voice connection ready')

    // Subscribe player AFTER connection is ready
    connection.subscribe(player)
  } catch (err) {
    log.error({ err, guildId, lastStatus: connection.state.status }, 'Voice connection failed to reach Ready state')
    connection.destroy()
    sessions.delete(guildId)
    throw new Error(`Voice connection stuck in "${connection.state?.status || 'unknown'}" state. Check bot permissions in Discord server settings.`)
  }

  // Start VAD
  vad.start()

  // Handle speech detection
  vad.on('speechEnd', async (audioBuffer) => {
    if (session.isSpeaking) {
      log.debug('Ignoring speech while bot is speaking')
      return
    }

    try {
      // We get raw PCM from the receiver, need to save and transcribe
      const wavPath = await saveAudioToWav(audioBuffer)
      log.info({ wavPath, bytes: audioBuffer.length }, 'Processing speech')

      // Transcribe
      const { transcribeAudio } = await import('../voice.js')
      const transcript = await transcribeAudio(wavPath)

      if (!transcript || transcript.length < 2) {
        log.debug('Empty or too short transcript, ignoring')
        await unlink(wavPath).catch(() => {})
        return
      }

      log.info({ transcript }, 'Got transcript')

      // Get response from handler
      // TODO: We don't have user ID from VAD - need to track per-user streams
      const response = await session.onTranscript('unknown', transcript)

      // Speak response
      await speak(guildId, response)

      // Cleanup
      await unlink(wavPath).catch(() => {})
    } catch (err) {
      log.error({ err }, 'Error processing speech')
    }
  })

  // Set up audio receiving
  setupAudioReceiver(session)

  // Handle disconnection
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Try to reconnect
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ])
    } catch {
      // Couldn't reconnect, cleanup
      log.info({ guildId }, 'Voice connection disconnected')
      vad.stop()
      connection.destroy()
      sessions.delete(guildId)
    }
  })

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    log.info({ guildId }, 'Voice connection destroyed')
    vad.stop()
    sessions.delete(guildId)
  })
}

/**
 * Leave voice channel
 */
export async function leaveChannel(guildId: string): Promise<void> {
  const session = sessions.get(guildId)
  if (!session) return

  log.info({ guildId }, 'Leaving voice channel')
  session.vad.stop()
  session.connection.destroy()
  sessions.delete(guildId)
}

/**
 * Speak text in voice channel
 */
export async function speak(guildId: string, text: string): Promise<void> {
  const session = sessions.get(guildId)
  if (!session) {
    throw new Error('Not in a voice channel')
  }

  log.info({ guildId, textLength: text.length }, 'Speaking')
  session.isSpeaking = true

  try {
    // Generate TTS
    const { audioPath, provider } = await textToSpeech(text)
    log.debug({ audioPath, provider }, 'TTS generated')

    // Play audio
    const resource = createAudioResource(audioPath)
    session.player.play(resource)

    // Wait for playback to finish
    await new Promise<void>((resolve) => {
      session.player.once(AudioPlayerStatus.Idle, () => {
        resolve()
      })
    })

    // Cleanup
    await cleanupTTSFile(audioPath)
  } finally {
    session.isSpeaking = false
  }
}

/**
 * Set up audio receiving from voice channel
 */
function setupAudioReceiver(session: VoiceSession): void {
  const { connection, vad } = session

  // Catch DAVE decryption errors at the receiver level so they don't crash the process
  ;(connection.receiver as any).on?.('error', (err: Error) => {
    log.debug({ err: err.message }, 'Voice receiver error (DAVE)')
  })

  // Listen to all users
  connection.receiver.speaking.on('start', (userId) => {
    if (!isUserAllowed(userId)) return
    if (session.isSpeaking) return // Don't listen while bot speaks

    log.debug({ userId }, 'User started speaking')

    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000
      }
    })

    // Handle DAVE decryption errors (known bug in @discordjs/voice 0.19.0)
    // Without this handler, the 'error' event crashes the process
    opusStream.on('error', (err) => {
      const msg = err.message ?? ''
      if (msg.includes('decrypt') || msg.includes('DAVE')) {
        log.debug({ userId }, 'DAVE decryption error (voice receiving broken in @discordjs/voice 0.19.0)')
      } else {
        log.warn({ err, userId }, 'Audio receive stream error')
      }
    })

    // Decode opus to PCM (requires optional @discordjs/opus)
    if (!OpusEncoder) {
      log.warn('Discord voice receive needs optional dependency @discordjs/opus (and build tools or a prebuild)')
      return
    }
    const decoder = new OpusEncoder(48000, 2)

    opusStream.on('data', (chunk: Buffer) => {
      try {
        const pcm = decoder.decode(chunk)
        vad.processAudio(pcm)
      } catch (err) {
        // Decoding errors can happen, ignore
      }
    })

    opusStream.on('end', () => {
      log.debug({ userId }, 'User stopped speaking')
    })
  })
}

/**
 * Check if user is allowed to interact with bot
 */
function isUserAllowed(userId: string): boolean {
  // Fail closed: empty allowlist means deny everyone
  if (DISCORD_ALLOWED_USER_IDS.length === 0) return false
  return DISCORD_ALLOWED_USER_IDS.includes(userId)
}

/**
 * Save raw PCM audio to WAV file
 */
async function saveAudioToWav(pcmBuffer: Buffer): Promise<string> {
  const wavPath = resolve(UPLOADS_DIR, `discord-${randomUUID()}.wav`)

  // Create WAV header for 48kHz, 16-bit, stereo PCM
  const header = createWavHeader(pcmBuffer.length, 48000, 16, 2)
  const wavBuffer = Buffer.concat([header, pcmBuffer])

  await writeFile(wavPath, wavBuffer)
  return wavPath
}

/**
 * Create WAV file header
 */
function createWavHeader(
  dataSize: number,
  sampleRate: number,
  bitsPerSample: number,
  channels: number
): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8

  // RIFF header
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)

  // fmt chunk
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // Chunk size
  header.writeUInt16LE(1, 20) // Audio format (PCM)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)

  // data chunk
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return header
}

/**
 * Check if bot is in a voice channel
 */
export function isInVoiceChannel(guildId: string): boolean {
  return sessions.has(guildId)
}

/**
 * Get current session info
 */
export function getSession(guildId: string): VoiceSession | undefined {
  return sessions.get(guildId)
}
