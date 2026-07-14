import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  TTS_PROVIDER,
  PIPER_PATH,
  PIPER_MODEL,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  UPLOADS_DIR
} from '../config.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'tts' })

export interface TTSResult {
  audioPath: string
  provider: 'piper' | 'elevenlabs'
}

/**
 * Sanitize text for natural-sounding speech output.
 * Strips markdown, URLs, metadata footers, and other non-speech content.
 */
export function sanitizeForSpeech(text: string): string {
  let s = text

  // Remove metadata footers like [claude-code -- 5.2s], [infinity/qwen3.5... -- confidence: 90% -- 3.1s], etc.
  s = s.replace(/\n*\[(?:Escalated|Fallback|Tools used)[^\]]*\]/gi, '')
  s = s.replace(/\n*\[[\w./:@-]+\s*--\s*[^\]]*\]/g, '')

  // Remove code blocks entirely (not useful spoken)
  s = s.replace(/```[\s\S]*?```/g, '(code block omitted)')

  // Remove inline code backticks
  s = s.replace(/`([^`]+)`/g, '$1')

  // Remove markdown headings markers
  s = s.replace(/^#{1,6}\s+/gm, '')

  // Remove bold/italic markers
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')
  s = s.replace(/__(.+?)__/g, '$1')
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
  s = s.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1')

  // Remove strikethrough
  s = s.replace(/~~(.+?)~~/g, '$1')

  // Convert markdown links [text](url) to just the text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // Remove bare URLs
  s = s.replace(/https?:\/\/\S+/g, '(link)')

  // Convert bullet points to natural speech
  s = s.replace(/^\s*[-*+]\s+\[[ x]\]\s*/gim, '') // checkboxes
  s = s.replace(/^\s*[-*+]\s+/gm, '') // bullet points
  s = s.replace(/^\s*\d+\.\s+/gm, '') // numbered lists

  // Remove horizontal rules
  s = s.replace(/^[-*_]{3,}\s*$/gm, '')

  // Remove HTML tags (from formatForTelegram if any leak through)
  s = s.replace(/<[^>]+>/g, '')

  // Collapse multiple newlines into pauses
  s = s.replace(/\n{3,}/g, '\n\n')

  // Trim whitespace
  s = s.trim()

  return s
}

/**
 * Convert text to speech using Piper (local) or ElevenLabs (API)
 * Returns path to generated WAV file
 */
export async function textToSpeech(text: string): Promise<TTSResult> {
  // Clean up text for natural speech before sending to any TTS provider
  const cleanText = sanitizeForSpeech(text)

  log.debug({ originalLen: text.length, cleanLen: cleanText.length }, 'Sanitized text for TTS')

  // Try primary provider first
  if (TTS_PROVIDER === 'piper' && PIPER_MODEL) {
    try {
      const audioPath = await piperTTS(cleanText)
      return { audioPath, provider: 'piper' }
    } catch (err) {
      log.warn({ err }, 'Piper TTS failed, falling back to ElevenLabs')
    }
  }

  // Fallback to ElevenLabs
  if (ELEVENLABS_API_KEY) {
    try {
      const audioPath = await elevenLabsTTS(cleanText)
      return { audioPath, provider: 'elevenlabs' }
    } catch (err) {
      log.error({ err }, 'ElevenLabs TTS failed')
      throw err
    }
  }

  // Try Piper even without model configured as last resort
  if (PIPER_PATH) {
    const audioPath = await piperTTS(cleanText)
    return { audioPath, provider: 'piper' }
  }

  throw new Error('No TTS provider available')
}

/**
 * Piper TTS - local neural TTS
 */
async function piperTTS(text: string): Promise<string> {
  const outputPath = resolve(UPLOADS_DIR, `tts-${randomUUID()}.wav`)

  return new Promise((resolve, reject) => {
    const args = ['--output_file', outputPath]
    if (PIPER_MODEL) {
      args.unshift('--model', PIPER_MODEL)
    }

    const proc = spawn(PIPER_PATH, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    proc.on('error', (err) => {
      reject(new Error(`Piper spawn error: ${err.message}`))
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath)
      } else {
        reject(new Error(`Piper exited with code ${code}: ${stderr}`))
      }
    })

    // Send text to stdin
    proc.stdin.write(text)
    proc.stdin.end()
  })
}

/**
 * ElevenLabs TTS - cloud API
 */
async function elevenLabsTTS(text: string): Promise<string> {
  const outputPath = resolve(UPLOADS_DIR, `tts-${randomUUID()}.mp3`)

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    }
  )

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`ElevenLabs API error: ${response.status} ${errText}`)
  }

  const audioBuffer = await response.arrayBuffer()
  await writeFile(outputPath, Buffer.from(audioBuffer))

  return outputPath
}

/**
 * Cleanup TTS audio file
 */
export async function cleanupTTSFile(audioPath: string): Promise<void> {
  try {
    await unlink(audioPath)
  } catch {
    // Ignore cleanup errors
  }
}
