import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = resolve(__dirname, '..', '.env')

export function readEnvFile(keys?: string[]): Record<string, string> {
  let raw: string
  try {
    raw = readFileSync(ENV_PATH, 'utf-8')
  } catch {
    return {}
  }

  const result: Record<string, string> = {}

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue

    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (keys && !keys.includes(key)) continue
    result[key] = value
  }

  return result
}
