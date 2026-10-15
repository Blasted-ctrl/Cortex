import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasUnsavedEdits, startAutoSave } from '../src/renderer/src/store/autoSave'

type Tab = { content: string; savedContent: string; readOnlyReason?: string }
type State = { tabs: readonly Tab[] }

function fakeStore(initial: Tab[]) {
  let state: State = { tabs: initial }
  const listeners = new Set<(s: State, p: State) => void>()
  return {
    getState: () => state,
    subscribe: (l: (s: State, p: State) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    set(tabs: Tab[]) {
      const prev = state
      state = { tabs }
      listeners.forEach((l) => l(state, prev))
    }
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('hasUnsavedEdits', () => {
  it('is true only for an editable tab whose content differs from disk', () => {
    expect(hasUnsavedEdits([{ content: 'a', savedContent: 'a' }])).toBe(false)
    expect(hasUnsavedEdits([{ content: 'b', savedContent: 'a' }])).toBe(true)
    expect(hasUnsavedEdits([{ content: 'b', savedContent: 'a', readOnlyReason: 'binary' }])).toBe(false)
  })
})

describe('startAutoSave', () => {
  it('saves once after typing pauses, not on every keystroke', async () => {
    const store = fakeStore([{ content: 'a', savedContent: 'a' }])
    const save = vi.fn().mockResolvedValue(undefined)
    startAutoSave(store, save, { delayMs: 1000 })
    store.set([{ content: 'ab', savedContent: 'a' }])
    await vi.advanceTimersByTimeAsync(600)
    store.set([{ content: 'abc', savedContent: 'a' }])
    await vi.advanceTimersByTimeAsync(600)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the edit was already saved or the feature is off', async () => {
    const store = fakeStore([{ content: 'a', savedContent: 'a' }])
    const save = vi.fn().mockResolvedValue(undefined)
    let on = true
    startAutoSave(store, save, { delayMs: 100, enabled: () => on })
    store.set([{ content: 'a', savedContent: 'a' }])
    await vi.advanceTimersByTimeAsync(500)
    expect(save).not.toHaveBeenCalled()
    on = false
    store.set([{ content: 'x', savedContent: 'a' }])
    await vi.advanceTimersByTimeAsync(500)
    expect(save).not.toHaveBeenCalled()
  })

  it('swallows a failed save and keeps the tab dirty for the explicit save to report', async () => {
    const store = fakeStore([{ content: 'a', savedContent: 'a' }])
    const save = vi.fn().mockRejectedValue(new Error('disk full'))
    startAutoSave(store, save, { delayMs: 100 })
    store.set([{ content: 'x', savedContent: 'a' }])
    await vi.advanceTimersByTimeAsync(150)
    expect(save).toHaveBeenCalledTimes(1)
    expect(hasUnsavedEdits(store.getState().tabs)).toBe(true)
  })

  it('saves again when typing continued during the write', async () => {
    const store = fakeStore([{ content: 'a', savedContent: 'a' }])
    let release: () => void = () => {}
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined)
    startAutoSave(store, save, { delayMs: 100 })
    store.set([{ content: 'x', savedContent: 'a' }])
    await vi.advanceTimersByTimeAsync(150)
    expect(save).toHaveBeenCalledTimes(1)
    store.set([{ content: 'xy', savedContent: 'a' }]) // typed while the first save is in flight
    release()
    await vi.advanceTimersByTimeAsync(300)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('does not retry in a loop when a save leaves the tab dirty', async () => {
    const store = fakeStore([{ content: 'a', savedContent: 'a' }])
    const save = vi.fn().mockResolvedValue(undefined) // never updates savedContent
    startAutoSave(store, save, { delayMs: 100 })
    store.set([{ content: 'x', savedContent: 'a' }])
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('stops watching after unsubscribe', async () => {
    const store = fakeStore([{ content: 'a', savedContent: 'a' }])
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutoSave(store, save, { delayMs: 100 })
    store.set([{ content: 'x', savedContent: 'a' }])
    stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(save).not.toHaveBeenCalled()
  })
})
