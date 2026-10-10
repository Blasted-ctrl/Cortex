import type { editor } from 'monaco-editor'
import { cppHeadersForChanges, planCppAutoIncludes } from '../../../shared/cppAutoInclude'

const activeFlushes = new Map<object, { path?: string; flush(): void }>()

/** Save/run/menu actions must see pending includes before taking a snapshot. */
export function flushCppAutoIncludes(path?: string): void {
  for (const entry of activeFlushes.values()) if (path === undefined || entry.path === path) entry.flush()
}

/** The same path handles typing, paste and completion, without requiring LSP. */
export function attachCppAutoIncludes(instance: editor.IStandaloneCodeEditor, path?: string): { dispose(): void; flush(): void } {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let applying = false
  let previousText = instance.getModel()?.getValue() ?? ''
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const reset = (): void => { cancel(); pending.clear() }
  const flush = (): void => {
    cancel()
    const model = instance.getModel()
    if (!model || model.isDisposed() || model.getLanguageId() !== 'cpp') { pending.clear(); return }
    const edit = planCppAutoIncludes(model.getValue(), [...pending])
    pending.clear()
    if (!edit) return
    const position = model.getPositionAt(edit.offset)
    const firstVisible = instance.getVisibleRanges()[0]?.startLineNumber
    const topBefore = firstVisible ? instance.getTopForLineNumber(firstVisible) : 0
    const scrollBefore = instance.getScrollTop()
    applying = true
    try {
      // Monaco tracks selections across edits, so a caret on line 300 stays
      // beside the symbol instead of moving to the new #include at the top.
      instance.executeEdits('cortex.autoInclude', [{
        range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column },
        text: edit.text,
        forceMoveMarkers: true
      }])
      instance.pushUndoStop()
      // Anchor the visible code as well as the caret when lines are added above
      // the viewport. Do not restore an old (now stale) line/cursor position.
      if (firstVisible && position.lineNumber < firstVisible) {
        const addedLines = edit.text.split('\n').length - 1
        instance.setScrollTop(scrollBefore + instance.getTopForLineNumber(firstVisible + addedLines) - topBefore)
      }
    } finally { applying = false }
  }
  const content = instance.onDidChangeModelContent((event) => {
    cancel()
    const model = instance.getModel()
    const before = previousText
    previousText = model?.getValue() ?? ''
    if (applying) return
    if (!model || model.getLanguageId() !== 'cpp' || event.isFlush || event.isUndoing || event.isRedoing || event.isEolChange) { pending.clear(); return }
    const inserted = event.changes.filter((change) => change.text.length > 0)
    const removedInclude = event.changes.some((change) => {
      if (!change.rangeLength) return false
      const lineStart = before.lastIndexOf('\n', change.rangeOffset - 1) + 1
      const nextLine = before.indexOf('\n', change.rangeOffset + change.rangeLength)
      const lineEnd = nextLine < 0 ? before.length : nextLine
      return /#\s*include\b/.test(before.slice(lineStart, lineEnd))
    })
    if (removedInclude) pending.clear()
    // Keep a pending include when Backspace corrects an unrelated typo. Only
    // cancellation of the actual header directive should override that request.
    if (!inserted.length) {
      if (pending.size) timer = setTimeout(flush, 300)
      return
    }
    let delta = 0
    const ranges = [...event.changes].sort((a, b) => a.rangeOffset - b.rangeOffset).flatMap((change) => {
      const start = change.rangeOffset + delta
      delta += change.text.length - change.rangeLength
      return change.text ? [{ start, end: start + change.text.length }] : []
    })
    for (const header of cppHeadersForChanges(model.getValue(), ranges)) pending.add(header)
    if (pending.size) timer = setTimeout(flush, 300)
  })
  const modelChange = instance.onDidChangeModel(() => { reset(); previousText = instance.getModel()?.getValue() ?? '' })
  activeFlushes.set(instance, { path, flush })
  return { flush, dispose: () => { reset(); activeFlushes.delete(instance); content.dispose(); modelChange.dispose() } }
}
