import { describe, it, expect } from 'vitest'
import {
  clipMemoryContent,
  formatMemoryBlock,
  MEMORY_LINE_MAX,
  MEMORY_BLOCK_MAX,
} from './memory.js'

describe('clipMemoryContent', () => {
  it('leaves short text alone', () => {
    expect(clipMemoryContent('hello world')).toBe('hello world')
  })

  it('collapses whitespace and truncates long dumps', () => {
    const huge = 'word '.repeat(500)
    const out = clipMemoryContent(huge)
    expect(out.length).toBeLessThanOrEqual(MEMORY_LINE_MAX)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/\n/)
  })
})

describe('formatMemoryBlock', () => {
  it('returns empty for no items', () => {
    expect(formatMemoryBlock([])).toBe('')
  })

  it('formats clipped lines under the block budget', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      content: `Memory number ${i}: ${'x'.repeat(800)}`,
      sector: i % 2 === 0 ? 'semantic' : 'episodic',
    }))
    const block = formatMemoryBlock(items)
    expect(block.startsWith('[Memory context]\n')).toBe(true)
    expect(block.length).toBeLessThanOrEqual(MEMORY_BLOCK_MAX)
    // Must not include the full 800-char payloads
    expect(block).not.toContain('x'.repeat(500))
  })

  it('includes sector labels', () => {
    const block = formatMemoryBlock([{ content: 'I prefer dark mode', sector: 'semantic' }])
    expect(block).toContain('(semantic)')
    expect(block).toContain('I prefer dark mode')
  })
})
