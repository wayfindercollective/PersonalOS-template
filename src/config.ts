import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const env = readEnvFile()

// Paths
export const PROJECT_ROOT = resolve(__dirname, '..')
export const STORE_DIR = resolve(PROJECT_ROOT, 'store')
export const UPLOADS_DIR = resolve(PROJECT_ROOT, 'workspace', 'uploads')
export const PRESENTATIONS_DIR = resolve(PROJECT_ROOT, 'workspace', 'presentations')
/** Local static server port for open-on-any-tailnet-device HTML decks */
export const PRESENTATION_PORT = Number(env['PRESENTATION_PORT'] ?? 8787)

// Telegram
export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''

// Voice — local Whisper WebSocket
export const WHISPER_WS_URL = env['WHISPER_WS_URL'] ?? 'ws://localhost:9090'
export const WHISPER_WS_FALLBACK_URL = env['WHISPER_WS_FALLBACK_URL'] ?? ''

// Video analysis
export const GOOGLE_API_KEY = env['GOOGLE_API_KEY'] ?? ''

// WhatsApp
export const WA_ENABLED = (env['WA_ENABLED'] ?? 'false') === 'true'

// Scheduler
export const SCHEDULER_ENABLED = (env['SCHEDULER_ENABLED'] ?? 'true') === 'true'

// Limits
export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000
export const AGENT_TIMEOUT_MS = Number(env['AGENT_TIMEOUT_MS'] ?? 1800000) // 30 min default

// Discord
export const DISCORD_BOT_TOKEN = env['DISCORD_BOT_TOKEN'] ?? ''
export const DISCORD_ALLOWED_USER_IDS = (env['DISCORD_ALLOWED_USER_IDS'] ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean)

// LM Studio / LiteLLM (optional OpenAI-compatible server — any OS)
export const LMSTUDIO_URL = env['LMSTUDIO_URL'] ?? ''
export const LMSTUDIO_API_KEY = env['LMSTUDIO_API_KEY'] ?? ''
export const LMSTUDIO_MODEL = env['LMSTUDIO_MODEL'] ?? 'qwen3.5-397b-a17b'
export const LMSTUDIO_TIMEOUT_MS = Number(env['LMSTUDIO_TIMEOUT_MS'] ?? 300000)

// TTS
export const TTS_PROVIDER = env['TTS_PROVIDER'] ?? 'piper' // 'piper' or 'elevenlabs'
export const PIPER_PATH = env['PIPER_PATH'] ?? 'piper'
export const PIPER_MODEL = env['PIPER_MODEL'] ?? ''
export const ELEVENLABS_API_KEY = env['ELEVENLABS_API_KEY'] ?? ''
export const ELEVENLABS_VOICE_ID = env['ELEVENLABS_VOICE_ID'] ?? 'EXAVITQu4vr4xnSDxMaL' // Default: Sarah
