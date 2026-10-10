import { describe, expect, it } from 'vitest'
import { appendConsoleEntry, CONSOLE_TEXT_LIMIT, OMITTED_OUTPUT } from '../src/shared/consoleBuffer'

describe('bounded desktop console tail', () => {
  it('preserves ordinary text, entry metadata, and original buffers', () => {
    const original = [{ text: 'first', stream: 'stdout' }]
    const next = appendConsoleEntry(original, { text: 'second', stream: 'stderr' }, 5)
    expect(next).toEqual([...original, { text: 'second', stream: 'stderr' }])
    expect(original).toEqual([{ text: 'first', stream: 'stdout' }])
  })
  it('marks entry-count eviction while retaining the newest entries', () => {
    expect(appendConsoleEntry([{ text: 'first' }, { text: 'second' }], { text: 'third' }, 2)).toEqual([
      { text: OMITTED_OUTPUT + 'second' }, { text: 'third' }
    ])
  })
  it('bounds one giant line rather than retaining it because the entry count is small', () => {
    const result = appendConsoleEntry([], { text: 'x'.repeat(CONSOLE_TEXT_LIMIT * 3) + 'tail' }, 500)
    expect(result[0].text.length).toBeLessThanOrEqual(CONSOLE_TEXT_LIMIT)
    expect(result[0].text.startsWith(OMITTED_OUTPUT)).toBe(true)
    expect(result[0].text.endsWith('tail')).toBe(true)
  })
  it('bounds repeated large entries and does not accumulate omission markers', () => {
    let result: { text: string }[] = []
    for (let i = 0; i < 100; i++) result = appendConsoleEntry(result, { text: 'x'.repeat(200_000) + i }, 500)
    expect(result.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(CONSOLE_TEXT_LIMIT)
    expect(result.map((entry) => entry.text).join('').split(OMITTED_OUTPUT)).toHaveLength(2)
    expect(result.at(-1)?.text.endsWith('99')).toBe(true)
  })
  it('reserves marker space even when only a few old characters fit', () => {
    const result = appendConsoleEntry([{ text: 'old'.repeat(200) }, { text: '' }], { text: 'x'.repeat(CONSOLE_TEXT_LIMIT - 10) }, 500)
    expect(result.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(CONSOLE_TEXT_LIMIT)
  })
  it('does not split a retained UTF-16 surrogate pair', () => {
    const result = appendConsoleEntry([], { text: '🙂'.repeat(CONSOLE_TEXT_LIMIT) }, 500)
    const tail = result[0].text.slice(OMITTED_OUTPUT.length)
    expect(tail.length % 2).toBe(0)
    expect(tail.startsWith('🙂')).toBe(true)
  })
})
