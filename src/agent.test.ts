import { describe, it, expect } from 'vitest'
import { isStaleSessionError } from './agent.js'

describe('isStaleSessionError', () => {
  it('flags ENOENT', () => {
    expect(isStaleSessionError(new Error('ENOENT: no such file or directory'))).toBe(true)
  })

  it('flags "no such file" without errno', () => {
    expect(isStaleSessionError(new Error('open failed: no such file'))).toBe(true)
  })

  it('flags "session not found" combined message', () => {
    expect(isStaleSessionError(new Error('agent: session abc123 not found on resume'))).toBe(true)
  })

  it('treats raw strings the same as Error.message', () => {
    expect(isStaleSessionError('ENOENT while opening session')).toBe(true)
  })

  it('does NOT flag a generic SDK timeout', () => {
    expect(isStaleSessionError(new Error('Request timed out after 1800000ms'))).toBe(false)
  })

  it('does NOT flag an exit-code crash from the subprocess', () => {
    // This is the EROFS-on-debug-log crash mode that prompted the test:
    // it's a process-exit failure, not a stale-session failure, so we must
    // NOT treat it as "stale session, retry". Otherwise the retry would loop.
    expect(
      isStaleSessionError(new Error('Claude Code process exited with code 1'))
    ).toBe(false)
  })

  it('does NOT flag EROFS itself as a stale session', () => {
    expect(
      isStaleSessionError(new Error("EROFS: read-only file system, open '/home/user/.claude/debug/abc.txt'"))
    ).toBe(false)
  })

  it('does NOT flag the word "session" on its own', () => {
    expect(isStaleSessionError(new Error('starting session for chat'))).toBe(false)
  })
})
