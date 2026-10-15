import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'

vi.mock('@shared/lsp', () => import('../src/shared/lsp'))
vi.mock('@shared/textEdit', () => import('../src/shared/textEdit'))
vi.mock('@shared/libraryComplete', () => import('../src/shared/libraryComplete'))
vi.mock('@shared/stdlib/python.json', () => ({ default: {} }))
vi.mock('@shared/stdlib/cpp.json', () => ({ default: {} }))
vi.mock('@shared/stdlib/python-snippets.json', () => ({ default: {} }))
vi.mock('@shared/stdlib/cpp-snippets.json', () => ({ default: {} }))
vi.mock('@shared/stdlib/cpp-libraries.json', () => ({ default: {} }))
vi.mock('../src/renderer/src/store/useStore', () => ({
  useStore: { getState: () => ({ setLspServers: vi.fn() }) }
}))

const includeEdit = {
  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
  newText: '#include <mutex>\n'
}
const monacoEdit = {
  range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
  text: '#include <mutex>\n'
}

describe('LSP completion additional edits', () => {
  let provider: monaco.languages.CompletionItemProvider
  let model: monaco.editor.ITextModel
  let request: ReturnType<typeof vi.fn>
  const token = { isCancellationRequested: false } as monaco.CancellationToken

  beforeEach(async () => {
    vi.resetModules()
    request = vi.fn()
    vi.stubGlobal('window', {
      api: {
        lspServers: vi.fn().mockResolvedValue({ cpp: true, python: false, rust: false }),
        lspRequest: request,
        lspNotify: vi.fn(),
        onLspDiagnostics: vi.fn(),
        onLspBusy: vi.fn(),
        onLspServerExit: vi.fn()
      }
    })
    const kinds = [
      'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class',
      'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword',
      'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant',
      'Struct', 'Event', 'Operator', 'TypeParameter'
    ]
    const m = {
      editor: { registerCommand: vi.fn() },
      languages: {
        registerCodeActionProvider: vi.fn(),
        CompletionItemKind: Object.fromEntries(kinds.map((kind, i) => [kind, i])),
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        registerCompletionItemProvider: (id: string, p: monaco.languages.CompletionItemProvider) => {
          if (id === 'cpp') provider = p
        },
        registerHoverProvider: vi.fn(),
        registerDefinitionProvider: vi.fn(),
        registerSignatureHelpProvider: vi.fn(),
        registerReferenceProvider: vi.fn(),
        registerDocumentFormattingEditProvider: vi.fn(),
        registerRenameProvider: vi.fn()
      }
    } as unknown as typeof monaco
    model = {
      getWordUntilPosition: () => ({ word: 'mut', startColumn: 6, endColumn: 9 }),
      getVersionId: () => 1,
      getValue: () => 'std::mut',
      isDisposed: () => false
    } as unknown as monaco.editor.ITextModel
    const { initLsp, openDoc } = await import('../src/renderer/src/lsp/lspClient')
    await initLsp(m)
    openDoc('C:/project/main.cpp', 'C:/project', model, model.getValue())
  })

  afterEach(() => vi.unstubAllGlobals())

  async function completion(additionalTextEdits?: typeof includeEdit[]): Promise<monaco.languages.CompletionItem> {
    request.mockResolvedValueOnce([{ label: 'mutex', kind: 22, additionalTextEdits }])
    const list = await provider.provideCompletionItems(
      model, { lineNumber: 300, column: 9 },
      { triggerKind: 0 }, token
    )
    return list!.suggestions[0]
  }

  it('converts initial header edits to Monaco ranges without changing their text', async () => {
    const item = await completion([includeEdit])
    expect(item.additionalTextEdits).toEqual([monacoEdit])
    expect(item.range).toEqual({ startLineNumber: 300, endLineNumber: 300, startColumn: 6, endColumn: 9 })
    expect(item.insertText).toBe('mutex')
  })

  it('forwards header edits supplied lazily during completion resolution', async () => {
    const item = await completion()
    request.mockResolvedValueOnce({ label: 'mutex', additionalTextEdits: [includeEdit] })
    const resolved = await provider.resolveCompletionItem!(item, token)
    expect(resolved!.additionalTextEdits).toEqual([monacoEdit])
  })

  it('keeps initial edits when resolution returns only documentation', async () => {
    const item = await completion([includeEdit])
    request.mockResolvedValueOnce({ label: 'mutex', documentation: 'Mutual exclusion.' })
    const resolved = await provider.resolveCompletionItem!(item, token)
    expect(resolved!.additionalTextEdits).toEqual([monacoEdit])
    expect(resolved!.documentation).toEqual({ value: 'Mutual exclusion.' })
  })

  it('replaces initial edits rather than inserting the same header twice', async () => {
    const item = await completion([includeEdit])
    request.mockResolvedValueOnce({ label: 'mutex', additionalTextEdits: [includeEdit] })
    const resolved = await provider.resolveCompletionItem!(item, token)
    expect(resolved!.additionalTextEdits).toEqual([monacoEdit])
  })

  it('ignores edits from a cancelled resolution request', async () => {
    const item = await completion()
    request.mockResolvedValueOnce({ label: 'mutex', additionalTextEdits: [includeEdit] })
    await provider.resolveCompletionItem!(item, { isCancellationRequested: true } as monaco.CancellationToken)
    expect(item.additionalTextEdits).toBeUndefined()
  })
})
