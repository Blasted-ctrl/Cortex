import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'

vi.mock('../src/shared/cppAutoInclude', async () => {
  const actual = await import('../src/shared/cppAutoInclude')
  return { ...actual, cppHeadersForChanges: vi.fn(actual.cppHeadersForChanges) }
})

import { cppHeadersForChanges } from '../src/shared/cppAutoInclude'
import { attachCppAutoIncludes as attachProductionAutoIncludes, flushCppAutoIncludes } from '../src/renderer/src/monaco/cppAutoInclude'

const attachments: ReturnType<typeof attachProductionAutoIncludes>[] = []

function attachCppAutoIncludes(...args: Parameters<typeof attachProductionAutoIncludes>): ReturnType<typeof attachProductionAutoIncludes> {
  const attachment = attachProductionAutoIncludes(...args)
  attachments.push(attachment)
  return attachment
}

function fakeEditor(initial = '', options: { language?: string; firstVisible?: number; scrollTop?: number } = {}) {
  let value = initial
  let language = options.language ?? 'cpp'
  let disposed = false
  const contentListeners = new Set<(event: editor.IModelContentChangedEvent) => void>()
  const modelListeners = new Set<() => void>()
  const positionAt = (offset: number): { lineNumber: number; column: number } => {
    const lines = value.slice(0, offset).split('\n')
    return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 }
  }
  const offsetAt = (lineNumber: number, column: number): number => {
    return value.split('\n').slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) + column - 1
  }
  const model = {
    getValue: vi.fn(() => value),
    getLanguageId: () => language,
    isDisposed: () => disposed,
    getPositionAt: positionAt
  } as unknown as editor.ITextModel
  let currentModel: editor.ITextModel | null = model
  const notify = (changes: editor.IModelContentChange[] = [], flags: Partial<editor.IModelContentChangedEvent> = {}): void => {
    const event = { changes, isFlush: false, isUndoing: false, isRedoing: false, isEolChange: false, ...flags } as editor.IModelContentChangedEvent
    for (const listener of contentListeners) listener(event)
  }
  const edit = (start: number, length: number, text: string, flags: Partial<editor.IModelContentChangedEvent> = {}): void => {
    const begin = positionAt(start)
    const end = positionAt(start + length)
    value = value.slice(0, start) + text + value.slice(start + length)
    notify([{
      range: { startLineNumber: begin.lineNumber, startColumn: begin.column, endLineNumber: end.lineNumber, endColumn: end.column },
      rangeOffset: start, rangeLength: length, text
    }], flags)
  }
  const batch = (changes: { start: number; length: number; text: string }[]): void => {
    const eventChanges = changes.map((change) => {
      const begin = positionAt(change.start)
      const end = positionAt(change.start + change.length)
      return {
        range: { startLineNumber: begin.lineNumber, startColumn: begin.column, endLineNumber: end.lineNumber, endColumn: end.column },
        rangeOffset: change.start, rangeLength: change.length, text: change.text
      }
    })
    for (const change of [...changes].sort((a, b) => b.start - a.start)) {
      value = value.slice(0, change.start) + change.text + value.slice(change.start + change.length)
    }
    notify(eventChanges)
  }
  const executeEdits = vi.fn((_source: string, edits: editor.IIdentifiedSingleEditOperation[]) => {
    for (const change of edits) {
      const start = offsetAt(change.range.startLineNumber, change.range.startColumn)
      const end = offsetAt(change.range.endLineNumber, change.range.endColumn)
      edit(start, end - start, change.text ?? '')
    }
    return true
  })
  const setScrollTop = vi.fn()
  const pushUndoStop = vi.fn()
  const setPosition = vi.fn()
  const setSelection = vi.fn()
  const restoreViewState = vi.fn()
  const instance = {
    getModel: () => currentModel,
    getVisibleRanges: () => [{ startLineNumber: options.firstVisible ?? 1 }],
    getTopForLineNumber: (line: number) => (line - 1) * 20,
    getScrollTop: () => options.scrollTop ?? 0,
    setScrollTop, executeEdits, pushUndoStop, setPosition, setSelection, restoreViewState,
    onDidChangeModelContent: (listener: (event: editor.IModelContentChangedEvent) => void) => {
      contentListeners.add(listener)
      return { dispose: () => contentListeners.delete(listener) }
    },
    onDidChangeModel: (listener: () => void) => {
      modelListeners.add(listener)
      return { dispose: () => modelListeners.delete(listener) }
    }
  } as unknown as editor.IStandaloneCodeEditor
  return {
    instance, model, executeEdits, pushUndoStop, setScrollTop, setPosition, setSelection, restoreViewState,
    value: () => value,
    append: (text: string) => edit(value.length, 0, text),
    edit, batch, notify,
    setLanguage: (next: string) => { language = next },
    disposeModel: () => { disposed = true },
    changeModel: (next: editor.ITextModel | null = model) => {
      currentModel = next
      for (const listener of modelListeners) listener()
    },
    listenerCounts: () => [contentListeners.size, modelListeners.size]
  }
}

describe('attachCppAutoIncludes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    for (const attachment of attachments.splice(0)) attachment.dispose()
    vi.useRealTimers()
  })

  it('does not modify existing content merely because an editor opens', () => {
    const fake = fakeEditor('std::mutex lock;')
    attachCppAutoIncludes(fake.instance)
    vi.advanceTimersByTime(1000)
    expect(fake.executeEdits).not.toHaveBeenCalled()
    expect(fake.value()).toBe('std::mutex lock;')
  })

  it('waits 300 milliseconds after the latest typing event', () => {
    const fake = fakeEditor()
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex')
    vi.advanceTimersByTime(299)
    expect(fake.executeEdits).not.toHaveBeenCalled()
    fake.append(' lock;')
    vi.advanceTimersByTime(299)
    expect(fake.executeEdits).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fake.value()).toBe('#include <mutex>\n\nstd::mutex lock;')
    expect(fake.executeEdits).toHaveBeenCalledTimes(1)
  })

  it('adds every required header from one pasted block', () => {
    const fake = fakeEditor()
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;\nstd::this_thread::sleep_for(std::chrono::milliseconds(10));')
    vi.advanceTimersByTime(300)
    expect(fake.value()).toContain('#include <mutex>\n')
    expect(fake.value()).toContain('#include <thread>\n')
    expect(fake.value()).toContain('#include <chrono>\n')
    expect(fake.executeEdits).toHaveBeenCalledTimes(1)
  })

  it('accounts for offset shifts across simultaneous edits supplied in reverse order', () => {
    const source = 'std::mut left;\nstd::vect right;'
    const fake = fakeEditor(source)
    attachCppAutoIncludes(fake.instance)
    fake.batch([
      { start: source.indexOf('vect'), length: 4, text: 'vector<int>' },
      { start: source.indexOf('mut'), length: 3, text: 'mutex' }
    ])
    vi.advanceTimersByTime(300)
    expect(fake.value()).toContain('#include <mutex>\n')
    expect(fake.value()).toContain('#include <vector>\n')
    expect(fake.executeEdits).toHaveBeenCalledTimes(1)
  })

  it('does not scan or reschedule its own emitted content edit', () => {
    const fake = fakeEditor()
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    vi.advanceTimersByTime(300)
    expect(cppHeadersForChanges).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(fake.executeEdits).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['isUndoing', 'isRedoing', 'isFlush', 'isEolChange'] as const)('clears pending edits after %s', (flag) => {
    const fake = fakeEditor()
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    fake.notify([], { [flag]: true })
    vi.advanceTimersByTime(1000)
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('retains pending edits when Backspace corrects an unrelated typo', () => {
    const fake = fakeEditor()
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    fake.edit(fake.value().length - 1, 1, '')
    vi.advanceTimersByTime(300)
    expect(fake.value()).toBe('#include <mutex>\n\nstd::mutex lock')
    expect(fake.executeEdits).toHaveBeenCalledTimes(1)
  })

  it('rechecks that a recognized symbol still exists after Backspace', () => {
    const fake = fakeEditor()
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex')
    fake.edit(fake.value().length - 1, 1, '')
    vi.advanceTimersByTime(300)
    expect(fake.value()).toBe('std::mute')
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('does not fight a manually removed header', () => {
    const fake = fakeEditor('#include <mutex>\nstd::mutex lock;')
    attachCppAutoIncludes(fake.instance)
    fake.edit(0, '#include <mutex>\n'.length, '')
    vi.advanceTimersByTime(1000)
    expect(fake.value()).toBe('std::mutex lock;')
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it.each(['#include <iostream>\n', '\n#include <iostream>\n'])('clears a pending include when a deleted range touches a header: %j', (prefix) => {
    const fake = fakeEditor(prefix)
    const attachment = attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    fake.edit(0, prefix.length, '')
    attachment.flush()
    vi.advanceTimersByTime(1000)
    expect(fake.value()).toBe('std::mutex lock;')
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('clears pending edits when the editor changes models', () => {
    const fake = fakeEditor()
    const attachment = attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    fake.changeModel()
    attachment.flush()
    vi.advanceTimersByTime(1000)
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('unsubscribes both listeners and cancels pending work on disposal', () => {
    const fake = fakeEditor()
    const attachment = attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    attachment.dispose()
    expect(fake.listenerCounts()).toEqual([0, 0])
    fake.append('\nstd::vector<int> values;')
    vi.advanceTimersByTime(1000)
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('ignores an actual C model instead of treating it as C++', () => {
    const fake = fakeEditor('', { language: 'c' })
    const attachment = attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    attachment.flush()
    vi.advanceTimersByTime(1000)
    expect(cppHeadersForChanges).not.toHaveBeenCalled()
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('rechecks the model language before a pending edit runs', () => {
    const fake = fakeEditor()
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    fake.setLanguage('c')
    vi.advanceTimersByTime(300)
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('does not edit a model disposed while waiting', () => {
    const fake = fakeEditor()
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    fake.disposeModel()
    vi.advanceTimersByTime(300)
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('handles an editor detached from its model', () => {
    const fake = fakeEditor()
    const attachment = attachCppAutoIncludes(fake.instance)
    fake.changeModel(null)
    fake.notify()
    attachment.flush()
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('lets Monaco track selections rather than resetting the caret', () => {
    const fake = fakeEditor()
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    vi.advanceTimersByTime(300)
    expect(fake.executeEdits.mock.calls[0]).toHaveLength(2)
    expect(fake.executeEdits.mock.calls[0][0]).toBe('cortex.autoInclude')
    expect(fake.executeEdits.mock.calls[0][1][0].forceMoveMarkers).toBe(true)
    expect(fake.setPosition).not.toHaveBeenCalled()
    expect(fake.setSelection).not.toHaveBeenCalled()
    expect(fake.restoreViewState).not.toHaveBeenCalled()
    expect(fake.pushUndoStop).toHaveBeenCalledTimes(1)
  })

  it('anchors visible code when new header lines are inserted above line 300', () => {
    const fake = fakeEditor('#include <iostream>\n' + '\n'.repeat(298), { firstVisible: 300, scrollTop: 5970 })
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    vi.advanceTimersByTime(300)
    const addedLines = fake.executeEdits.mock.calls[0][1][0].text!.split('\n').length - 1
    expect(fake.setScrollTop).toHaveBeenCalledWith(5970 + addedLines * 20)
  })

  it('does not adjust scrolling when the inserted header is in the visible area', () => {
    const fake = fakeEditor('', { firstVisible: 1 })
    attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    vi.advanceTimersByTime(300)
    expect(fake.setScrollTop).not.toHaveBeenCalled()
  })

  it('flushes a pending include immediately for Save or Run without a later duplicate', () => {
    const fake = fakeEditor()
    const attachment = attachCppAutoIncludes(fake.instance)
    fake.append('std::mutex lock;')
    vi.advanceTimersByTime(100)
    attachment.flush()
    expect(fake.value()).toBe('#include <mutex>\n\nstd::mutex lock;')
    attachment.flush()
    vi.advanceTimersByTime(1000)
    expect(fake.executeEdits).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not duplicate an include supplied with an accepted completion', () => {
    const fake = fakeEditor('std::mut')
    attachCppAutoIncludes(fake.instance)
    fake.batch([
      { start: 5, length: 3, text: 'mutex' },
      { start: 0, length: 0, text: '#include <mutex>\n' }
    ])
    vi.advanceTimersByTime(300)
    expect(fake.value()).toBe('#include <mutex>\nstd::mutex')
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })

  it('flushes only the editor whose path is being saved', () => {
    const first = fakeEditor()
    const second = fakeEditor()
    attachCppAutoIncludes(first.instance, 'C:/project/first.cpp')
    attachCppAutoIncludes(second.instance, 'C:/project/second.cpp')
    first.append('std::mutex first;')
    second.append('std::vector<int> second;')
    flushCppAutoIncludes('C:/project/first.cpp')
    expect(first.value()).toContain('#include <mutex>\n')
    expect(second.value()).toBe('std::vector<int> second;')
    expect(second.executeEdits).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(second.value()).toContain('#include <vector>\n')
  })

  it('flushes all registered editors when Save All has no path filter', () => {
    const first = fakeEditor()
    const second = fakeEditor()
    attachCppAutoIncludes(first.instance, 'C:/project/first.cpp')
    attachCppAutoIncludes(second.instance)
    first.append('std::mutex first;')
    second.append('std::vector<int> second;')
    flushCppAutoIncludes()
    expect(first.value()).toContain('#include <mutex>\n')
    expect(second.value()).toContain('#include <vector>\n')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes disposed editors from the central flush registry', () => {
    const fake = fakeEditor()
    const attachment = attachCppAutoIncludes(fake.instance, 'C:/project/disposed.cpp')
    fake.append('std::mutex lock;')
    attachment.dispose()
    vi.mocked(fake.model.getValue).mockClear()
    flushCppAutoIncludes('C:/project/disposed.cpp')
    flushCppAutoIncludes()
    expect(fake.model.getValue).not.toHaveBeenCalled()
    expect(fake.executeEdits).not.toHaveBeenCalled()
  })
})
