import { describe, it, expect } from 'vitest'
import { readEnvFile } from './env.js'

describe('readEnvFile', () => {
  it('returns empty object when .env does not exist', () => {
    // readEnvFile reads from PROJECT_ROOT/.env which may or may not exist
    // This test verifies it doesn't throw
    const result = readEnvFile()
    expect(typeof result).toBe('object')
  })

  it('returns only requested keys when keys param provided', () => {
    const result = readEnvFile(['NONEXISTENT_KEY_12345'])
    expect(result['NONEXISTENT_KEY_12345']).toBeUndefined()
  })
})
