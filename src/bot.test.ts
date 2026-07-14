import { describe, it, expect } from 'vitest'
import { formatForTelegram, splitMessage, buildTextReplyMessage } from './bot.js'

describe('formatForTelegram', () => {
  it('converts bold markdown', () => {
    expect(formatForTelegram('**hello**')).toBe('<b>hello</b>')
  })

  it('converts italic markdown', () => {
    expect(formatForTelegram('*hello*')).toBe('<i>hello</i>')
  })

  it('converts inline code', () => {
    expect(formatForTelegram('use `npm install`')).toBe(
      'use <code>npm install</code>'
    )
  })

  it('converts code blocks', () => {
    const input = '```js\nconsole.log("hi")\n```'
    const result = formatForTelegram(input)
    expect(result).toContain('<pre>')
    expect(result).toContain('console.log')
  })

  it('converts headings to bold', () => {
    expect(formatForTelegram('## My Heading')).toBe('<b>My Heading</b>')
  })

  it('converts strikethrough', () => {
    expect(formatForTelegram('~~deleted~~')).toBe('<s>deleted</s>')
  })

  it('converts links', () => {
    expect(formatForTelegram('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>'
    )
  })

  it('converts checkboxes', () => {
    expect(formatForTelegram('- [ ] todo')).toContain('☐')
    expect(formatForTelegram('- [x] done')).toContain('☑')
  })
})

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello')).toEqual(['hello'])
  })

  it('splits long messages on newlines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`)
    const text = lines.join('\n')
    const chunks = splitMessage(text, 500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500)
    }
  })
})

describe('buildTextReplyMessage', () => {
  it('returns null when there is no quote', () => {
    expect(buildTextReplyMessage(undefined, undefined, false, 'Alice', 'follow up')).toBeNull()
  })

  it('wraps a human reply with attribution', () => {
    const out = buildTextReplyMessage('original idea', undefined, false, 'Alice', 'expand on that')
    expect(out).toContain('[Replying to Alice]:')
    expect(out).toContain('original idea')
    expect(out).toContain('expand on that')
  })

  it('labels bot messages as PersonalOS', () => {
    const out = buildTextReplyMessage('Earlier answer about NH', undefined, true, 'PersonalOS-CB', 'what about land?')
    expect(out).toContain('[Replying to PersonalOS]:')
  })

  it('clips very long quotes', () => {
    const long = 'x'.repeat(2000)
    const out = buildTextReplyMessage(long, undefined, false, 'Alice', 'ok')!
    expect(out.length).toBeLessThan(2000)
    expect(out).toContain('…')
  })
})
