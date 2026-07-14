import { describe, it, expect } from 'vitest'
import { pickAssistantContent } from './lmstudio.js'

describe('pickAssistantContent', () => {
  it('returns the content when both fields are populated', () => {
    const out = pickAssistantContent({ content: 'hello', reasoning_content: 'thinking...' })
    expect(out).toEqual({ content: 'hello', usedReasoningFallback: false })
  })

  it('returns the content alone when reasoning_content is absent', () => {
    const out = pickAssistantContent({ content: 'hello' })
    expect(out).toEqual({ content: 'hello', usedReasoningFallback: false })
  })

  it('falls back to reasoning_content when content is an empty string', () => {
    // This is the regression: Qwen 3.5 397B at low max_tokens exhausts the
    // budget on reasoning and emits content="". Without the fallback the
    // user sees a blank reply.
    const out = pickAssistantContent({ content: '', reasoning_content: 'OK' })
    expect(out).toEqual({ content: 'OK', usedReasoningFallback: true })
  })

  it('falls back to reasoning_content when content is null', () => {
    const out = pickAssistantContent({ content: null, reasoning_content: 'OK' })
    expect(out).toEqual({ content: 'OK', usedReasoningFallback: true })
  })

  it('falls back to reasoning_content when content is missing entirely', () => {
    const out = pickAssistantContent({ reasoning_content: 'OK' })
    expect(out).toEqual({ content: 'OK', usedReasoningFallback: true })
  })

  it('returns null content when both fields are empty/null', () => {
    const out = pickAssistantContent({ content: null, reasoning_content: null })
    expect(out).toEqual({ content: null, usedReasoningFallback: false })
  })

  it('returns null content when both fields are absent', () => {
    const out = pickAssistantContent({})
    expect(out).toEqual({ content: null, usedReasoningFallback: false })
  })

  it('does NOT fall back when reasoning_content is an empty string', () => {
    // An empty reasoning trace shouldn't be promoted to the user-facing reply.
    const out = pickAssistantContent({ content: '', reasoning_content: '' })
    expect(out).toEqual({ content: '', usedReasoningFallback: false })
  })
})
