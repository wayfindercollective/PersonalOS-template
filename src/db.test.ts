import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  initDatabase,
  getSession,
  setSession,
  clearSession,
  insertMemory,
  searchMemories,
  getRecentMemories,
  getMemoryCount,
  decayAndPruneMemories,
} from './db.js'

beforeAll(() => {
  initDatabase()
})

describe('sessions', () => {
  const chatId = 'test-chat-123'

  it('returns undefined for unknown chat', () => {
    expect(getSession(chatId)).toBeUndefined()
  })

  it('stores and retrieves a session', () => {
    setSession(chatId, 'sess-abc')
    expect(getSession(chatId)).toBe('sess-abc')
  })

  it('updates existing session', () => {
    setSession(chatId, 'sess-def')
    expect(getSession(chatId)).toBe('sess-def')
  })

  it('clears a session', () => {
    clearSession(chatId)
    expect(getSession(chatId)).toBeUndefined()
  })
})

describe('memories', () => {
  const chatId = `test-mem-${Date.now()}`

  it('inserts and retrieves memories', () => {
    insertMemory(chatId, 'I prefer dark mode', 'semantic')
    insertMemory(chatId, 'We discussed the API design', 'episodic')

    const count = getMemoryCount(chatId)
    expect(count).toBe(2)
  })

  it('gets recent memories', () => {
    const recent = getRecentMemories(chatId, 5)
    expect(recent.length).toBe(2)
  })

  it('searches memories via FTS', () => {
    const results = searchMemories(chatId, 'dark mode', 3)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain('dark mode')
  })

  it('runs decay sweep without error', () => {
    expect(() => decayAndPruneMemories()).not.toThrow()
  })
})
