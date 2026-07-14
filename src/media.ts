import { writeFileSync, readFileSync, readdirSync, unlinkSync, statSync, mkdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { UPLOADS_DIR, TELEGRAM_BOT_TOKEN } from './config.js'
import { logger } from './logger.js'

mkdirSync(UPLOADS_DIR, { recursive: true })

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-')
}

// Telegram's CDN occasionally drops connections (ETIMEDOUT/ECONNRESET). One blip
// shouldn't lose a voice note — retry transient network failures and 5xx with
// exponential backoff. 4xx (except 429) is a real client error: don't retry.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  context: string,
  retries = 3
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.ok) return res
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    if (attempt < retries - 1) {
      const delayMs = 500 * 2 ** attempt
      logger.warn(
        { context, attempt: attempt + 1, retries, delayMs, err: lastErr },
        'Telegram fetch failed, retrying'
      )
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export async function downloadMedia(
  fileId: string,
  originalFilename?: string
): Promise<string> {
  // Step 1: get file path from Telegram
  const fileRes = await fetchWithRetry(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
    { signal: AbortSignal.timeout(30000) },
    'getFile'
  )
  const fileData = (await fileRes.json()) as {
    ok: boolean
    result?: { file_path: string }
  }

  if (!fileData.ok || !fileData.result?.file_path) {
    throw new Error('Failed to get file from Telegram')
  }

  // Step 2: download the file
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`
  const res = await fetchWithRetry(
    downloadUrl,
    { signal: AbortSignal.timeout(30000) },
    'downloadFile'
  )
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status}`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())

  // Step 3: save locally
  const ext = fileData.result.file_path.split('.').pop() ?? 'bin'
  const safeName = originalFilename
    ? sanitizeFilename(originalFilename)
    : `file.${ext}`
  const localPath = join(UPLOADS_DIR, `${Date.now()}_${safeName}`)

  writeFileSync(localPath, buffer)
  logger.info({ localPath, bytes: buffer.length }, 'Downloaded media')

  return localPath
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`[Photo attached: ${localPath}]`]
  if (caption) parts.push(caption)
  parts.push('Please analyze this image.')
  return parts.join('\n')
}

// Text-based extensions where we can inline the file content directly
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv',
  '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.xml', '.html', '.htm', '.css', '.js', '.ts',
  '.py', '.sh', '.bash', '.env', '.conf',
])

const MAX_INLINE_BYTES = 100_000 // ~100KB cap for inline content

// Image extensions sent as Telegram documents (e.g. macOS screenshots from
// Telegram Desktop) must route through the photo pipeline so vision
// preprocessing (Gemini) fires on the [Photo attached:] marker.
const IMAGE_DOC_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

// Video extensions sent as Telegram documents must route through the video
// pipeline so the model uses the Gemini video flow instead of trying to Read
// binary content.
const VIDEO_DOC_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv'])

export function buildDocumentMessage(
  localPath: string,
  filename: string,
  caption?: string
): string {
  // Prefer the filename's extension; fall back to localPath if the filename
  // is missing or extension-less (some clients strip the original name).
  let ext = extname(filename).toLowerCase()
  if (!ext) ext = extname(localPath).toLowerCase()

  // Images sent as documents: hand off to the photo path so vision runs.
  if (IMAGE_DOC_EXTENSIONS.has(ext)) {
    return buildPhotoMessage(localPath, caption)
  }

  // Videos sent as documents: hand off to the video path.
  if (VIDEO_DOC_EXTENSIONS.has(ext)) {
    return buildVideoMessage(localPath, caption)
  }

  // For text-based files, inline the content so the agent doesn't need to Read the file
  if (TEXT_EXTENSIONS.has(ext)) {
    try {
      const stat = statSync(localPath)
      if (stat.size <= MAX_INLINE_BYTES) {
        const content = readFileSync(localPath, 'utf-8')
        const parts = [`[Document: ${filename}]`]
        if (caption) parts.push(caption)
        parts.push(`\n--- File content of ${filename} ---\n${content}\n--- End of file ---`)
        parts.push('\nPlease review this document.')
        return parts.join('\n')
      }
      // File too large to inline -- fall through to path-based approach
      const parts = [`[Document: ${filename} at ${localPath} (${(stat.size / 1024).toFixed(0)}KB -- too large to inline)]`]
      if (caption) parts.push(caption)
      parts.push('Read this file with the Read tool and review the document.')
      return parts.join('\n')
    } catch {
      // Read failed -- fall through to path-based approach
    }
  }

  const parts = [`[Document attached: ${filename} at ${localPath}]`]
  if (caption) parts.push(caption)
  parts.push('Please review this document.')
  return parts.join('\n')
}

export function buildVideoMessage(
  localPath: string,
  caption?: string
): string {
  const parts = [
    `[Video attached: ${localPath}]`,
    caption ?? '',
    'Analyze this video using the Gemini API. The GOOGLE_API_KEY is available in this project\'s .env file. Use the gemini-api-dev skill if available, or call the Gemini API directly to analyze the video content.',
  ].filter(Boolean)
  return parts.join('\n')
}

export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const files = readdirSync(UPLOADS_DIR)
    const now = Date.now()
    let cleaned = 0

    for (const file of files) {
      const fullPath = join(UPLOADS_DIR, file)
      try {
        const stat = statSync(fullPath)
        if (!stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(fullPath)
          cleaned++
        }
      } catch {
        // ignore individual file errors
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up old uploads')
    }
  } catch {
    // uploads dir may not exist yet
  }
}
