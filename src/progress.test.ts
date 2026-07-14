import { describe, it, expect, vi } from 'vitest'
import { createTelegramProgress, progressBar } from './progress.js'

describe('progressBar', () => {
  it('renders full and empty ends', () => {
    expect(progressBar(0, 10)).toBe('░'.repeat(10))
    expect(progressBar(1, 10)).toBe('▓'.repeat(10))
  })
})

describe('createTelegramProgress', () => {
  it('sends only one status message when start+thinking race', async () => {
    let nextId = 1
    const sends: string[] = []
    const edits: Array<{ id: number; text: string }> = []

    // Slow first send so concurrent reports both enter ensureMessage
    let resolveSend!: (v: { message_id: number }) => void
    const firstSend = new Promise<{ message_id: number }>((r) => {
      resolveSend = r
    })
    let sendCount = 0

    const api = {
      sendMessage: vi.fn(async (_chat: unknown, text: string) => {
        sendCount++
        sends.push(text)
        if (sendCount === 1) {
          // Hold the first send open until both reports have fired
          return firstSend
        }
        return { message_id: nextId++ }
      }),
      editMessageText: vi.fn(async (_c: unknown, id: number, text: string) => {
        edits.push({ id, text })
      }),
      deleteMessage: vi.fn(async () => {}),
    }

    const progress = createTelegramProgress(api, 42, 'grok/grok-4.5')
    progress.report({ phase: 'start', loop: 0, maxLoops: 20, toolsDone: 0 })
    progress.report({ phase: 'thinking', loop: 1, maxLoops: 20, toolsDone: 0 })

    // Allow microtasks to queue both ensureMessage calls
    await Promise.resolve()
    await Promise.resolve()

    expect(api.sendMessage).toHaveBeenCalledTimes(1)

    resolveSend({ message_id: 99 })
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    // Give the chained doEdit a tick
    await new Promise((r) => setTimeout(r, 20))

    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    await progress.finish('done')
    expect(api.deleteMessage).toHaveBeenCalledWith(42, 99)
  })

  it('renders a single activity line (no double thinking spinner on title)', async () => {
    const texts: string[] = []
    const api = {
      sendMessage: vi.fn(async (_c: unknown, text: string) => {
        texts.push(text)
        return { message_id: 1 }
      }),
      editMessageText: vi.fn(async (_c: unknown, _id: number, text: string) => {
        texts.push(text)
      }),
      deleteMessage: vi.fn(async () => {}),
    }
    const progress = createTelegramProgress(api, 1, 'grok/test')
    progress.report({ phase: 'thinking', loop: 1, maxLoops: 20 })
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalled())
    const body = texts[0] ?? ''
    // Title line is model · elapsed only (no spinner prefix)
    expect(body.split('\n')[0]).toMatch(/^grok\/test · /)
    // Exactly one "thinking" occurrence
    expect((body.match(/thinking/gi) ?? []).length).toBe(1)
    await progress.finish('done')
  })
})
