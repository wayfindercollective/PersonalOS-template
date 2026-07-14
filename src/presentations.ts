/**
 * Local presentation HTTP server (optional).
 *
 * Serves HTML decks from workspace/presentations on PRESENTATION_PORT (default 8787).
 * Optional: set PRESENTATION_FUNNEL_HOST or use Tailscale Funnel/Serve to expose them.
 * Without Tailscale, open http://127.0.0.1:8787/presentations/ on this machine.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs'
import { extname, basename, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { PROJECT_ROOT, PRESENTATION_PORT } from './config.js'
import { logger } from './logger.js'

export const PRESENTATIONS_DIR = resolve(PROJECT_ROOT, 'workspace', 'presentations')
const PORT = PRESENTATION_PORT
const UPSTREAM = process.env.PRESENTATION_UPSTREAM ?? 'http://127.0.0.1:9093'
const FUNNEL_HOST =
  process.env.PRESENTATION_FUNNEL_HOST ??
  (() => {
    try {
      const name = execSync('tailscale status --json', { encoding: 'utf-8', timeout: 3000 })
      const dns = (JSON.parse(name) as { Self?: { DNSName?: string } }).Self?.DNSName
      return dns ? dns.replace(/\.$/, '') : 'your-host.tailnet.ts.net'
    } catch {
      return 'your-host.tailnet.ts.net'
    }
  })()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function getTailscaleIp(): string | null {
  try {
    const ip = execSync('tailscale ip -4', { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0]
    if (/^100\.\d+\.\d+\.\d+$/.test(ip)) return ip
  } catch {
    /* ignore */
  }
  return null
}

function safeJoin(root: string, reqPath: string): string | null {
  const cleaned = decodeURIComponent(reqPath.split('?')[0] ?? '').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..')) return null
  const full = resolve(root, cleaned)
  if (!full.startsWith(root)) return null
  return full
}

function indexHtml(files: string[]): string {
  const links = files
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => `<li><a href="/presentations/${encodeURIComponent(f)}">${f}</a></li>`)
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PersonalOS Presentations</title>
<style>body{font-family:system-ui;background:#0b1220;color:#e8eefc;padding:2rem;line-height:1.5}
a{color:#5b8cff} h1{margin-bottom:1rem} li{margin:.4rem 0}</style>
</head><body><h1>PersonalOS Presentations</h1>
<p>Tap a deck. Arrows / space to advance.</p>
<ul>${links || '<li>(no decks yet)</li>'}</ul>
</body></html>`
}

function servePresentation(reqPath: string, res: ServerResponse): void {
  // /presentations or /presentations/
  if (reqPath === '/presentations' || reqPath === '/presentations/') {
    const files = existsSync(PRESENTATIONS_DIR) ? readdirSync(PRESENTATIONS_DIR) : []
    const body = indexHtml(files)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(body)
    return
  }

  // /presentations/foo.html
  const rel = reqPath.replace(/^\/presentations\/?/, '')
  const full = safeJoin(PRESENTATIONS_DIR, rel)
  if (!full || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Presentation not found')
    return
  }

  const ext = extname(full).toLowerCase()
  const type = MIME[ext] ?? 'application/octet-stream'
  try {
    const data = readFileSync(full)
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      // Full control of headers — browsers render the deck, not raw source
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(data)
  } catch (err) {
    logger.warn({ err, full }, 'presentation serve failed')
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Error')
  }
}

function proxyUpstream(req: IncomingMessage, res: ServerResponse): void {
  const target = new URL(req.url ?? '/', UPSTREAM)
  const headers = { ...req.headers, host: target.host }

  const preq = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (pres) => {
      res.writeHead(pres.statusCode ?? 502, pres.headers)
      pres.pipe(res)
    }
  )
  preq.on('error', (err) => {
    logger.warn({ err }, 'presentation upstream proxy failed')
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end('Upstream unavailable')
    }
  })
  req.pipe(preq)
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/'
  const pathOnly = url.split('?')[0] ?? '/'

  if (pathOnly === '/presentations' || pathOnly.startsWith('/presentations/')) {
    servePresentation(pathOnly, res)
    return
  }

  // Short start link → 302 to full Google OAuth URL (Telegram-safe)
  // e.g. /oauth/google/start/abc123
  const startMatch = pathOnly.match(/^\/oauth\/google\/start\/([A-Za-z0-9_-]+)\/?$/)
  if (startMatch) {
    void handleGoogleOAuthStart(startMatch[1], res)
    return
  }

  // Google OAuth callback (Telegram /gmailauth) — Funnel-public
  if (pathOnly === '/oauth/google/callback' || pathOnly === '/oauth/google/callback/') {
    void handleGoogleOAuthCallback(req, res)
    return
  }

  // Keep Whisper / transcription API working through the same Funnel host
  proxyUpstream(req, res)
}

async function handleGoogleOAuthStart(ticket: string, res: ServerResponse): Promise<void> {
  try {
    const { takeGoogleStartTicket, googleOAuthResultHtml } = await import('./google.js')
    const googleUrl = takeGoogleStartTicket(ticket)
    if (!googleUrl) {
      res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        googleOAuthResultHtml(
          false,
          'This sign-in link expired or was already used. Send /gmailauth personal in Telegram for a new one.'
        )
      )
      return
    }
    res.writeHead(302, {
      Location: googleUrl,
      'Cache-Control': 'no-store',
    })
    res.end()
  } catch (err) {
    logger.warn({ err }, 'Google OAuth start redirect failed')
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('OAuth start error')
  }
}

async function handleGoogleOAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const {
      completeGoogleAuthWithCode,
      googleOAuthResultHtml,
      peekPendingGoogleAuth,
    } = await import('./google.js')
    const full = new URL(req.url ?? '/', 'http://localhost')
    const code = full.searchParams.get('code')
    const state = full.searchParams.get('state') ?? undefined
    const err = full.searchParams.get('error')
    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(googleOAuthResultHtml(false, `Google returned error: ${err}`))
      return
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(googleOAuthResultHtml(false, 'Missing authorization code.'))
      return
    }
    // Capture pending chat before complete() clears state
    const pending = state ? peekPendingGoogleAuth(state) : undefined
    const result = await completeGoogleAuthWithCode(code, state)
    if (!result.ok) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(googleOAuthResultHtml(false, result.error))
      return
    }
    const notifyChat = result.chatId || pending?.chatId
    if (notifyChat) {
      try {
        const { notifyGoogleAuthSuccess } = await import('./bot.js')
        await notifyGoogleAuthSuccess(notifyChat, result.account)
      } catch (e) {
        logger.warn({ err: e }, 'Could not notify Telegram of Google auth success')
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      googleOAuthResultHtml(
        true,
        `Account "${result.account}" is connected. PersonalOS will keep the access token refreshed automatically.`
      )
    )
  } catch (err) {
    logger.warn({ err }, 'Google OAuth callback failed')
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('OAuth callback error')
  }
}

/** Public HTTPS base (Funnel). */
export function getPresentationPublicBaseUrl(): string {
  return `https://${FUNNEL_HOST}/presentations`
}

export function publicUrlForPresentation(filename: string): string {
  return `${getPresentationPublicBaseUrl()}/${encodeURIComponent(basename(filename))}`
}

export function getPresentationLocalBaseUrl(): string | null {
  const ip = getTailscaleIp()
  if (!ip) return null
  return `http://${ip}:${PORT}/presentations`
}

export function localUrlForPresentation(filename: string): string | null {
  const base = getPresentationLocalBaseUrl()
  if (!base) return null
  return `${base}/${encodeURIComponent(basename(filename))}`
}

export function startPresentationServer(): void {
  mkdirSync(PRESENTATIONS_DIR, { recursive: true })
  const server = createServer(handler)
  server.listen(PORT, '127.0.0.1', () => {
    logger.info(
      {
        port: PORT,
        dir: PRESENTATIONS_DIR,
        publicBase: getPresentationPublicBaseUrl(),
        upstream: UPSTREAM,
      },
      'Presentation edge listening (Funnel target)'
    )
  })
  server.on('error', (err) => {
    logger.warn({ err }, 'Presentation server failed to start (non-fatal)')
  })
}
