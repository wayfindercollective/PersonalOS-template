/**
 * Text-to-speech for Telegram voice replies.
 *
 * Backend: flite on this machine (installed at /usr/bin/flite, CMU's CPU-only
 * synthesizer — fast, decent quality). Output is piped through ffmpeg to
 * OGG/Opus so Telegram renders it as a real "voice message" pill rather
 * than an attachment.
 *
 * Falls back to espeak-ng if flite isn't available.
 *
 * Returns the path to a .ogg file the caller should sendVoice() with then delete.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logger } from './logger.js'

const TTS_DIR = join(tmpdir(), 'personalos-tts')
mkdirSync(TTS_DIR, { recursive: true })

// Cap TTS input — long monologues are slow to synth and annoying to listen to.
const MAX_TTS_CHARS = 1500

function which(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const FLITE_AVAILABLE = which('flite')
const ESPEAK_AVAILABLE = which('espeak-ng')
const FFMPEG_AVAILABLE = which('ffmpeg')

export function ttsAvailable(): boolean {
  return (FLITE_AVAILABLE || ESPEAK_AVAILABLE) && FFMPEG_AVAILABLE
}

/**
 * Strip footer lines, code fences, and obvious URLs that don't synth well.
 * Keep the cleaning conservative — we want the reply to sound like the reply.
 */
function cleanForTTS(text: string): string {
  return text
    // Strip trailing footer like [opus -- 3.2s]
    .replace(/\n\n\[[^\]]*\]\s*$/g, '')
    // Replace bare URLs with "link"
    .replace(/https?:\/\/\S+/g, 'link')
    // Drop markdown emphasis chars
    .replace(/[*_`~]+/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Synthesize `text` to an .ogg (OPUS) suitable for Telegram sendVoice().
 * Returns the path on success, null on failure. Caller is responsible for
 * cleanup (delete after send).
 */
export async function synthesizeVoice(text: string): Promise<string | null> {
  if (!FFMPEG_AVAILABLE) {
    logger.warn('[TTS] ffmpeg not available — cannot encode voice')
    return null
  }
  if (!FLITE_AVAILABLE && !ESPEAK_AVAILABLE) {
    logger.warn('[TTS] no synthesizer (flite/espeak-ng) available')
    return null
  }

  const cleaned = cleanForTTS(text)
  if (!cleaned) return null
  const truncated = cleaned.length > MAX_TTS_CHARS
    ? cleaned.slice(0, MAX_TTS_CHARS - 50) + '... (message truncated for voice)'
    : cleaned

  const stamp = Date.now() + '_' + Math.floor(Math.random() * 1e6)
  const wavPath = join(TTS_DIR, `tts-${stamp}.wav`)
  const oggPath = join(TTS_DIR, `tts-${stamp}.ogg`)
  const start = Date.now()

  try {
    // Step 1: text -> wav. flite preferred (more natural cadence).
    // We pass text via stdin to avoid shell-escape issues.
    if (FLITE_AVAILABLE) {
      // flite -voice slt is the female voice; -voice rms is male. slt is
      // generally clearer over phone speakers.
      execSync(`flite -voice slt -t "$(cat)" -o ${JSON.stringify(wavPath)}`, {
        input: truncated,
        timeout: 30_000,
        stdio: ['pipe', 'ignore', 'pipe'],
      })
    } else {
      execSync(`espeak-ng -v en-us -s 165 -w ${JSON.stringify(wavPath)} --stdin`, {
        input: truncated,
        timeout: 30_000,
        stdio: ['pipe', 'ignore', 'pipe'],
      })
    }

    if (!existsSync(wavPath) || statSync(wavPath).size < 100) {
      logger.warn({ wavPath }, '[TTS] empty wav after synth')
      return null
    }

    // Step 2: wav -> ogg/opus for Telegram voice format.
    execSync(
      `ffmpeg -y -i ${JSON.stringify(wavPath)} -c:a libopus -b:a 32k -ar 24000 -application voip ${JSON.stringify(oggPath)} -loglevel error`,
      { timeout: 30_000, stdio: ['ignore', 'ignore', 'pipe'] }
    )

    // Cleanup wav, keep ogg
    try { unlinkSync(wavPath) } catch { /* ignore */ }

    if (!existsSync(oggPath)) {
      logger.warn({ oggPath }, '[TTS] ffmpeg produced no output')
      return null
    }
    logger.info({ ms: Date.now() - start, chars: truncated.length, backend: FLITE_AVAILABLE ? 'flite' : 'espeak-ng' }, '[TTS] synthesized')
    return oggPath
  } catch (err) {
    logger.warn({ err }, '[TTS] synth failed')
    try { unlinkSync(wavPath) } catch { /* ignore */ }
    try { unlinkSync(oggPath) } catch { /* ignore */ }
    return null
  }
}

export function cleanupTtsFile(path: string): void {
  try { unlinkSync(path) } catch { /* ignore */ }
}
