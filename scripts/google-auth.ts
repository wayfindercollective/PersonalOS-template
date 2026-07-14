/**
 * Google OAuth2 authorization script.
 * Run: npx tsx scripts/google-auth.ts [account-name]
 *
 * Examples:
 *   npx tsx scripts/google-auth.ts          -> saves to store/google-token.json (default/personal)
 *   npx tsx scripts/google-auth.ts work     -> saves to store/google-token-work.json
 *   npx tsx scripts/google-auth.ts personal -> saves to store/google-token-personal.json
 */
import { google } from 'googleapis'
import { createServer } from 'node:http'
import { readEnvFile } from '../src/env.js'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const env = readEnvFile()

const accountName = process.argv[2] ?? ''
const tokenFileName = accountName ? `google-token-${accountName}.json` : 'google-token.json'

const CLIENT_ID = env['GOOGLE_CLIENT_ID'] ?? ''
const CLIENT_SECRET = env['GOOGLE_CLIENT_SECRET'] ?? ''
const TOKEN_PATH = resolve(__dirname, '..', 'store', tokenFileName)
const REDIRECT_PORT = 3456
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
]

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env')
  process.exit(1)
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

const loginHint =
  accountName === 'work'
    ? (env['GOOGLE_WORK_EMAIL'] ?? '')
    : (env['GOOGLE_PERSONAL_EMAIL'] ?? '')

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  // Force account picker so work session doesn't steal personal auth
  prompt: 'select_account consent',
  login_hint: loginHint,
})

console.log('\n=== Google OAuth2 Authorization ===\n')
console.log(`Account: ${accountName || 'default'}`)
console.log(`Token will be saved to: ${TOKEN_PATH}\n`)
console.log('Opening browser...\n')
console.log('(If it does not open, paste this URL manually:)\n')
console.log(authUrl)
console.log('\nWaiting for authorization...\n')

spawn('xdg-open', [authUrl], { detached: true, stdio: 'ignore' }).unref()

// Start a temporary local server to catch the redirect
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`)
  const code = url.searchParams.get('code')

  if (!code) {
    res.writeHead(400)
    res.end('No authorization code received')
    return
  }

  try {
    const { tokens } = await oauth2Client.getToken(code)
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
    console.log(`Token saved to ${TOKEN_PATH}`)
    console.log('Authorization complete!')

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<h1>Authorization successful!</h1><p>You can close this window.</p>')
  } catch (err) {
    console.error('Error exchanging code for token:', err)
    res.writeHead(500)
    res.end('Error exchanging authorization code')
  }

  // Shutdown after a short delay
  setTimeout(() => {
    server.close()
    process.exit(0)
  }, 1000)
})

server.listen(REDIRECT_PORT, () => {
  console.log(`Listening on port ${REDIRECT_PORT} for OAuth callback...`)
})
