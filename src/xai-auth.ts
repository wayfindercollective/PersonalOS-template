/**
 * xAI / Grok auth for PersonalOS (monthly plan OAuth).
 *
 * Sources (first match wins):
 *   1. XAI_API_KEY env — long-lived console key (optional; not required for plan use)
 *   2. ~/.grok/auth.json — Grok CLI OAuth (access + refresh tokens)
 *
 * Auto-refresh:
 *   Access tokens last ~6 hours. When within EARLY_REFRESH_SECS of expiry (or
 *   already expired), we call https://auth.x.ai/oauth2/token with grant_type=
 *   refresh_token and write the new tokens back to auth.json.
 *
 * Device login (Telegram):
 *   startGrokDeviceLogin() → user opens verification_uri and enters user_code
 *   pollGrokDeviceLogin() until authorized, then persist tokens.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readEnvFile } from './env.js'
import { logger } from './logger.js'

const env = readEnvFile()

export const XAI_API_BASE = (env['XAI_API_BASE'] ?? 'https://api.x.ai/v1').replace(/\/$/, '')
export const XAI_AUTH_ISSUER = (env['XAI_AUTH_ISSUER'] ?? 'https://auth.x.ai').replace(/\/$/, '')
export const XAI_TOKEN_URL = `${XAI_AUTH_ISSUER}/oauth2/token`
export const XAI_DEVICE_CODE_URL = `${XAI_AUTH_ISSUER}/oauth2/device/code`
/**
 * Default Grok model id. Prefer a concrete id from XAI_MODEL in .env.
 * Special values:
 *   - unset / "latest" / "auto" → resolved at first use via listXaiModels()
 *     (picks highest versioned grok chat model; falls back to grok-4.5)
 */
export const XAI_MODEL_ENV = (env['XAI_MODEL'] ?? 'latest').trim()
export const XAI_DEFAULT_MODEL =
  !XAI_MODEL_ENV || XAI_MODEL_ENV === 'latest' || XAI_MODEL_ENV === 'auto'
    ? 'latest'
    : XAI_MODEL_ENV
export const XAI_TIMEOUT_MS = Number(env['XAI_TIMEOUT_MS'] ?? 600_000)

/** Fallback when the models list is unreachable. */
const XAI_FALLBACK_MODEL = 'grok-4.5'
let resolvedLatestGrok: string | null = null

/** Refresh this many seconds before JWT exp (default 5 min). */
const EARLY_REFRESH_SECS = Number(env['XAI_AUTH_EARLY_REFRESH_SECS'] ?? 300)

/** Default public Grok CLI client id (from auth.json account key suffix). */
const DEFAULT_CLIENT_ID = env['XAI_OAUTH_CLIENT_ID'] ?? 'b1a00492-073a-47ea-816f-4c329264a828'

const GROK_AUTH_PATHS = [
  env['GROK_AUTH_PATH'] ?? '',
  join(homedir(), '.grok', 'auth.json'),
].filter(Boolean)

export type XaiAuthSource = 'env' | 'grok-cli-oauth' | 'none'

export interface XaiCredentials {
  token: string
  source: XaiAuthSource
  email?: string
  expiresAt?: string
  modelDefault: string
  refreshed?: boolean
}

interface GrokAuthEntry {
  key?: string
  refresh_token?: string
  expires_at?: string
  email?: string
  auth_mode?: string
  oidc_client_id?: string
  user_id?: string
  first_name?: string
  create_time?: string
  [k: string]: unknown
}

interface AuthFileState {
  path: string
  accountKey: string
  entry: GrokAuthEntry
  raw: Record<string, GrokAuthEntry>
}

// Serialize refresh so concurrent Grok tool calls don't race-write auth.json
let refreshLock: Promise<void> = Promise.resolve()

function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = refreshLock
  let release!: () => void
  refreshLock = new Promise<void>((r) => {
    release = r
  })
  return prev
    .catch(() => {})
    .then(fn)
    .finally(() => release())
}

function findAuthPath(): string {
  for (const p of GROK_AUTH_PATHS) {
    if (existsSync(p)) return p
  }
  // Prefer home path for new writes
  return join(homedir(), '.grok', 'auth.json')
}

function readAuthFile(): AuthFileState | null {
  for (const p of GROK_AUTH_PATHS) {
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, GrokAuthEntry>
      const entries = Object.entries(raw).filter(([, v]) => v && typeof v === 'object' && (v.key || v.refresh_token))
      if (entries.length === 0) continue
      entries.sort((a, b) => {
        const ea = a[1].expires_at ? Date.parse(a[1].expires_at) : 0
        const eb = b[1].expires_at ? Date.parse(b[1].expires_at) : 0
        return eb - ea
      })
      const [accountKey, entry] = entries[0]
      return { path: p, accountKey, entry, raw }
    } catch (err) {
      logger.warn({ err, path: p }, 'Failed to parse Grok auth.json')
    }
  }
  return null
}

function jwtExp(token: string): number | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8')) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

function needsRefresh(token: string, expiresAtField?: string): boolean {
  const expJwt = jwtExp(token)
  if (expJwt != null) {
    return expJwt <= Date.now() / 1000 + EARLY_REFRESH_SECS
  }
  if (expiresAtField) {
    const t = Date.parse(expiresAtField)
    if (!Number.isNaN(t)) return t <= Date.now() + EARLY_REFRESH_SECS * 1000
  }
  return false
}

function persistAuthUpdate(
  state: AuthFileState,
  update: { access_token: string; refresh_token?: string; expires_in?: number }
): void {
  const entry = { ...state.entry }
  entry.key = update.access_token
  if (update.refresh_token) entry.refresh_token = update.refresh_token
  if (update.expires_in && update.expires_in > 0) {
    entry.expires_at = new Date(Date.now() + update.expires_in * 1000).toISOString()
  } else {
    const exp = jwtExp(update.access_token)
    if (exp) entry.expires_at = new Date(exp * 1000).toISOString()
  }
  const next = { ...state.raw, [state.accountKey]: entry }
  const path = state.path
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
  logger.info({ path, expiresAt: entry.expires_at }, 'Grok OAuth tokens refreshed and saved')
}

/**
 * Exchange refresh_token for a new access_token (and rotated refresh_token).
 * @param force When true, refresh even if the access token is still valid.
 */
export async function refreshGrokAccessToken(
  force = false
): Promise<{ ok: true; expiresAt?: string; skipped?: boolean } | { ok: false; error: string }> {
  return withRefreshLock(async () => {
    const state = readAuthFile()
    if (!state?.entry.refresh_token) {
      return { ok: false, error: 'No refresh_token in ~/.grok/auth.json — run /groklogin or: grok login --oauth' }
    }

    // Re-check after waiting on lock — another caller may have refreshed
    const fresh = readAuthFile()
    if (
      !force &&
      fresh?.entry.key &&
      !needsRefresh(fresh.entry.key, fresh.entry.expires_at)
    ) {
      return { ok: true, expiresAt: fresh.entry.expires_at, skipped: true }
    }

    const clientId = fresh?.entry.oidc_client_id || state.entry.oidc_client_id || DEFAULT_CLIENT_ID
    const refreshToken = fresh?.entry.refresh_token || state.entry.refresh_token!

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    })

    try {
      const res = await fetch(XAI_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'PersonalOS-personalos/1.0',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      })
      const text = await res.text()
      if (!res.ok) {
        logger.warn({ status: res.status, body: text.slice(0, 300) }, 'Grok token refresh failed')
        return {
          ok: false,
          error: `Refresh failed HTTP ${res.status}. Re-auth: /groklogin or grok login --oauth. ${text.slice(0, 120)}`,
        }
      }
      const data = JSON.parse(text) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }
      if (!data.access_token) {
        return { ok: false, error: 'Refresh response missing access_token' }
      }
      const target = fresh ?? state
      persistAuthUpdate(target, {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
      })
      const again = readAuthFile()
      return { ok: true, expiresAt: again?.entry.expires_at }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Refresh error: ${msg}` }
    }
  })
}

/**
 * Resolve a Bearer token, auto-refreshing OAuth when near expiry.
 */
export async function resolveXaiCredentials(): Promise<XaiCredentials> {
  const envKey = (env['XAI_API_KEY'] ?? process.env.XAI_API_KEY ?? '').trim()
  if (envKey) {
    return { token: envKey, source: 'env', modelDefault: XAI_DEFAULT_MODEL }
  }

  let state = readAuthFile()
  if (!state?.entry.key && !state?.entry.refresh_token) {
    return { token: '', source: 'none', modelDefault: XAI_DEFAULT_MODEL }
  }

  let refreshed = false
  if (!state.entry.key || needsRefresh(state.entry.key, state.entry.expires_at)) {
    if (state.entry.refresh_token) {
      const result = await refreshGrokAccessToken()
      if (result.ok) {
        refreshed = true
        state = readAuthFile() ?? state
      } else {
        // If we still have a non-expired token, use it; else fail empty
        if (!state.entry.key || needsRefresh(state.entry.key, state.entry.expires_at)) {
          logger.warn({ err: result.error }, 'Grok OAuth refresh failed and access token unusable')
          return {
            token: '',
            source: 'none',
            modelDefault: XAI_DEFAULT_MODEL,
          }
        }
      }
    }
  }

  state = readAuthFile()
  if (!state?.entry.key) {
    return { token: '', source: 'none', modelDefault: XAI_DEFAULT_MODEL }
  }

  return {
    token: state.entry.key,
    source: 'grok-cli-oauth',
    email: state.entry.email,
    expiresAt: state.entry.expires_at,
    modelDefault: XAI_DEFAULT_MODEL,
    refreshed,
  }
}

export function describeXaiAuth(): string {
  const envKey = (env['XAI_API_KEY'] ?? process.env.XAI_API_KEY ?? '').trim()
  if (envKey) return 'XAI_API_KEY (env)'
  const state = readAuthFile()
  if (state?.entry.key || state?.entry.refresh_token) {
    const exp = state.entry.expires_at ? ` exp ${state.entry.expires_at.slice(0, 19)}` : ''
    const left = (() => {
      if (!state.entry.key) return ' (no access token — will refresh)'
      const expJwt = jwtExp(state.entry.key)
      if (expJwt == null) return ''
      const mins = Math.round((expJwt - Date.now() / 1000) / 60)
      return mins > 0 ? ` (~${mins}m left)` : ' (expired — will auto-refresh)'
    })()
    return `Grok plan OAuth${state.entry.email ? ` (${state.entry.email})` : ''}${exp}${left}`
  }
  return 'not configured — /groklogin or: grok login --oauth'
}

export async function isXaiAvailable(): Promise<boolean> {
  const c = await resolveXaiCredentials()
  if (!c.token) return false
  try {
    const res = await fetch(`${XAI_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401) {
      // one forced refresh + retry
      const r = await refreshGrokAccessToken()
      if (!r.ok) return false
      const c2 = await resolveXaiCredentials()
      if (!c2.token) return false
      const res2 = await fetch(`${XAI_API_BASE}/models`, {
        headers: { Authorization: `Bearer ${c2.token}` },
        signal: AbortSignal.timeout(10_000),
      })
      return res2.ok
    }
    return res.ok
  } catch {
    return false
  }
}

export async function listXaiModels(): Promise<string[]> {
  const c = await resolveXaiCredentials()
  if (!c.token) return []
  try {
    const res = await fetch(`${XAI_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id: string }> }
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => id.startsWith('grok') && !id.includes('imagine') && !id.includes('video'))
  } catch {
    return []
  }
}

/**
 * Score a grok model id so higher versions rank first.
 * e.g. grok-4.5 > grok-4 > grok-3-mini (chat-y non-mini preferred slightly).
 */
function scoreGrokModelId(id: string): number {
  const lower = id.toLowerCase()
  // Skip image/video (already filtered) and heavily specialized IDs last
  let score = 0
  const ver = lower.match(/grok-(\d+(?:\.\d+)?)/)
  if (ver) score += parseFloat(ver[1]) * 1000
  if (lower.includes('mini') || lower.includes('fast') || lower.includes('lite')) score -= 50
  if (lower.includes('reasoning') || lower.includes('code')) score += 5
  // Prefer shorter product names (grok-4.5 over grok-4.5-preview-...)
  score -= Math.min(lower.length, 40)
  return score
}

/** Pick the "latest" chat-oriented Grok model from a list, or fallback. */
export function pickLatestGrokModel(ids: string[]): string {
  if (ids.length === 0) return XAI_FALLBACK_MODEL
  const ranked = [...ids].sort((a, b) => scoreGrokModelId(b) - scoreGrokModelId(a))
  return ranked[0] ?? XAI_FALLBACK_MODEL
}

/**
 * Resolve XAI_DEFAULT_MODEL when it is "latest"/"auto".
 * Caches the first successful list result for the process lifetime.
 */
export async function resolveDefaultGrokModel(): Promise<string> {
  if (XAI_DEFAULT_MODEL !== 'latest') return XAI_DEFAULT_MODEL
  if (resolvedLatestGrok) return resolvedLatestGrok
  const ids = await listXaiModels()
  resolvedLatestGrok = pickLatestGrokModel(ids)
  logger.info({ model: resolvedLatestGrok, fromList: ids.length }, 'Resolved latest Grok model')
  return resolvedLatestGrok
}

// ── Device-code login (Telegram-friendly) ───────────────────────────────────

export interface DeviceLoginSession {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalSec: number
  expiresAt: number
  clientId: string
}

const pendingDeviceLogins = new Map<string, DeviceLoginSession>()

export async function startGrokDeviceLogin(chatId: string): Promise<
  | { ok: true; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn: number }
  | { ok: false; error: string }
> {
  const clientId = readAuthFile()?.entry.oidc_client_id || DEFAULT_CLIENT_ID
  const body = new URLSearchParams({
    client_id: clientId,
    scope: 'openid profile email offline_access api:access grok-cli:access',
  })
  try {
    const res = await fetch(XAI_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, error: `Device auth start failed HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    const data = JSON.parse(text) as {
      device_code: string
      user_code: string
      verification_uri: string
      verification_uri_complete?: string
      expires_in: number
      interval?: number
    }
    const session: DeviceLoginSession = {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      intervalSec: Math.max(3, data.interval ?? 5),
      expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
      clientId,
    }
    pendingDeviceLogins.set(chatId, session)
    return {
      ok: true,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      expiresIn: data.expires_in ?? 900,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Poll until the user completes device login, or return pending/error.
 * Call repeatedly (or use pollGrokDeviceLoginUntilDone).
 */
export async function pollGrokDeviceLoginOnce(chatId: string): Promise<
  | { status: 'pending' }
  | { status: 'slow_down'; intervalSec: number }
  | { status: 'done'; expiresAt?: string }
  | { status: 'error'; error: string }
> {
  const session = pendingDeviceLogins.get(chatId)
  if (!session) return { status: 'error', error: 'No pending login. Send /groklogin first.' }
  if (Date.now() > session.expiresAt) {
    pendingDeviceLogins.delete(chatId)
    return { status: 'error', error: 'Login code expired. Send /groklogin again.' }
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: session.deviceCode,
    client_id: session.clientId,
  })

  try {
    const res = await fetch(XAI_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    let data: Record<string, unknown> = {}
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      data = { error: text }
    }

    if (res.ok && data.access_token) {
      // Persist into auth.json (create file/entry if needed)
      const path = findAuthPath()
      let raw: Record<string, GrokAuthEntry> = {}
      if (existsSync(path)) {
        try {
          raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, GrokAuthEntry>
        } catch { /* empty */ }
      }
      const accountKey = `https://auth.x.ai::${session.clientId}`
      const prev = raw[accountKey] ?? {}
      const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 21600
      const entry: GrokAuthEntry = {
        ...prev,
        key: String(data.access_token),
        refresh_token: data.refresh_token ? String(data.refresh_token) : prev.refresh_token,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        auth_mode: 'oidc',
        oidc_client_id: session.clientId,
      }
      raw[accountKey] = entry
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 })
      renameSync(tmp, path)
      pendingDeviceLogins.delete(chatId)
      logger.info({ path, expiresAt: entry.expires_at }, 'Grok device login saved')
      return { status: 'done', expiresAt: entry.expires_at }
    }

    const err = String(data.error ?? '')
    if (err === 'authorization_pending') return { status: 'pending' }
    if (err === 'slow_down') {
      session.intervalSec = Math.min(30, session.intervalSec + 5)
      return { status: 'slow_down', intervalSec: session.intervalSec }
    }
    if (err === 'expired_token' || err === 'access_denied') {
      pendingDeviceLogins.delete(chatId)
      return { status: 'error', error: err === 'access_denied' ? 'Login denied.' : 'Code expired. /groklogin again.' }
    }
    return { status: 'error', error: `Login poll: ${err || text.slice(0, 120)}` }
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function pollGrokDeviceLoginUntilDone(
  chatId: string,
  onTick?: (msg: string) => void
): Promise<{ ok: true; expiresAt?: string } | { ok: false; error: string }> {
  const session = pendingDeviceLogins.get(chatId)
  if (!session) return { ok: false, error: 'No pending login' }

  while (Date.now() < session.expiresAt) {
    const result = await pollGrokDeviceLoginOnce(chatId)
    if (result.status === 'done') return { ok: true, expiresAt: result.expiresAt }
    if (result.status === 'error') return { ok: false, error: result.error }
    const wait = (result.status === 'slow_down' ? result.intervalSec : session.intervalSec) * 1000
    onTick?.('Waiting for you to finish sign-in in the browser…')
    await new Promise((r) => setTimeout(r, wait))
  }
  pendingDeviceLogins.delete(chatId)
  return { ok: false, error: 'Login timed out. Send /groklogin again.' }
}

/** Sync helper used by describe-only paths that can't await (avoid in hot path). */
export function getGrokAuthSnapshot(): {
  hasAccess: boolean
  hasRefresh: boolean
  expiresAt?: string
  minutesLeft?: number
  email?: string
} {
  const state = readAuthFile()
  if (!state) return { hasAccess: false, hasRefresh: false }
  const exp = state.entry.key ? jwtExp(state.entry.key) : null
  return {
    hasAccess: Boolean(state.entry.key),
    hasRefresh: Boolean(state.entry.refresh_token),
    expiresAt: state.entry.expires_at,
    minutesLeft: exp != null ? Math.round((exp - Date.now() / 1000) / 60) : undefined,
    email: state.entry.email,
  }
}
