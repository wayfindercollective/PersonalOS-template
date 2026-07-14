import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path, { dirname, join } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'
import { readEnvFile } from './env.js'
import { navigateTo, clickElement, fillField, takeScreenshot, getPageContent } from './browser.js'

const env = readEnvFile()
const __dirname = dirname(fileURLToPath(import.meta.url))

// ============================================================
// Endpoint configuration with priority-based fallback
// ============================================================

const STORE_DIR = join(__dirname, '..', 'store')
const ENDPOINTS_FILE = join(STORE_DIR, 'endpoints.json')

interface EndpointConfig {
  priority: string[]
  endpoints: Record<string, string>
  cooldownMinutes: number
}

function loadEndpointConfig(): EndpointConfig {
  try {
    if (existsSync(ENDPOINTS_FILE)) {
      const data = JSON.parse(readFileSync(ENDPOINTS_FILE, 'utf-8'))
      if (data.priority && data.endpoints && Object.keys(data.endpoints).length > 0) {
        return {
          priority: data.priority,
          endpoints: data.endpoints,
          cooldownMinutes: data.cooldownMinutes ?? 5,
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load endpoints.json, bootstrapping from .env')
  }

  // Bootstrap from .env (OLLAMA_URL_* vars)
  const endpoints: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^OLLAMA_URL_(.+)$/)
    if (match && value) {
      endpoints[match[1].toLowerCase()] = value
    }
  }

  const priorityStr = env['OLLAMA_ENDPOINT_PRIORITY']
  const priority = priorityStr
    ? priorityStr.split(',').map(s => s.trim().toLowerCase())
    : Object.keys(endpoints)

  const config: EndpointConfig = { priority, endpoints, cooldownMinutes: 5 }
  saveEndpointConfig(config)
  return config
}

function saveEndpointConfig(config: EndpointConfig): void {
  try {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(ENDPOINTS_FILE, JSON.stringify(config, null, 2))
  } catch (err) {
    logger.warn({ err }, 'Failed to save endpoints.json')
  }
}

const endpointConfig = loadEndpointConfig()

// --- Health tracking ---

interface EndpointHealth {
  status: 'up' | 'down'
  downSince?: number
  lastError?: string
}

const endpointHealth = new Map<string, EndpointHealth>()

function isEndpointCoolingDown(name: string): boolean {
  const health = endpointHealth.get(name)
  if (!health || health.status === 'up') return false
  const cooldownMs = endpointConfig.cooldownMinutes * 60 * 1000
  return Date.now() - (health.downSince ?? 0) < cooldownMs
}

function markEndpointDown(name: string, error: string): void {
  const existing = endpointHealth.get(name)
  endpointHealth.set(name, {
    status: 'down',
    downSince: existing?.status === 'down' ? existing.downSince : Date.now(),
    lastError: error,
  })
  logger.warn({ endpoint: name, error }, 'Endpoint marked down')
}

function markEndpointUp(name: string): void {
  const prev = endpointHealth.get(name)
  if (prev?.status === 'down') {
    logger.info({ endpoint: name }, 'Endpoint recovered')
  }
  endpointHealth.set(name, { status: 'up' })
}

function isNetworkError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('enetunreach') ||
    msg.includes('ehostunreach') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('eai_again')
  )
}

// Get endpoints in priority order; if chat has a manual override, try that first
function getOrderedEndpoints(chatId: string): string[] {
  const manual = chatEndpoint.get(chatId)
  const ordered: string[] = []

  if (manual && endpointConfig.endpoints[manual]) {
    ordered.push(manual)
  }

  for (const name of endpointConfig.priority) {
    if (!ordered.includes(name) && endpointConfig.endpoints[name]) {
      ordered.push(name)
    }
  }

  for (const name of Object.keys(endpointConfig.endpoints)) {
    if (!ordered.includes(name)) {
      ordered.push(name)
    }
  }

  return ordered
}

export class AllEndpointsDownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllEndpointsDownError'
  }
}

const DEFAULT_MODEL = env['OLLAMA_MODEL'] ?? 'qwen3-30b-moe'
const MAX_TOOL_LOOPS = 15

// ============================================================
// Tool definitions (Ollama format)
// Optimized for small models: short descriptions, clear params
// ============================================================

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description: 'Run a shell command on this machine. Returns stdout/stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file and return its contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates or overwrites.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'The content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'List files in a directory with type and size.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the web. Returns titles, snippets, and URLs. Use for current events, prices, news, real-time data.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (be specific)' },
          count: { type: 'number', description: 'Number of results (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return readable text content. Use after web_search to read a specific page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          max_chars: { type: 'number', description: 'Max characters to return (default 8000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browse_url',
      description: 'Fetch a URL using a headless browser (renders JavaScript). Use for pages that web_fetch returns little content from.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to browse' },
          max_chars: { type: 'number', description: 'Max characters to return (default 8000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_navigate',
      description: 'Navigate to a URL in a persistent browser session. Returns page text content. Login sessions are preserved across calls.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          profile: { type: 'string', description: 'Browser profile name (default: "default")' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_click',
      description: 'Click an element on the current browser page by CSS selector or text content.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector or text:="visible text" to click' },
          profile: { type: 'string', description: 'Browser profile (default: "default")' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_fill',
      description: 'Fill a form field with text in the browser.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input field' },
          value: { type: 'string', description: 'Text to type into the field' },
          profile: { type: 'string', description: 'Browser profile (default: "default")' },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current browser page. Returns the file path.',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Browser profile (default: "default")' },
          full_page: { type: 'boolean', description: 'Capture full scrollable page (default: false)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_get_content',
      description: 'Get the text content of the current browser page without navigating.',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Browser profile (default: "default")' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'escalate',
      description: 'LAST RESORT ONLY. Hand off to Claude after you have genuinely tried with your own tools (web_search, bash, etc.) and completely failed. Do NOT escalate for things you can look up or figure out yourself.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Brief reason for escalation' },
          context: { type: 'string', description: 'Summary of what was asked and what you tried' },
        },
        required: ['reason', 'context'],
      },
    },
  },
]

// ============================================================
// Safety: action classification
// ============================================================

type Risk = 'safe' | 'restricted' | 'blocked'

interface SafetyResult {
  risk: Risk
  reason?: string
}

// Directories the small model can write to (everything else is read-only)

function resolveUserPath(p: string): string {
  if (path.isAbsolute(p)) return path.normalize(p)
  return path.join(os.homedir(), p)
}

const WRITABLE_PATHS = [os.homedir() + path.sep, os.tmpdir() + path.sep, path.resolve('.') + path.sep]

// Paths the model cannot even read
const BLOCKED_READ_PATHS = [
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), '.env'),
  '/etc/shadow',
  '/etc/passwd',
]

// Bash commands/patterns that are always blocked
const BLOCKED_COMMANDS = [
  /\bsudo\b/,
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/i,  // rm -rf, rm -f, etc
  /\brm\s+-[a-z]*R/i,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\bformat\b/,
  /\bshred\b/,
  /\bwipe\b/,
  /\b(shutdown|reboot|poweroff|halt|init\s+[0-6])\b/,
  /\bsystemctl\s+(stop|disable|mask|restart)\s+(?!--user)/,  // system-level systemctl (user-level OK)
  /\bchmod\s+[0-7]*777\b/,
  /\bchown\b/,
  /\bcurl\s.*\|\s*(ba)?sh\b/,    // curl | bash
  /\bwget\s.*\|\s*(ba)?sh\b/,
  />\s*\/dev\/sd/,                // writing to block devices
  />\s*\/etc\//,                  // overwriting system config
  />\s*\/boot\//,
  /\biptables\b/,
  /\bkill\s+-9\b/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bnohup\b.*&/,                // background processes
  /\bcrontab\s+-r\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /:\(\)\s*\{\s*:\|:&\s*\}/,     // fork bomb
]

// Bash patterns that are restricted (logged prominently, allowed)
const RESTRICTED_COMMANDS = [
  /\bgit\s+(push|commit|reset)\b/,
  /\bnpm\s+(publish|unpublish)\b/,
  /\bpip\s+install\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bscp\b/,
]

function classifyBashCommand(command: string): SafetyResult {
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return { risk: 'blocked', reason: `Blocked pattern: ${pattern.source}` }
    }
  }
  for (const pattern of RESTRICTED_COMMANDS) {
    if (pattern.test(command)) {
      return { risk: 'restricted', reason: `Restricted: ${pattern.source}` }
    }
  }
  return { risk: 'safe' }
}

function classifyPathAccess(path: string, write: boolean): SafetyResult {
  const resolved = resolveUserPath(path)

  for (const blocked of BLOCKED_READ_PATHS) {
    if (resolved.startsWith(blocked) || resolved === blocked) {
      return { risk: 'blocked', reason: `Blocked path: ${blocked}` }
    }
  }

  if (write) {
    const allowed = WRITABLE_PATHS.some((p) => resolved.startsWith(p))
    if (!allowed) {
      return { risk: 'blocked', reason: `Write not allowed outside: ${WRITABLE_PATHS.join(', ')}` }
    }
  }

  return { risk: 'safe' }
}

function classifyToolCall(name: string, args: Record<string, string>): SafetyResult {
  switch (name) {
    case 'bash':
      return classifyBashCommand(args.command ?? '')
    case 'read_file':
      return classifyPathAccess(args.path ?? '', false)
    case 'write_file':
      return classifyPathAccess(args.path ?? '', true)
    case 'list_directory':
      return classifyPathAccess(args.path ?? '', false)
    case 'web_search':
      return { risk: 'safe' }
    case 'web_fetch': {
      const url = args.url ?? ''
      // Block fetching local/internal URLs
      if (/^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/i.test(url)) {
        return { risk: 'blocked', reason: 'Cannot fetch internal/local URLs' }
      }
      return { risk: 'safe' }
    }
    case 'browse_url':
    case 'browser_navigate': {
      const url = args.url ?? ''
      if (/^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/i.test(url)) {
        return { risk: 'blocked', reason: 'Cannot fetch internal/local URLs' }
      }
      return { risk: 'safe' }
    }
    case 'browser_click':
    case 'browser_fill':
    case 'browser_screenshot':
    case 'browser_get_content':
    case 'escalate':
      return { risk: 'safe' }
    default:
      return { risk: 'blocked', reason: `Unknown tool: ${name}` }
  }
}

// ============================================================
// Tool execution (runs locally on this machine)
// ============================================================

interface ToolResult {
  output: string
  risk: Risk
  reason?: string
}

// Web search via DuckDuckGo HTML (no API key needed) + Google fallback
async function executeWebSearch(query: string, count: number = 5): Promise<string> {
  const maxResults = Math.min(count || 5, 10)

  try {
    // Try DuckDuckGo HTML lite (no JS needed)
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const ddgRes = await fetch(ddgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    })

    if (ddgRes.ok) {
      const html = await ddgRes.text()
      // Parse DuckDuckGo HTML lite results
      const results: Array<{ title: string; url: string; snippet: string }> = []
      const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs
      const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs

      const links = [...html.matchAll(linkRegex)]
      const snippets = [...html.matchAll(snippetRegex)]

      for (let i = 0; i < Math.min(links.length, maxResults); i++) {
        let url = links[i][1]
        // DDG wraps URLs in a redirect -- extract the actual URL
        const uddgMatch = url.match(/uddg=([^&]+)/)
        if (uddgMatch) url = decodeURIComponent(uddgMatch[1])

        const title = links[i][2].replace(/<[^>]+>/g, '').trim()
        const snippet = snippets[i]
          ? snippets[i][1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
          : ''

        if (title && url) {
          results.push({ title, url, snippet })
        }
      }

      if (results.length > 0) {
        return results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
        ).join('\n\n')
      }
    }
  } catch (err) {
    logger.warn({ err }, 'DuckDuckGo search failed, trying fallback')
  }

  // Fallback: use Google Custom Search via bash curl (if API key available)
  const googleKey = env['GOOGLE_API_KEY']
  if (googleKey) {
    try {
      const cseUrl = `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=017576662512468239146:omuauf_gy48&q=${encodeURIComponent(query)}&num=${maxResults}`
      const gRes = await fetch(cseUrl)
      if (gRes.ok) {
        const gData = (await gRes.json()) as { items?: Array<{ title: string; link: string; snippet: string }> }
        if (gData.items && gData.items.length > 0) {
          return gData.items.map((item, i) =>
            `${i + 1}. ${item.title}\n   ${item.link}\n   ${item.snippet}`
          ).join('\n\n')
        }
      }
    } catch {
      // Google CSE failed too
    }
  }

  return 'No search results found. Try a different query.'
}

// Fetch and extract readable text from a URL
async function executeWebFetch(url: string, maxChars: number = 4000): Promise<string> {
  const limit = Math.min(maxChars || 4000, 8000)

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) return `HTTP ${res.status}: Failed to fetch ${url}`

    const contentType = res.headers.get('content-type') ?? ''
    const rawText = await res.text()

    // If it's plain text or JSON, return directly
    if (contentType.includes('text/plain') || contentType.includes('application/json')) {
      return rawText.slice(0, limit)
    }

    // Strip HTML to readable text
    let text = rawText
      // Remove script and style blocks
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      // Convert meaningful tags
      .replace(/<h[1-6][^>]*>/gi, '\n## ')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p[^>]*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      // Strip remaining tags
      .replace(/<[^>]+>/g, ' ')
      // Decode entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Clean whitespace
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim()

    if (text.length < 50) {
      return `Page at ${url} returned very little readable text (may require JavaScript to render).`
    }

    return text.slice(0, limit) + (text.length > limit ? '\n... (truncated)' : '')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Error fetching ${url}: ${msg}`
  }
}

// Escalation marker -- the bot.ts handler checks for this to trigger Claude
const ESCALATION_PREFIX = '__ESCALATE__'

async function executeTool(name: string, args: Record<string, string>): Promise<ToolResult> {
  // Classify first
  const safety = classifyToolCall(name, args)

  if (safety.risk === 'blocked') {
    logger.warn({ tool: name, args, reason: safety.reason }, 'BLOCKED tool call')
    return {
      output: `BLOCKED: ${safety.reason}. Try a different approach.`,
      risk: 'blocked',
      reason: safety.reason,
    }
  }

  if (safety.risk === 'restricted') {
    logger.warn({ tool: name, args, reason: safety.reason }, 'RESTRICTED tool call (allowed)')
  }

  // Async tools (web_search, web_fetch)
  if (name === 'web_search') {
    return executeWebSearch(args.query, parseInt(args.count ?? '5'))
      .then(output => ({ output, risk: safety.risk, reason: safety.reason }))
      .catch(err => ({ output: `Search error: ${err instanceof Error ? err.message : String(err)}`, risk: safety.risk as Risk }))
  }

  if (name === 'web_fetch') {
    return executeWebFetch(args.url, parseInt(args.max_chars ?? '8000'))
      .then(output => ({ output, risk: safety.risk, reason: safety.reason }))
      .catch(err => ({ output: `Fetch error: ${err instanceof Error ? err.message : String(err)}`, risk: safety.risk as Risk }))
  }

  if (name === 'escalate') {
    logger.info({ reason: args.reason, context: args.context }, 'Model requested escalation to Claude')
    return {
      output: `${ESCALATION_PREFIX}${JSON.stringify({ reason: args.reason, context: args.context })}`,
      risk: 'safe',
    }
  }

  try {
    let output: string

    switch (name) {
      case 'bash': {
        const result = execSync(args.command, {
          encoding: 'utf-8',
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        output = result.slice(0, 8000) || '(no output)'
        break
      }

      case 'read_file': {
        const content = readFileSync(args.path, 'utf-8')
        output = content.length > 16000
          ? content.slice(0, 16000) + '\n... (truncated)'
          : content
        break
      }

      case 'write_file': {
        writeFileSync(args.path, args.content)
        output = `Written ${args.content.length} bytes to ${args.path}`
        break
      }

      case 'list_directory': {
        const entries = readdirSync(args.path)
        const lines = entries.slice(0, 100).map((e) => {
          try {
            const stat = statSync(`${args.path}/${e}`)
            const type = stat.isDirectory() ? 'dir' : 'file'
            const size = stat.isDirectory() ? '' : ` (${stat.size}b)`
            return `${type}  ${e}${size}`
          } catch {
            return `???  ${e}`
          }
        })
        output = lines.join('\n') || '(empty directory)'
        break
      }

      case 'browse_url': {
        const url = String(args.url ?? '')
        if (/^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/i.test(url)) {
          output = 'BLOCKED: Cannot fetch internal/local URLs'
          break
        }
        const limit = Math.min(Number(args.max_chars ?? 8000), 16000)
        try {
          const result = execSync(
            `node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch({headless:true});const p=await b.newPage();await p.goto(${JSON.stringify(url)},{waitUntil:'networkidle',timeout:30000});const t=await p.innerText('body');await b.close();process.stdout.write(t);})()"`,
            { encoding: 'utf-8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024 }
          )
          output = result.slice(0, limit) + (result.length > limit ? '\n... (truncated)' : '')
        } catch {
          try {
            const html = execSync(
              `curl -sL --max-time 15 -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" ${JSON.stringify(url)}`,
              { encoding: 'utf-8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }
            )
            let text = html
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
              .replace(/[ \t]+/g, ' ')
              .replace(/\n\s*\n\s*\n/g, '\n\n')
              .trim()
            if (text.length < 50) {
              output = `Page at ${url} returned very little readable text (JS-rendered content not available without Playwright).`
            } else {
              output = text.slice(0, limit) + (text.length > limit ? '\n... (truncated)' : '')
            }
          } catch (err) {
            output = `Error browsing ${url}: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        break
      }

      case 'browser_navigate': {
        const url = String(args.url ?? '')
        if (/^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/i.test(url)) {
          output = 'BLOCKED: Cannot browse internal/local URLs'
          break
        }
        const profile = String(args.profile ?? 'default')
        output = await navigateTo(url, profile)
        break
      }

      case 'browser_click': {
        const selector = String(args.selector ?? '')
        const profile = String(args.profile ?? 'default')
        output = await clickElement(selector, profile)
        break
      }

      case 'browser_fill': {
        const selector = String(args.selector ?? '')
        const value = String(args.value ?? '')
        const profile = String(args.profile ?? 'default')
        output = await fillField(selector, value, profile)
        break
      }

      case 'browser_screenshot': {
        const profile = String(args.profile ?? 'default')
        const fullPage = Boolean(args.full_page ?? false)
        const filepath = await takeScreenshot(profile, fullPage)
        output = `Screenshot saved: ${filepath}`
        break
      }

      case 'browser_get_content': {
        const profile = String(args.profile ?? 'default')
        output = await getPageContent(profile)
        break
      }

      default:
        output = `Unknown tool: ${name}`
    }

    return { output, risk: safety.risk, reason: safety.reason }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: `Error: ${msg.slice(0, 2000)}`, risk: safety.risk }
  }
}

export { ESCALATION_PREFIX }

// ============================================================
// Per-chat state
// ============================================================

const chatEndpoint = new Map<string, string>()
const chatModel = new Map<string, string>()
const chatHistory = new Map<string, Array<OllamaMessage>>()
const chatToolsEnabled = new Map<string, boolean>()
const MAX_HISTORY = 20

// Ollama message types
interface OllamaToolCall {
  function: { name: string; arguments: Record<string, string> }
}

interface OllamaMessage {
  role: string
  content: string
  tool_calls?: OllamaToolCall[]
}

// ============================================================
// Public API
// ============================================================

export function getEndpointNames(): string[] {
  return Object.keys(endpointConfig.endpoints)
}

export function getActiveEndpoint(chatId: string): string {
  return chatEndpoint.get(chatId) ?? endpointConfig.priority[0] ?? 'local'
}

export function getActiveEndpointUrl(chatId: string): string {
  const name = getActiveEndpoint(chatId)
  return endpointConfig.endpoints[name] ?? Object.values(endpointConfig.endpoints)[0] ?? 'http://localhost:11434'
}

export function setActiveEndpoint(chatId: string, name: string): boolean {
  if (!endpointConfig.endpoints[name]) return false
  chatEndpoint.set(chatId, name)
  return true
}

export function getOllamaModel(chatId: string): string {
  return chatModel.get(chatId) ?? DEFAULT_MODEL
}

export function setOllamaModel(chatId: string, model: string): void {
  chatModel.set(chatId, model)
}

export function clearOllamaHistory(chatId: string): void {
  chatHistory.delete(chatId)
}

export function setOllamaHistory(
  chatId: string,
  messages: Array<{ role: string; content: string }>
): void {
  // Pre-populate history from cross-model log; system prompt will be prepended on next use
  chatHistory.set(chatId, messages.map((m) => ({ role: m.role as OllamaMessage['role'], content: m.content })))
}

export function getOllamaHistory(chatId: string): Array<{ role: string; content: string }> {
  const history = chatHistory.get(chatId) ?? []
  // Return only user/assistant turns (no system, no tool messages) as plain role+content
  return history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))
}

export function seedOllamaHistory(
  chatId: string,
  turns: Array<{ role: string; content: string }>
): void {
  // Only seed if there is no existing history (fresh switch)
  if (chatHistory.has(chatId) && (chatHistory.get(chatId)?.length ?? 0) > 0) return
  if (turns.length === 0) return
  const messages: OllamaMessage[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
  }))
  chatHistory.set(chatId, messages)
}

export function isToolsEnabled(chatId: string): boolean {
  return chatToolsEnabled.get(chatId) ?? true
}

export function setToolsEnabled(chatId: string, enabled: boolean): void {
  chatToolsEnabled.set(chatId, enabled)
}

export function getOllamaStatus(chatId: string): string {
  const endpoint = getActiveEndpoint(chatId)
  const model = getOllamaModel(chatId)
  const url = endpointConfig.endpoints[endpoint]
  const tools = isToolsEnabled(chatId) ? ' [tools]' : ''
  const health = endpointHealth.get(endpoint)
  const healthTag = health?.status === 'down' ? ' [DOWN]' : ''
  return `${endpoint} (${url}) -- ${model}${tools}${healthTag}`
}

// ============================================================
// Endpoint management
// ============================================================

export function getEndpointPriority(): string[] {
  return [...endpointConfig.priority]
}

export function setEndpointPriority(order: string[]): { success: boolean; error?: string } {
  for (const name of order) {
    if (!endpointConfig.endpoints[name]) {
      return { success: false, error: `Unknown endpoint: ${name}` }
    }
  }
  endpointConfig.priority = order
  saveEndpointConfig(endpointConfig)
  return { success: true }
}

export function addEndpoint(name: string, url: string): { success: boolean; error?: string } {
  const key = name.toLowerCase()
  if (endpointConfig.endpoints[key]) {
    return { success: false, error: `Endpoint "${key}" already exists` }
  }
  endpointConfig.endpoints[key] = url
  endpointConfig.priority.push(key)
  saveEndpointConfig(endpointConfig)
  return { success: true }
}

export function removeEndpoint(name: string): { success: boolean; error?: string } {
  const key = name.toLowerCase()
  if (!endpointConfig.endpoints[key]) {
    return { success: false, error: `Endpoint "${key}" not found` }
  }
  if (Object.keys(endpointConfig.endpoints).length <= 1) {
    return { success: false, error: 'Cannot remove the last endpoint' }
  }
  delete endpointConfig.endpoints[key]
  endpointConfig.priority = endpointConfig.priority.filter(n => n !== key)
  endpointHealth.delete(key)
  saveEndpointConfig(endpointConfig)
  return { success: true }
}

export function setCooldownMinutes(minutes: number): void {
  endpointConfig.cooldownMinutes = minutes
  saveEndpointConfig(endpointConfig)
}

export function getCooldownMinutes(): number {
  return endpointConfig.cooldownMinutes
}

export function getEndpointsStatus(): Array<{
  name: string
  url: string
  priority: number
  health: 'up' | 'down' | 'unknown'
  downSince?: string
  lastError?: string
  cooldown: boolean
}> {
  const allNames = [...new Set([...endpointConfig.priority, ...Object.keys(endpointConfig.endpoints)])]
  return allNames.map((name) => {
    const health = endpointHealth.get(name)
    const priorityIdx = endpointConfig.priority.indexOf(name)
    return {
      name,
      url: endpointConfig.endpoints[name],
      priority: priorityIdx >= 0 ? priorityIdx + 1 : -1,
      health: health?.status ?? 'unknown',
      downSince: health?.downSince ? new Date(health.downSince).toLocaleTimeString() : undefined,
      lastError: health?.lastError,
      cooldown: isEndpointCoolingDown(name),
    }
  })
}

export async function checkAllEndpoints(): Promise<Array<{ name: string; available: boolean }>> {
  const results: Array<{ name: string; available: boolean }> = []
  for (const name of Object.keys(endpointConfig.endpoints)) {
    const url = endpointConfig.endpoints[name]
    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) })
      const available = res.ok
      if (available) markEndpointUp(name)
      else markEndpointDown(name, `HTTP ${res.status}`)
      results.push({ name, available })
    } catch (err) {
      markEndpointDown(name, err instanceof Error ? err.message : String(err))
      results.push({ name, available: false })
    }
  }
  return results
}

export function resetEndpointHealth(name?: string): void {
  if (name) {
    endpointHealth.delete(name)
  } else {
    endpointHealth.clear()
  }
}

// ============================================================
// Confidence scoring
// ============================================================

const CONFIDENCE_THRESHOLD = 50

// Patterns that mean "I genuinely cannot answer this" -> ESCALATE
// NOTE: Keep this tight. The 27b model is smart -- normal hedging or
// suggesting verification is fine, not a reason to escalate.
const CANT_ANSWER_PATTERNS = [
  // Model claims it can't use tools it actually has (web_search, bash, etc.)
  /\bi\s+(can'?t|cannot)\s+(browse|search|look\s+up|fetch|access\s+the\s+internet)/i,
  /\bdon'?t\s+have\s+(real-?time|current|live|up-?to-?date)\s+(data|information|access|prices?)/i,
  /\bcannot\s+(access|browse|search)\s+(the\s+)?(internet|web|real-?time)/i,

  // Hard refusals -- model explicitly says it can't do the task
  /\bi\s+(don'?t|do not|cannot|can'?t)\s+have\s+(access|the ability|a way)/i,
  /\bi\s+lack\s+(access|the\s+ability)\b/i,
  /\bi\s+have\s+no\s+(way|access|ability|means)\b/i,

  // Knowledge cutoff claims (should use web_search instead)
  /\bmy\s+(training|knowledge)\s+(data|cutoff|only\s+goes)/i,
]

// Patterns that suggest pure hedging with no substance
const HEDGING_PATTERNS = [
  /\bit\s+depends\s+on\b.*\bit\s+depends\s+on\b/is,
  /\bthis\s+is\s+a\s+(complex|complicated|nuanced|broad)\s+(topic|question|issue|area)\b/i,
  /\bthe\s+answer\s+(depends|varies|is\s+not\s+straightforward)\b/i,
]

function normalizeQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"')
}

function evaluateConfidenceSync(rawResponse: string): { score: number; reason: string } {
  const response = normalizeQuotes(rawResponse)
  const trimmed = response.trim()

  if (trimmed.length > 0 && trimmed.length < 30 && /^\d|^yes|^no|^true|^false|^[A-Z][a-z]+\.?$/i.test(trimmed)) {
    return { score: 90, reason: 'Direct answer' }
  }

  if (trimmed.length < 3) {
    return { score: 10, reason: 'Empty response' }
  }

  // Only flag genuine inability -- the model claims it can't do something it actually can
  for (const pattern of CANT_ANSWER_PATTERNS) {
    if (pattern.test(response)) {
      return { score: 40, reason: 'Model claims inability' }
    }
  }

  let hedgeCount = 0
  for (const pattern of HEDGING_PATTERNS) {
    if (pattern.test(response)) hedgeCount++
  }

  if (hedgeCount >= 2 && response.length < 300) {
    return { score: 45, reason: 'Response is mostly hedging' }
  }

  if (trimmed.length < 20) {
    return { score: 55, reason: 'Response very brief' }
  }

  return { score: 90, reason: 'Response looks complete' }
}

const CASUAL_QUESTION_PATTERNS = [
  /\b(what'?s|what\s+is)\s+your\s+(favorite|fav|favourite|name|age|opinion)\b/i,
  /\bhow\s+are\s+you\b/i,
  /\bwhat\s+do\s+you\s+think\s+(about|of)\b/i,
  /\btell\s+me\s+(a\s+joke|something\s+funny|about\s+yourself)\b/i,
  /\bdo\s+you\s+(like|enjoy|prefer|have|know)\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bcan\s+you\s+(help|tell|explain|describe)\b/i,
  /\b(hi|hello|hey|sup|yo)\b/i,
]

const NEEDS_REALTIME_PATTERNS = [
  /\b(weather|forecast|temperature)\b/i,
  /\b(price|cost|stock|market|crypto|bitcoin)\b/i,
  /\b(today|tonight|tomorrow|this\s+week|this\s+weekend|right\s+now|currently)\b/i,
  /\b(news|latest|recent|update)\b.*\b(war|election|event|score)\b/i,
  /\bwhat\s+time\s+is\s+it\b/i,
  /\bschedule|remind|alarm|timer\b/i,
  /\b(search|look\s+up|google|find\s+out)\b/i,
]

export async function evaluateConfidence(
  _chatId: string,
  question: string,
  response: string
): Promise<{ score: number; reason: string }> {
  const result = evaluateConfidenceSync(response)

  const isCasual = CASUAL_QUESTION_PATTERNS.some(p => p.test(question))
  const needsRealtime = NEEDS_REALTIME_PATTERNS.some(p => p.test(question))

  if (isCasual && result.score < CONFIDENCE_THRESHOLD) {
    logger.info(
      { score: result.score, reason: result.reason, casual: true },
      'Casual question failed confidence -- model should handle this'
    )
  }

  if (needsRealtime && result.score < CONFIDENCE_THRESHOLD) {
    logger.info(
      { score: result.score, reason: result.reason, realtime: true },
      'Real-time question failed confidence -- escalation correct'
    )
  }

  logger.info({ score: result.score, reason: result.reason }, 'Confidence evaluation')
  return result
}

export function getConfidenceThreshold(): number {
  return CONFIDENCE_THRESHOLD
}

// ============================================================
// Core query with tool-calling agent loop + endpoint fallback
// ============================================================

export interface OllamaResult {
  text: string
  toolLog: string[]
  usedEndpoint?: string
  fellBack?: boolean
  confidence?: { score: number; reason: string }
  escalated?: boolean
}

// Internal: run the agent loop against a specific URL
async function doAgentLoop(
  url: string,
  model: string,
  history: OllamaMessage[],
  toolsEnabled: boolean,
  onTyping?: () => void
): Promise<{ text: string; toolLog: string[] }> {
  let loops = 0
  let finalResponse = ''
  const toolLog: string[] = []

  while (loops < MAX_TOOL_LOOPS) {
    loops++

    const body: Record<string, unknown> = {
      model,
      messages: history,
      stream: false,
      options: {
        num_predict: 2048,
        repeat_penalty: 1.15,
      },
    }

    if (toolsEnabled) {
      body.tools = TOOLS
    }

    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errBody = await res.text()

      // Qwen models sometimes generate malformed XML tool calls that Ollama
      // can't parse. Retry the same request without tools so the model
      // responds with plain text instead of failing.
      if (toolsEnabled && errBody.includes('XML syntax error')) {
        logger.warn({ errBody }, 'Ollama XML tool-call parse error, retrying without tools')
        delete body.tools
        toolsEnabled = false

        const retry = await fetch(`${url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!retry.ok) {
          const retryErr = await retry.text()
          throw new Error(`Ollama API ${retry.status} (retry without tools): ${retryErr}`)
        }

        const retryData = (await retry.json()) as {
          message?: { role: string; content: string }
        }
        finalResponse = retryData.message?.content ?? '(no response)'
        break
      }

      throw new Error(`Ollama API ${res.status}: ${errBody}`)
    }

    const data = (await res.json()) as {
      message?: {
        role: string
        content: string
        tool_calls?: OllamaToolCall[]
      }
    }

    const assistantMsg = data.message
    if (!assistantMsg) {
      finalResponse = '(no response)'
      break
    }

    history.push({
      role: 'assistant',
      content: assistantMsg.content ?? '',
      ...(assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : {}),
    })

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const content = assistantMsg.content?.trim() ?? ''

      // If model returned empty with no tool calls on first turn, retry with a nudge
      if (content.length < 3 && loops === 1) {
        logger.info('Empty response on first turn, retrying with nudge')
        history.push({
          role: 'user',
          content: 'You returned an empty response. Please answer the question directly, or use your tools (web_search, bash, etc.) if you need to look something up.',
        })
        continue
      }

      finalResponse = assistantMsg.content ?? '(no response)'
      break
    }

    for (const toolCall of assistantMsg.tool_calls) {
      const fn = toolCall.function
      logger.info({ tool: fn.name, args: fn.arguments }, 'Executing tool call')

      if (onTyping) onTyping()

      // executeTool may return a Promise (web_search, web_fetch) or sync result
      const resultOrPromise = executeTool(fn.name, fn.arguments)
      const result = resultOrPromise instanceof Promise ? await resultOrPromise : resultOrPromise

      // Check for escalation request
      if (result.output.startsWith(ESCALATION_PREFIX)) {
        // Return a special marker so the caller can trigger Claude
        finalResponse = result.output
        toolLog.push(`escalate: ${fn.arguments.reason ?? 'requested'}`)
        // Break out of the loop entirely
        return { text: finalResponse, toolLog }
      }

      history.push({
        role: 'tool',
        content: result.output,
      })

      if (result.risk === 'blocked') {
        toolLog.push(`BLOCKED ${fn.name}: ${result.reason}`)
      } else if (result.risk === 'restricted') {
        toolLog.push(`RESTRICTED ${fn.name}: ${fn.arguments.command ?? fn.arguments.path ?? ''}`)
      } else {
        const argSummary = fn.arguments.query ?? fn.arguments.url ?? fn.arguments.command ?? fn.arguments.path ?? ''
        toolLog.push(`${fn.name}: ${argSummary.slice(0, 80)}`)
      }

      logger.info({ tool: fn.name, risk: result.risk, resultLen: result.output.length }, 'Tool call complete')
    }

    if (onTyping) onTyping()
  }

  if (loops >= MAX_TOOL_LOOPS) {
    finalResponse += '\n\n(stopped: hit tool call limit)'
  }

  // If tools were used but the model returned empty text, nudge it to summarize
  if (toolLog.length > 0 && finalResponse.trim().length === 0) {
    logger.info({ toolCount: toolLog.length }, 'Empty response after tool calls, prompting for summary')

    history.push({
      role: 'user',
      content: 'You just completed tool calls. Briefly tell me what you did and the result. Be concise.',
    })

    const summaryRes = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: history,
        stream: false,
        options: { num_predict: 512 },
      }),
    })

    if (summaryRes.ok) {
      const summaryData = (await summaryRes.json()) as {
        message?: { content: string }
      }
      const summary = summaryData.message?.content?.trim()
      if (summary) {
        finalResponse = summary
        history.push({ role: 'assistant', content: summary })
      }
    }
  }

  return { text: finalResponse, toolLog }
}

export async function queryOllama(
  chatId: string,
  message: string,
  onTyping?: () => void
): Promise<OllamaResult> {
  const model = getOllamaModel(chatId)
  const toolsEnabled = isToolsEnabled(chatId)
  let history = chatHistory.get(chatId) ?? []

  // Inject system prompt on fresh conversations or when history was pre-populated without one
  if (history.length === 0 || history[0].role !== 'system') {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/Chicago',
    })
    let sysContent = `Today is ${today}. You are PersonalOS-CB, your personal AI assistant. Be concise and direct.

Rules:
- For casual/conversational questions, just answer naturally. Don't say "as an AI" or refuse simple questions.
- If unsure about a FACTUAL claim, say so. But opinions, casual chat, and general knowledge are fine to answer directly.
- Never hedge with "it depends" or "this is complex" when a simple answer exists.
- No em dashes. No AI cliches like "Certainly!", "Great question!", "I'd be happy to".
- Keep responses tight.`
    if (toolsEnabled) {
      sysContent += `

TOOLS AVAILABLE:
- web_search: Search the internet. Use for current events, news, prices, real-time data. ALWAYS use this for factual lookups -- never claim you lack real-time data.
- web_fetch: Read a specific URL. Use after web_search to get full article text.
- bash: Run shell commands. Use for file operations, system tasks, git, scripts, code execution.
- read_file / write_file / list_directory: Direct file access.
- browse_url: Headless browser for JS-rendered pages.
- escalate: LAST RESORT. Only after you've tried your other tools and genuinely cannot handle the task.

RULES:
- You are a capable model with full tool access. Handle tasks yourself.
- NEVER say "I can't access real-time data" or "I can't browse the internet." You have web_search -- use it.
- NEVER say "as an AI" or "I don't have access." You have tools. Use them.
- For weather: bash with curl -s "https://wttr.in/City?format=3"
- For code tasks: write the code yourself using write_file and test with bash.
- To schedule tasks: bash with node ./dist/schedule-cli.js create "MESSAGE" "CRON" ${chatId}
- Cron examples: "0 12 * * *" (daily noon), "0 9 * * 1" (Mon 9am). Timezone is America/Chicago.
- Only escalate if you have tried multiple approaches with your tools and all failed. Do NOT escalate as a first response.`
    }
    history.unshift({ role: 'system', content: sysContent })
  }

  history.push({ role: 'user', content: message })

  while (history.length > MAX_HISTORY * 2) {
    history.shift()
  }

  if (onTyping) onTyping()

  // Try endpoints in priority order with fallback
  const endpointsToTry = getOrderedEndpoints(chatId)
  let lastError: Error | null = null
  let triedCount = 0
  const originalEndpoint = getActiveEndpoint(chatId)

  for (const endpointName of endpointsToTry) {
    const url = endpointConfig.endpoints[endpointName]
    if (!url) continue

    if (isEndpointCoolingDown(endpointName)) {
      logger.debug({ endpoint: endpointName }, 'Skipping endpoint (cooldown)')
      continue
    }

    triedCount++

    logger.info(
      { chatId, model, endpoint: endpointName, tools: toolsEnabled, historyLen: history.length },
      triedCount > 1 ? `Falling back to endpoint ${endpointName}` : 'Querying Ollama'
    )

    try {
      const result = await doAgentLoop(url, model, history, toolsEnabled, onTyping)

      chatEndpoint.set(chatId, endpointName)
      markEndpointUp(endpointName)
      chatHistory.set(chatId, history)

      return {
        ...result,
        usedEndpoint: endpointName,
        fellBack: triedCount > 1 && endpointName !== originalEndpoint,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      if (isNetworkError(lastError)) {
        markEndpointDown(endpointName, lastError.message)
        logger.warn(
          { endpoint: endpointName, error: lastError.message },
          'Endpoint unreachable, trying next'
        )
        continue
      }

      // Non-network error (model not found, API error, etc.) -- don't fallback
      chatHistory.set(chatId, history)
      throw lastError
    }
  }

  // All endpoints exhausted
  chatHistory.set(chatId, history)
  throw new AllEndpointsDownError(
    lastError?.message ?? 'All Ollama endpoints are unreachable'
  )
}

// ============================================================
// Model listing & health
// ============================================================

export async function listOllamaModels(endpointName?: string, chatId?: string): Promise<string[]> {
  const name = endpointName ?? (chatId ? getActiveEndpoint(chatId) : endpointConfig.priority[0])
  const url = endpointConfig.endpoints[name] ?? Object.values(endpointConfig.endpoints)[0]

  try {
    const res = await fetch(`${url}/api/tags`)
    if (!res.ok) throw new Error(`${res.status}`)
    const data = (await res.json()) as {
      models?: Array<{ name: string; size: number }>
    }
    return data.models?.map((m) => m.name) ?? []
  } catch (err) {
    logger.error({ err, url }, 'Failed to list Ollama models')
    return []
  }
}

export async function isOllamaAvailable(endpointName?: string, chatId?: string): Promise<boolean> {
  const name = endpointName ?? (chatId ? getActiveEndpoint(chatId) : endpointConfig.priority[0])
  const url = endpointConfig.endpoints[name] ?? Object.values(endpointConfig.endpoints)[0]

  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}
