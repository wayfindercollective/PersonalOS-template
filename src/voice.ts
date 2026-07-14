import { readFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname, dirname, basename, join } from 'node:path'
import WebSocket from 'ws'
import { WHISPER_WS_URL, WHISPER_WS_FALLBACK_URL } from './config.js'
import { logger } from './logger.js'

function whisperRequest(audioBytes: Buffer, url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url)
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error('Whisper transcription timed out after 60s'))
      }
    }, 60_000)

    ws.on('open', () => {
      ws.send(audioBytes)
    })

    ws.on('message', (data: WebSocket.Data) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      ws.close()

      const raw = data.toString()

      try {
        const parsed = JSON.parse(raw)
        resolve(
          typeof parsed.text === 'string'
            ? parsed.text.trim()
            : typeof parsed.transcription === 'string'
              ? parsed.transcription.trim()
              : raw.trim()
        )
      } catch {
        resolve(raw.trim())
      }
    })

    ws.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(err)
      }
    })

    ws.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error('WebSocket closed before receiving transcription'))
      }
    })
  })
}

export async function transcribeAudio(filePath: string): Promise<string> {
  // Telegram sends .oga files - rename to .ogg (same format, different extension)
  let actualPath = filePath
  if (extname(filePath).toLowerCase() === '.oga') {
    actualPath = join(dirname(filePath), basename(filePath, '.oga') + '.ogg')
    renameSync(filePath, actualPath)
  }

  if (!existsSync(actualPath)) {
    throw new Error(`Audio file not found: ${actualPath}`)
  }

  // Convert to WAV (16kHz mono) - Whisper WS server needs raw WAV, not Opus/OGG
  const wavPath = actualPath.replace(/\.[^.]+$/, '.wav')
  try {
    execFileSync('ffmpeg', ['-y', '-i', actualPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath], { stdio: 'pipe' })
  } catch (err) {
    throw new Error(`ffmpeg conversion failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const audioBytes = readFileSync(wavPath)
  // Clean up temp WAV after reading
  try { unlinkSync(wavPath) } catch {}

  logger.info(
    { path: actualPath, wavBytes: audioBytes.length, server: WHISPER_WS_URL },
    'Transcribing audio via WebSocket Whisper'
  )

  const servers = [WHISPER_WS_URL, WHISPER_WS_FALLBACK_URL].filter(Boolean)

  for (const url of servers) {
    try {
      const result = await whisperRequest(audioBytes, url)
      if (result) return result
      logger.warn({ server: url }, 'Whisper returned empty text, trying next server')
    } catch (err) {
      logger.warn({ server: url, err }, 'Whisper server failed, trying next')
    }
  }

  throw new Error('All Whisper servers failed')
}

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: !!(WHISPER_WS_URL || WHISPER_WS_FALLBACK_URL),
    tts: false,
  }
}
