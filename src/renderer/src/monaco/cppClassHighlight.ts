import type { editor } from 'monaco-editor'
import { maskCppNonCode } from '@shared/cppLexical'
import { includedHeaders, indexLibraries, type LibraryDict } from '@shared/libraryComplete'
import cppLibraries from '@shared/stdlib/cpp-libraries.json'

const classes = indexLibraries(cppLibraries as LibraryDict)

// Type names this file declares: struct/class/union/enum (incl. enum class),
// typedef aliases (plain and `typedef struct {...} Name;`) and `using Name =`.
const DECLARED_TYPE = [
  /\b(?:struct|class|union|enum(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)/g,
  /\btypedef\b[^;{}]*?\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*;/g,
  /\btypedef\s+(?:struct|union|enum)\b[^{;]*\{[^}]*\}\s*([A-Za-z_]\w*)/g,
  /\busing\s+([A-Za-z_]\w*)\s*=/g
]
// C, POSIX and ESP-IDF name their types with a _t suffix: uint8_t, esp_err_t,
// camera_config_t. Their headers are not in the curated index, so the suffix
// is the signal.
const SUFFIX_TYPE = /^[A-Za-z_]\w*_t$/

function declaredTypes(clean: string): Set<string> {
  const names = new Set<string>()
  for (const re of DECLARED_TYPE) for (const match of clean.matchAll(re)) names.add(match[1])
  return names
}

/** UTF-16 ranges for type names in live code: curated library classes whose
 * header is included, types this file declares, and `_t` names. Monaco's basic
 * C++ tokenizer treats these as plain identifiers; the lexical mask keeps
 * comments, strings and member accesses unchanged. */
export function curatedClassRanges(source: string): Array<{ start: number; end: number }> {
  const clean = maskCppNonCode(source)
  const headerLines = maskCppNonCode(source, false).split('\n')
  const directives = clean.split('\n').map((line, i) => /^\s*#\s*include\b/.test(line) ? headerLines[i] : '').join('\n')
  const headers = includedHeaders(directives)
  const names = declaredTypes(clean)
  for (const [name, entry] of classes) if (headers.has(entry.header)) names.add(name)

  const ranges: Array<{ start: number; end: number }> = []
  for (const match of clean.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    if (!names.has(match[0]) && !SUFFIX_TYPE.test(match[0])) continue
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
