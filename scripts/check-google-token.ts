/**
 * Check health of stored Google OAuth tokens.
 * Run: npx tsx scripts/check-google-token.ts
 *
 * Exit code 0 if all tokens refresh OK, 1 if any need re-auth.
 */
import { google } from 'googleapis'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from '../src/env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_DIR = resolve(__dirname, '..', 'store')
const env = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
const CLIENT_ID = env['GOOGLE_CLIENT_ID'] ?? ''
const CLIENT_SECRET = env['GOOGLE_CLIENT_SECRET'] ?? ''
const REDIRECT_URI = 'http://localhost:3456/callback'

const ACCOUNTS = [
  { label: 'personal', file: 'google-token.json', reauthCmd: 'personalos-reauth' },
  { label: 'work', file: 'google-token-work.json', reauthCmd: 'personalos-reauth work' },
]

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function fmtAge(ms: number): string {
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  if (d > 0) return `${d}d ${h}h`
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return `${h}h ${m}m`
}

let anyFailed = false

for (const { label, file, reauthCmd } of ACCOUNTS) {
  const path = resolve(STORE_DIR, file)
  process.stdout.write(`${label}: `)

  if (!existsSync(path)) {
    console.log(`${RED}NO TOKEN${RESET}  ${DIM}->${RESET} run: ${reauthCmd}`)
    anyFailed = true
    continue
  }

  const token = JSON.parse(readFileSync(path, 'utf-8'))
  const mtime = statSync(path).mtimeMs
  const isTestingMode = 'refresh_token_expires_in' in token

  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
  client.setCredentials(token)

  try {
    await client.getAccessToken()
    let extra = ''
    if (isTestingMode) {
      // Refresh tokens in Testing mode expire 7 days after last issue.
      // mtime is updated on every auto-refresh, so this is best-effort.
      const ageMs = Date.now() - mtime
      const remainingMs = 7 * 86_400_000 - ageMs
      if (remainingMs < 0) {
        extra = ` ${YELLOW}(refresh_token likely expiring soon -- last touched ${fmtAge(ageMs)} ago)${RESET}`
      } else if (remainingMs < 2 * 86_400_000) {
        extra = ` ${YELLOW}(re-auth in ~${fmtAge(remainingMs)})${RESET}`
      } else {
        extra = ` ${DIM}(re-auth in ~${fmtAge(remainingMs)})${RESET}`
      }
    }
    console.log(`${GREEN}OK${RESET}${extra}`)
  } catch (e: any) {
    const errMsg = e.response?.data?.error ?? e.message
    console.log(`${RED}NEEDS RE-AUTH${RESET} (${errMsg})  ${DIM}->${RESET} run: ${reauthCmd}`)
    anyFailed = true
  }
}

process.exit(anyFailed ? 1 : 0)
