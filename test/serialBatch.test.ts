import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChunkBatcher } from '../src/renderer/src/store/serialBatch'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createChunkBatcher', () => {
  it('turns a flood of small chunks into one delivery per interval, in order, losing nothing', () => {
    const deliver = vi.fn()
    const b = createChunkBatcher(deliver, 50)
    for (let i = 0; i < 1000; i++) b.push(`line ${i}\n`)
    expect(deliver).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(deliver).toHaveBeenCalledTimes(1)
    const text = deliver.mock.calls[0][0] as string
    expect(text.split('\n').filter(Boolean)).toHaveLength(1000)
    expect(text.startsWith('line 0\n')).toBe(true)
    expect(text.endsWith('line 999\n')).toBe(true)
  })

  it('keeps delivering at most once per interval while data keeps arriving', () => {
    const deliver = vi.fn()
    const b = createChunkBatcher(deliver, 50)
    for (let t = 0; t < 1000; t += 2) {
      b.push('x\n')
      vi.advanceTimersByTime(2)
    }
    // One second of a 2 ms loop: about 20 deliveries, not 500.
    expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(19)
    expect(deliver.mock.calls.length).toBeLessThanOrEqual(21)
  })

  it('splits nothing: a line cut across chunks arrives joined', () => {
    const deliver = vi.fn()
    const b = createChunkBatcher(deliver, 50)
    b.push('temp=2')
    b.push('4.5\n')
    vi.advanceTimersByTime(50)
    expect(deliver).toHaveBeenCalledWith('temp=24.5\n')
  })

  it('flushes on demand and cancels cleanly', () => {
    const deliver = vi.fn()
    const b = createChunkBatcher(deliver, 50)
    b.push('a')
    b.flush()
    expect(deliver).toHaveBeenCalledWith('a')
    b.push('b')
    b.cancel()
    vi.advanceTimersByTime(100)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('ignores empty chunks', () => {
    const deliver = vi.fn()
    const b = createChunkBatcher(deliver, 50)
    b.push('')
    vi.advanceTimersByTime(100)
    expect(deliver).not.toHaveBeenCalled()
  })
})
