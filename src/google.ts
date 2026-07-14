/**
 * Google API helper -- Calendar, Gmail, Tasks, Drive, Contacts, Sheets.
 *
 * Accounts:
 *   - personal / default → store/google-token.json (you@example.com)
 *   - work → store/google-token-work.json (work@example.com)
 *
 * Access tokens (~1h) auto-refresh via refresh_token.
 *
 * IMPORTANT — 7-day death:
 * If the Google Cloud OAuth app is in "Testing" publishing status, Google
 * EXPIRES refresh tokens after 7 days. No amount of auto-refresh fixes that.
 * Fix: Google Cloud Console → OAuth consent screen → Publish to Production
 * (or re-auth weekly with /gmailauth).
 */
import { google } from 'googleapis'
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { readEnvFile } from './env.js'
import { logger } from './logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_DIR = resolve(__dirname, '..', 'store')

const env = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])
const CLIENT_ID = env['GOOGLE_CLIENT_ID'] ?? ''
const CLIENT_SECRET = env['GOOGLE_CLIENT_SECRET'] ?? ''

/** Localhost callback for CLI auth script */
export const GOOGLE_LOCAL_REDIRECT = 'http://localhost:3456/callback'

/** Public Funnel callback for Telegram re-auth (must be in Google Cloud redirect URIs) */
export function getGoogleFunnelRedirectUri(): string {
  if (env['GOOGLE_REDIRECT_URI']) return env['GOOGLE_REDIRECT_URI'].replace(/\/$/, '')
  let host = 'your-host.tailnet.ts.net'
  try {
    const dns = execSync('tailscale status --json', { encoding: 'utf-8', timeout: 3000 })
    const name = (JSON.parse(dns) as { Self?: { DNSName?: string } }).Self?.DNSName
    if (name) host = name.replace(/\.$/, '')
  } catch { /* default */ }
  return `https://${host}/oauth/google/callback`
}

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
]

export type AccountName = 'personal' | 'work' | 'default'

/** Expected Google account emails (login_hint + post-auth verify) */
export function expectedEmailForAccount(account: AccountName): string {
  const a = normalizeAccount(account)
  if (a === 'work') {
    return (env['GOOGLE_WORK_EMAIL'] ?? 'work@example.com').toLowerCase()
  }
  return (env['GOOGLE_PERSONAL_EMAIL'] ?? 'you@example.com').toLowerCase()
}

export type GoogleTokenFile = {
  access_token?: string
  refresh_token?: string
  scope?: string
  token_type?: string
  expiry_date?: number
  refresh_token_expires_in?: number
  [k: string]: unknown
}

export type GoogleAuthHealth = {
  account: AccountName
  ok: boolean
  hasRefreshToken: boolean
  accessExpiresAt?: string
  error?: string
  needsReauth?: boolean
}

function normalizeAccount(account?: AccountName): 'personal' | 'work' {
  if (account === 'work') return 'work'
  return 'personal'
}

function tokenPath(account?: AccountName): string {
  const a = normalizeAccount(account)
  if (a === 'personal') return resolve(STORE_DIR, 'google-token.json')
  return resolve(STORE_DIR, `google-token-${a}.json`)
}

function loadToken(account?: AccountName): GoogleTokenFile | null {
  const path = tokenPath(account)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as GoogleTokenFile
  } catch {
    return null
  }
}

function saveToken(tokens: GoogleTokenFile, account?: AccountName): void {
  const path = tokenPath(account)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

function makeOAuthClient(redirectUri = GOOGLE_LOCAL_REDIRECT) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env')
  }
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri)
}

/**
 * Authenticated OAuth2 client. Wires token persistence on refresh.
 */
export function getAuthClient(account?: AccountName) {
  const a = normalizeAccount(account)
  const token = loadToken(a)
  if (!token) {
    // Keep tool errors short — the model must not turn this into a re-auth campaign.
    throw new Error(
      `Google "${a}" is not connected (no token). Silent failure for tools; user can run /gmailauth ${a} when they choose.`
    )
  }
  if (!token.refresh_token) {
    throw new Error(
      `Google "${a}" token is incomplete (no refresh_token). User can run /gmailauth ${a} when they choose.`
    )
  }

  const oauth2Client = makeOAuthClient()
  oauth2Client.setCredentials(token as any)

  // Persist ANY token rotation (access + optional new refresh_token)
  oauth2Client.on('tokens', (newTokens) => {
    const existing = loadToken(a) ?? {}
    const merged = { ...existing, ...newTokens } as GoogleTokenFile
    // Never drop refresh_token if Google omits it on refresh
    if (!merged.refresh_token && existing.refresh_token) {
      merged.refresh_token = existing.refresh_token as string
    }
    saveToken(merged, a)
    logger.info(
      { account: a, expiry: merged.expiry_date },
      'Google tokens updated on disk'
    )
  })

  return oauth2Client
}

/** Force-refresh access token now (uses refresh_token). */
export async function refreshGoogleAccessToken(
  account: AccountName = 'personal'
): Promise<GoogleAuthHealth> {
  const a = normalizeAccount(account)
  const token = loadToken(a)
  if (!token?.refresh_token) {
    return {
      account: a,
      ok: false,
      hasRefreshToken: false,
      needsReauth: true,
      error: 'No refresh_token on disk',
    }
  }

  try {
    const client = getAuthClient(a)
    const { credentials } = await client.refreshAccessToken()
    const existing = loadToken(a) ?? {}
    const merged = {
      ...existing,
      ...credentials,
      refresh_token: credentials.refresh_token || existing.refresh_token,
    } as GoogleTokenFile
    saveToken(merged, a)
    return {
      account: a,
      ok: true,
      hasRefreshToken: Boolean(merged.refresh_token),
      accessExpiresAt: merged.expiry_date
        ? new Date(merged.expiry_date).toISOString()
        : undefined,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const needsReauth =
      /invalid_grant|invalid_rapt|unauthorized_client|Token has been expired or revoked|Login Required/i.test(
        msg
      )
    logger.warn({ account: a, err: msg }, 'Google token refresh failed')
    return {
      account: a,
      ok: false,
      hasRefreshToken: true,
      needsReauth,
      error: msg.slice(0, 300),
    }
  }
}

/** Lightweight live check: refresh if access token expired, then optional ping. */
export async function ensureGoogleAuth(
  account: AccountName = 'personal',
  opts?: { ping?: boolean }
): Promise<GoogleAuthHealth> {
  const a = normalizeAccount(account)
  const token = loadToken(a)
  if (!token) {
    return {
      account: a,
      ok: false,
      hasRefreshToken: false,
      needsReauth: true,
      error: 'No token file',
    }
  }

  const expired =
    !token.expiry_date || token.expiry_date < Date.now() + 5 * 60 * 1000 // refresh 5 min early

  if (expired || opts?.ping) {
    const refreshed = await refreshGoogleAccessToken(a)
    if (!refreshed.ok) return refreshed
  }

  if (opts?.ping) {
    try {
      const gmail = getGmail(a)
      await gmail.users.getProfile({ userId: 'me' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const needsReauth = /invalid_grant|Login Required|auth/i.test(msg)
      return {
        account: a,
        ok: false,
        hasRefreshToken: Boolean(token.refresh_token),
        needsReauth,
        error: msg.slice(0, 300),
      }
    }
  }

  const t = loadToken(a)
  return {
    account: a,
    ok: true,
    hasRefreshToken: Boolean(t?.refresh_token),
    accessExpiresAt: t?.expiry_date ? new Date(t.expiry_date).toISOString() : undefined,
  }
}

export async function refreshAllGoogleAccounts(): Promise<GoogleAuthHealth[]> {
  const accounts: AccountName[] = ['personal', 'work']
  const results: GoogleAuthHealth[] = []
  for (const a of accounts) {
    if (!existsSync(tokenPath(a))) {
      results.push({
        account: a,
        ok: false,
        hasRefreshToken: false,
        needsReauth: true,
        error: 'No token file',
      })
      continue
    }
    results.push(await ensureGoogleAuth(a, { ping: true }))
  }
  return results
}

// ── Interactive re-auth (Telegram + Funnel) ─────────────────────────────────

type PendingAuth = {
  account: 'personal' | 'work'
  chatId: string
  createdAt: number
}

const pendingByState = new Map<string, PendingAuth>()

/**
 * Short start tickets so Telegram doesn't mangle the long Google OAuth URL
 * (which drops response_type → Error 400: invalid_request).
 * Funnel: GET /oauth/google/start/<ticket> → 302 → full Google auth URL.
 */
const startTickets = new Map<string, { googleUrl: string; createdAt: number }>()

function funnelBase(): string {
  // https://host/oauth/google/callback → https://host
  return getGoogleFunnelRedirectUri().replace(/\/oauth\/google\/callback\/?$/, '')
}

export function createGoogleAuthUrl(
  account: AccountName = 'personal',
  chatId?: string
): {
  /** Short Funnel link safe to send in Telegram */
  url: string
  /** Full Google authorize URL (for debugging / non-Telegram use) */
  googleUrl: string
  state: string
  redirectUri: string
  account: 'personal' | 'work'
  email: string
} {
  const a = normalizeAccount(account)
  const redirectUri = getGoogleFunnelRedirectUri()
  const state = `gauth_${a}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  if (chatId) {
    pendingByState.set(state, { account: a, chatId, createdAt: Date.now() })
    // Expire pending after 20 min
    setTimeout(() => pendingByState.delete(state), 20 * 60 * 1000).unref?.()
  }

  const client = makeOAuthClient(redirectUri)
  const loginHint = expectedEmailForAccount(a)
  const googleUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    // Force account picker + consent so we don't silently reuse the wrong logged-in Google account
    prompt: 'select_account consent',
    login_hint: loginHint,
    include_granted_scopes: true,
    state,
  })

  // Short ticket link for Telegram (avoids client stripping query params)
  const ticket = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  startTickets.set(ticket, { googleUrl, createdAt: Date.now() })
  setTimeout(() => startTickets.delete(ticket), 20 * 60 * 1000).unref?.()

  const url = `${funnelBase()}/oauth/google/start/${ticket}`
  return { url, googleUrl, state, redirectUri, account: a, email: loginHint }
}

/** Resolve short start ticket → full Google OAuth URL, or null if expired. */
export function takeGoogleStartTicket(ticket: string): string | null {
  const entry = startTickets.get(ticket)
  if (!entry) return null
  // Keep ticket for a few retries (user / double-tap); still expire via timer
  return entry.googleUrl
}

export function peekPendingGoogleAuth(state: string): PendingAuth | undefined {
  return pendingByState.get(state)
}

export async function completeGoogleAuthWithCode(
  code: string,
  state?: string
): Promise<{ ok: true; account: 'personal' | 'work'; chatId?: string } | { ok: false; error: string }> {
  const pending = state ? pendingByState.get(state) : undefined
  const account = pending?.account ?? 'personal'
  const redirectUri = getGoogleFunnelRedirectUri()
  try {
    const client = makeOAuthClient(redirectUri)
    const { tokens } = await client.getToken(code)
    if (!tokens.refresh_token) {
      // Merge with existing refresh if Google didn't return a new one
      const existing = loadToken(account)
      if (existing?.refresh_token) {
        tokens.refresh_token = existing.refresh_token
      }
    }
    if (!tokens.refresh_token) {
      return {
        ok: false,
        error:
          'Google did not return a refresh_token. Revoke app access at myaccount.google.com/permissions then try /gmailauth again with consent.',
      }
    }

    // Verify signed-in email matches personal vs work (stops work session stealing personal)
    client.setCredentials(tokens)
    const expected = expectedEmailForAccount(account)
    let actual = ''
    try {
      const gmail = google.gmail({ version: 'v1', auth: client })
      const profile = await gmail.users.getProfile({ userId: 'me' })
      actual = (profile.data.emailAddress ?? '').toLowerCase()
    } catch (e) {
      logger.warn({ err: e, account }, 'Could not verify Google account email after OAuth')
    }
    if (actual && actual !== expected) {
      return {
        ok: false,
        error:
          `Wrong Google account: signed in as ${actual}, but "${account}" must be ${expected}. ` +
          `Pick ${expected} in the account chooser (or use an incognito window), then /gmailauth ${account} again.`,
      }
    }

    saveToken(tokens as GoogleTokenFile, account)
    if (state) pendingByState.delete(state)
    clearGoogleReauthPromptData(account)
    logger.info({ account, email: actual || expected }, 'Google OAuth completed via callback')
    return { ok: true, account, chatId: pending?.chatId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg.slice(0, 400) }
  }
}

/** HTML response for OAuth browser callback */
export function googleOAuthResultHtml(ok: boolean, message: string): string {
  const title = ok ? 'Google connected' : 'Google auth failed'
  const color = ok ? '#34d399' : '#f87171'
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>body{font-family:system-ui;background:#0b1220;color:#e8eefc;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:28rem;padding:2rem;border:1px solid #243149;border-radius:16px;background:#162033}
h1{color:${color};font-size:1.4rem;margin:0 0 0.75rem}p{color:#9aabc9;line-height:1.5}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message.replace(/</g, '&lt;')}</p>
<p style="margin-top:1.2rem;font-size:0.9rem">You can close this tab and return to Telegram.</p></div></body></html>`
}

// ── API clients ─────────────────────────────────────────────────────────────

export function getCalendar(account: AccountName = 'work') {
  return google.calendar({ version: 'v3', auth: getAuthClient(account) })
}

export function getGmail(account: AccountName = 'personal') {
  return google.gmail({ version: 'v1', auth: getAuthClient(account) })
}

export function getTasks(account: AccountName = 'work') {
  return google.tasks({ version: 'v1', auth: getAuthClient(account) })
}

export function getDrive(account: AccountName = 'personal') {
  return google.drive({ version: 'v3', auth: getAuthClient(account) })
}

export function getContacts(account: AccountName = 'personal') {
  return google.people({ version: 'v1', auth: getAuthClient(account) })
}

export function getSheets(account: AccountName = 'personal') {
  return google.sheets({ version: 'v4', auth: getAuthClient(account) })
}

/**
 * Proactive re-auth Telegram pings: at most ONCE per account until they fix it
 * (or run /gmailauth themselves). Persisted on disk so restarts do not re-spam.
 * User-initiated /gmailauth is always allowed and is the only way to get a
 * fresh link after the one automatic notice.
 */
const REAUTH_PROMPT_STATE_PATH = resolve(STORE_DIR, 'google-reauth-notified.json')

type ReauthPromptState = Record<
  string,
  { notifiedAt: number; error?: string }
>

function loadReauthPromptState(): ReauthPromptState {
  try {
    if (!existsSync(REAUTH_PROMPT_STATE_PATH)) return {}
    return JSON.parse(readFileSync(REAUTH_PROMPT_STATE_PATH, 'utf-8')) as ReauthPromptState
  } catch {
    return {}
  }
}

function saveReauthPromptState(state: ReauthPromptState): void {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    const tmp = `${REAUTH_PROMPT_STATE_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(tmp, REAUTH_PROMPT_STATE_PATH)
  } catch (err) {
    logger.warn({ err }, 'Could not persist Google re-auth notify state')
  }
}

function wasReauthAlreadyNotified(account: string): boolean {
  const state = loadReauthPromptState()
  return Boolean(state[account]?.notifiedAt)
}

function markReauthNotified(account: string, error?: string): void {
  const state = loadReauthPromptState()
  state[account] = { notifiedAt: Date.now(), error: error?.slice(0, 200) }
  saveReauthPromptState(state)
}

function buildReauthPromptMessage(
  account: 'personal' | 'work',
  chatId?: string
): string {
  try {
    const { url, redirectUri, email } = createGoogleAuthUrl(account, chatId)
    return (
      `⚠️ Google "${account}" expired — re-auth needed (one-time notice)\n\n` +
      `Must sign in as: ${email}\n` +
      `Tap this short link:\n${url}\n\n` +
      `You'll bounce to Google, pick ${email}, approve, then get ✅ here.\n\n` +
      `I will not ask again until this is fixed. When you want a new link later, send:\n` +
      `/gmailauth ${account}\n\n` +
      `If redirect_uri_mismatch, add in Google Cloud → Credentials:\n${redirectUri}\n\n` +
      `To stop weekly expiry: OAuth consent screen → Publish to Production.`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return (
      `⚠️ Google "${account}" expired (${msg}).\n` +
      `Send once when ready: /gmailauth ${account}\n` +
      `(No further automatic prompts.)`
    )
  }
}

/**
 * Background keeper: refresh access tokens only. NEVER pings Telegram.
 *
 * History: we used to auto-DM re-auth links (even "once per day"), but restarts
 * and dual personal/work accounts still felt like hourly spam. Policy now:
 *   - Silent refresh when tokens are still valid
 *   - On dead refresh tokens: log only
 *   - User opts in with /gmailauth when they want a link
 *
 * `notify` is accepted for API compatibility but intentionally ignored.
 * Set GOOGLE_REAUTH_AUTO_NOTIFY=1 to re-enable the one-shot disk-backed DM.
 */
export function startGoogleTokenKeeper(
  notify?: (message: string) => void | Promise<void>,
  opts?: { chatId?: string }
): NodeJS.Timeout {
  const INTERVAL_MS = 6 * 60 * 60 * 1000 // every 6 hours — silent refresh only
  const chatId = opts?.chatId
  const autoNotify =
    process.env['GOOGLE_REAUTH_AUTO_NOTIFY'] === '1' ||
    process.env['GOOGLE_REAUTH_AUTO_NOTIFY'] === 'true'

  const run = async () => {
    try {
      const results = await refreshAllGoogleAccounts()
      for (const r of results) {
        if (r.ok) {
          // Healthy again → allow a future one-shot if auto-notify is ever re-enabled
          clearGoogleReauthPromptData(r.account)
          logger.info({ account: r.account, exp: r.accessExpiresAt }, 'Google auth healthy')
          continue
        }

        if (r.needsReauth) {
          logger.warn(
            { account: r.account, err: r.error, autoNotify },
            'Google needs re-auth (no Telegram ping unless GOOGLE_REAUTH_AUTO_NOTIFY=1 and never-notified)'
          )
          if (!autoNotify || !notify) continue
          const acc = normalizeAccount(r.account)
          if (wasReauthAlreadyNotified(acc)) {
            logger.info(
              { account: acc },
              'Skipping re-auth prompt (already notified once — wait for /gmailauth)'
            )
            continue
          }
          const msg = buildReauthPromptMessage(acc, chatId)
          await notify(msg)
          markReauthNotified(acc, r.error)
          logger.info({ account: acc }, 'Sent one-time Google re-auth notice (opt-in)')
          continue
        }

        logger.warn({ account: r.account, err: r.error }, 'Google auth check failed')
      }
    } catch (err) {
      logger.warn({ err }, 'Google token keeper failed')
    }
  }

  // Silent refresh soon after boot, then on interval — no user-facing spam
  setTimeout(() => void run(), 15_000)
  return setInterval(() => void run(), INTERVAL_MS)
}

/** Call after a successful /gmailauth so the next real expiry can prompt once again. */
export function clearGoogleReauthPromptData(account?: AccountName): void {
  if (account) {
    const state = loadReauthPromptState()
    const key = normalizeAccount(account)
    if (state[key]) {
      delete state[key]
      saveReauthPromptState(state)
    }
  } else {
    try {
      if (existsSync(REAUTH_PROMPT_STATE_PATH)) {
        writeFileSync(REAUTH_PROMPT_STATE_PATH, '{}', { mode: 0o600 })
      }
    } catch { /* ignore */ }
  }
}

/** Test/helper: has the keeper already sent the one-shot re-auth DM for this account? */
export function hasGoogleReauthBeenNotified(account: AccountName): boolean {
  return wasReauthAlreadyNotified(normalizeAccount(account))
}
