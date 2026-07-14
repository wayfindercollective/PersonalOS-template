import { describe, it, expect } from 'vitest'
import {
  normalizeClaudeModel,
  resolveTaskModel,
  DEFAULT_CLAUDE_MODEL,
  CLAUDE_SHORTCUTS,
} from './models.js'

describe('normalizeClaudeModel', () => {
  it('defaults empty / claude to opus family', () => {
    expect(normalizeClaudeModel(null)).toBe(DEFAULT_CLAUDE_MODEL)
    expect(normalizeClaudeModel(undefined)).toBe('opus')
    expect(normalizeClaudeModel('claude')).toBe('opus')
  })

  it('maps family shortcuts', () => {
    expect(normalizeClaudeModel('opus')).toBe('opus')
    expect(normalizeClaudeModel('sonnet')).toBe('sonnet')
    expect(normalizeClaudeModel('haiku')).toBe('haiku')
    expect(normalizeClaudeModel('fable')).toBe('fable')
    expect(normalizeClaudeModel('best')).toBe('best')
  })

  it('un-pins versioned Anthropic IDs to family aliases', () => {
    expect(normalizeClaudeModel('claude-opus-4-6')).toBe('opus')
    expect(normalizeClaudeModel('claude-opus-4-8')).toBe('opus')
    expect(normalizeClaudeModel('claude-sonnet-4-6')).toBe('sonnet')
    expect(normalizeClaudeModel('claude-sonnet-5')).toBe('sonnet')
    expect(normalizeClaudeModel('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(normalizeClaudeModel('claude-sonnet-5[1m]')).toBe('sonnet')
  })
})

describe('resolveTaskModel', () => {
  it('maps providers', () => {
    expect(resolveTaskModel('qwen')).toBe('lmstudio')
    expect(resolveTaskModel('grok')).toBe('grok')
    expect(resolveTaskModel('claude')).toBe(null)
    expect(resolveTaskModel(undefined)).toBe(null)
  })

  it('stores Claude families not version pins', () => {
    expect(resolveTaskModel('opus')).toBe('opus')
    expect(resolveTaskModel('sonnet')).toBe('sonnet')
    expect(resolveTaskModel('claude-sonnet-4-6')).toBe('sonnet')
  })

  it('shortcuts match CLAUDE_SHORTCUTS keys', () => {
    for (const key of Object.keys(CLAUDE_SHORTCUTS)) {
      expect(resolveTaskModel(key)).toBe(CLAUDE_SHORTCUTS[key])
    }
  })
})
