import type { editor } from 'monaco-editor'
import { maskCppNonCode } from '@shared/cppLexical'
import { includedHeaders, indexLibraries, type LibraryDict } from '@shared/libraryComplete'
import cppLibraries from '@shared/stdlib/cpp-libraries.json'

const classes = indexLibraries(cppLibraries as LibraryDict)

/** UTF-16 ranges for curated C++ class names in live code. Monaco's basic C++
 * tokenizer treats these names as plain identifiers; included headers and the
 * lexical mask keep comments, strings and unrelated projects unchanged. */
export function curatedClassRanges(source: string): Array<{ start: number; end: number }> {
  if (!classes.size) return []
  const clean = maskCppNonCode(source)
  const headerLines = maskCppNonCode(source, false).split('\n')
  const directives = clean.split('\n').map((line, i) => /^\s*#\s*include\b/.test(line) ? headerLines[i] : '').join('\n')
  const headers = includedHeaders(directives)
  const names = new Set([...classes].filter(([, entry]) => headers.has(entry.header)).map(([name]) => name))
  if (!names.size) return []

  const ranges: Array<{ start: number; end: number }> = []
  for (const match of clean.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    if (!names.has(match[0])) continue
    const start = match.index
    const lineStart = clean.lastIndexOf('\n', start - 1) + 1
    const before = clean.slice(lineStart, start).trimEnd()
    if (before.startsWith('#') || /(?:\.|->|::)$/.test(before)) continue
    ranges.push({ start, end: start + match[0].length })
  }
  return ranges
}

export function attachCppClassHighlight(instance: editor.IStandaloneCodeEditor): { dispose(): void } {
  const decorations = instance.createDecorationsCollection()
  const update = (): void => {
    const model = instance.getModel()
    if (!model || model.isDisposed() || model.getLanguageId() !== 'cpp') {
      decorations.set([])
      return
    }
    decorations.set(curatedClassRanges(model.getValue()).map(({ start, end }) => {
      const from = model.getPositionAt(start)
      const to = model.getPositionAt(end)
      return {
        range: {
          startLineNumber: from.lineNumber, startColumn: from.column,
          endLineNumber: to.lineNumber, endColumn: to.column
        },
        options: { inlineClassName: 'cortex-cpp-class-token' }
      }
    }))
  }
  update()
  const content = instance.onDidChangeModelContent(update)
  const model = instance.onDidChangeModel(update)
  return { dispose: () => { content.dispose(); model.dispose(); decorations.set([]) } }
}
