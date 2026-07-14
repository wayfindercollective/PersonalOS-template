import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR, UPLOADS_DIR } from './config.js'
import { logger } from './logger.js'

// ============================================================
// Persistent browser engine
// Profile-based Playwright contexts with cookie/session persistence
// ============================================================

const PROFILES_DIR = join(STORE_DIR, 'browser-profiles')
const SCREENSHOTS_DIR = join(UPLOADS_DIR, 'screenshots')

const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
const NAV_TIMEOUT = 30_000
const MAX_TEXT_LENGTH = 16_000

let browser: Browser | null = null
const contexts = new Map<string, BrowserContext>()
const pages = new Map<string, Page>()

// Mutex per profile -- one operation at a time
const locks = new Map<string, Promise<void>>()

function withLock<T>(profile: string, fn: () => Promise<T>): Promise<T> {
  let release: () => void
  const prev = locks.get(profile) ?? Promise.resolve()
  const next = new Promise<void>((resolve) => { release = resolve })
  locks.set(profile, next)
  return prev.then(fn).finally(() => release!())
}

// ============================================================
// Lifecycle
// ============================================================

export async function initBrowser(): Promise<void> {
  if (browser?.isConnected()) return

  mkdirSync(PROFILES_DIR, { recursive: true })
  mkdirSync(SCREENSHOTS_DIR, { recursive: true })

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    })
    logger.info('Browser engine started (Chromium)')
  } catch (err) {
    logger.warn({ err }, 'Browser engine failed to start -- browser tools will be unavailable. Run: npx playwright install')
    browser = null
  }
}

export async function closeBrowser(): Promise<void> {
  for (const [name, ctx] of contexts) {
    try { await ctx.close() } catch { /* ignore */ }
    contexts.delete(name)
    pages.delete(name)
  }
  if (browser) {
    try { await browser.close() } catch { /* ignore */ }
    browser = null
  }
  logger.info('Browser engine stopped')
}

// ============================================================
// Profile management
// ============================================================

async function getContext(profile: string): Promise<BrowserContext> {
  if (contexts.has(profile)) {
    const ctx = contexts.get(profile)!
    // Check if still usable
    try {
      await ctx.pages()
      return ctx
    } catch {
      contexts.delete(profile)
      pages.delete(profile)
    }
  }

  // Persistent contexts launch their own browser, so we don't need the shared instance.
  // But check that Playwright is working at all.

  const profileDir = join(PROFILES_DIR, profile)
  mkdirSync(profileDir, { recursive: true })

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: DEFAULT_VIEWPORT,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  })

  contexts.set(profile, ctx)
  logger.info({ profile }, 'Browser context created')
  return ctx
}

async function getPage(profile: string): Promise<Page> {
  const existing = pages.get(profile)
  if (existing && !existing.isClosed()) return existing

  const ctx = await getContext(profile)
  const allPages = ctx.pages()
  const page = allPages.length > 0 ? allPages[0] : await ctx.newPage()
  pages.set(profile, page)
  return page
}

export function listProfiles(): string[] {
  if (!existsSync(PROFILES_DIR)) return []
  const { readdirSync } = require('node:fs')
  return (readdirSync(PROFILES_DIR) as string[]).filter((f: string) => {
    try {
      return require('node:fs').statSync(join(PROFILES_DIR, f)).isDirectory()
    } catch { return false }
  })
}

// ============================================================
// Browser actions
// ============================================================

export async function navigateTo(url: string, profile = 'default'): Promise<string> {
  return withLock(profile, async () => {
    const page = await getPage(profile)
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
    const text = await page.innerText('body').catch(() => '')
    const title = await page.title().catch(() => '')
    const truncated = text.slice(0, MAX_TEXT_LENGTH)
    const suffix = text.length > MAX_TEXT_LENGTH ? '\n... (truncated)' : ''
    return `[${title}] ${page.url()}\n\n${truncated}${suffix}`
  })
}

export async function clickElement(selector: string, profile = 'default'): Promise<string> {
  return withLock(profile, async () => {
    const page = await getPage(profile)

    // Support text:="visible text" shorthand
    const textMatch = selector.match(/^text:="(.+)"$/)
    const locator = textMatch
      ? page.getByText(textMatch[1], { exact: false })
      : page.locator(selector)

    await locator.first().click({ timeout: 10_000 })

    // Wait for navigation or content change
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})

    const text = await page.innerText('body').catch(() => '')
    const title = await page.title().catch(() => '')
    const truncated = text.slice(0, MAX_TEXT_LENGTH)
    const suffix = text.length > MAX_TEXT_LENGTH ? '\n... (truncated)' : ''
    return `Clicked. Now on: [${title}] ${page.url()}\n\n${truncated}${suffix}`
  })
}

export async function fillField(selector: string, value: string, profile = 'default'): Promise<string> {
  return withLock(profile, async () => {
    const page = await getPage(profile)
    const locator = page.locator(selector)
    await locator.first().fill(value, { timeout: 10_000 })
    return `Filled "${selector}" with ${value.length} characters.`
  })
}

export async function pressKey(key: string, profile = 'default'): Promise<string> {
  return withLock(profile, async () => {
    const page = await getPage(profile)
    await page.keyboard.press(key)
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
    return `Pressed "${key}".`
  })
}

export async function takeScreenshot(profile = 'default', fullPage = false): Promise<string> {
  return withLock(profile, async () => {
    const page = await getPage(profile)
    const filename = `${Date.now()}_${profile}.png`
    const filepath = join(SCREENSHOTS_DIR, filename)
    await page.screenshot({ path: filepath, fullPage })
    logger.info({ profile, filepath }, 'Screenshot taken')
    return filepath
  })
}

export async function getPageContent(profile = 'default'): Promise<string> {
  return withLock(profile, async () => {
    const page = await getPage(profile)
    const text = await page.innerText('body').catch(() => '')
    const title = await page.title().catch(() => '')
    const truncated = text.slice(0, MAX_TEXT_LENGTH)
    const suffix = text.length > MAX_TEXT_LENGTH ? '\n... (truncated)' : ''
    return `[${title}] ${page.url()}\n\n${truncated}${suffix}`
  })
}

export async function getPageUrl(profile = 'default'): Promise<string> {
  const page = await getPage(profile)
  return page.url()
}
