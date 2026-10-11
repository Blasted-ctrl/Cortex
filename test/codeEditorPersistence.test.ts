import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as files from '../src/main/services/fsService'
import { createHost } from './reactHost'

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
const browser = vi.hoisted(() => {
  const noop = (): void => {}
  const disposable = (): { dispose(): void } => ({ dispose: noop })
  const createdValues: string[] = []
  const disposals = { held: false, pending: [] as Array<() => void> }
  function createModel(value: string, language: string) {
    createdValues.push(value)
    let content = value.replace(/^\ufeff/, '')
    let disposed = false
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    return {
      uri: { path: '/fixture' },
      getValue: (_eol?: unknown, preserveBOM = false) => (preserveBOM && value.startsWith('\ufeff') ? '\ufeff' : '') + content,
      getLanguageId: () => language,
      isDisposed: () => disposed,
      dispose: () => { disposed = true },
      getFullModelRange: (): Range => {
        const lines = content.split(/\r\n|\n/)
        return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines.at(-1)!.length + 1 }
      },
      insert(range: Range, text: string): void {
        const lines = content.split(eol)
        const offset = (line: number, column: number): number => lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + eol.length, 0) + column - 1
        const start = offset(range.startLineNumber, range.startColumn)
        const end = offset(range.endLineNumber, range.endColumn)
        content = content.slice(0, start) + text.replace(/\r\n|\n/g, eol) + content.slice(end)
      }
    }
  }
  function createEditor(model: ReturnType<typeof createModel>) {
    const listeners = new Set<(event: { changes: Array<{ rangeOffset: number; rangeLength: number; text: string }> }) => void>()
    const disposeListeners = new Set<() => void>()
    return {
      getModel: () => model,
      getValue: () => model.getValue(),
      getOption: () => false,
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      getContainerDomNode: () => null,
      saveViewState: () => null,
      restoreViewState: noop,
      updateOptions: noop,
      layout: noop,
      pushUndoStop: noop,
      addCommand: noop,
      onMouseDown: disposable,
      onDidChangeCursorPosition: disposable,
      onDidFocusEditorText: disposable,
      onDidChangeModel: disposable,
      createDecorationsCollection: () => ({ set: noop }),
      onDidChangeModelContent(listener: (event: { changes: Array<{ rangeOffset: number; rangeLength: number; text: string }> }) => void) {
        listeners.add(listener)
        return { dispose: () => { listeners.delete(listener) } }
      },
      onDidDispose(listener: () => void) { disposeListeners.add(listener); return disposable() },
      dispose: () => {
        for (const listener of disposeListeners) {
          if (disposals.held) disposals.pending.push(listener)
          else listener()
        }
      },
      executeEdits(_source: string, edits: Array<{ range: Range; text: string }>): void {
        for (const edit of edits) model.insert(edit.range, edit.text)
        const event = { changes: edits.map((edit) => ({ rangeOffset: 0, rangeLength: 0, text: edit.text })) }
        for (const listener of listeners) listener(event)
      }
    }
  }
  const editors: ReturnType<typeof createEditor>[] = []
  return {
    createdValues, editors, disposals,
    api: {
      Uri: { parse: (path: string) => ({ path }) },
      KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49, F5: 63 },
      editor: {
        getModel: () => null,
        createModel,
        create: (_container: unknown, options: { model: ReturnType<typeof createModel> }) => {
          const editor = createEditor(options.model)
          editors.push(editor)
          return editor
        },
        EditorOption: { readOnly: 91 },
        defineTheme: noop, setTheme: noop, setModelLanguage: noop, setModelMarkers: noop,
        onDidChangeMarkers: disposable,
        MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 }
      },
      languages: {
        register: noop, setLanguageConfiguration: noop, setMonarchTokensProvider: noop,
        registerCompletionItemProvider: disposable, registerHoverProvider: disposable,
        registerDefinitionProvider: disposable, registerSignatureHelpProvider: disposable,
        registerReferenceProvider: disposable, registerDocumentFormattingEditProvider: disposable,
        registerRenameProvider: disposable
      }
    }
  }
})

// Keep the installed React wrapper, CodeEditor and store real. Only Monaco's
// browser/worker API is replaced; initial models consume BOM metadata, while
// controlled executeEdits inserts the supplied text literally.
vi.mock('monaco-editor/esm/vs/editor/editor.api', () => browser.api)
vi.mock('monaco-editor/esm/vs/editor/editor.all', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/python/python.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/rust/rust.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/lua/lua.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/ini/ini.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/xml/xml.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/basic-languages/shell/shell.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: class {} }))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
vi.stubGlobal('window', { api: {
  readFile: files.readFile, exists: files.exists, writeFile: files.writeFile, readDir: files.readDir,
  lspServers: async () => ({ cpp: false, python: false, rust: false }),
  onLspDiagnostics: () => () => {}, onLspBusy: () => () => {}, onLspServerExit: () => () => {}
} })
vi.stubGlobal('self', {})
vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore, workspaceScopedReset } = await import('../src/renderer/src/store/useStore')
const { default: CodeEditor } = await import('../src/renderer/src/components/CodeEditor')
const { loader } = await import('@monaco-editor/react')
const initial = useStore.getState()
let fixture: string
let path: string
let host: ReturnType<typeof createHost>

beforeEach(async () => {
  fixture = await fs.mkdtemp(join(tmpdir(), 'cortex-editor-bytes-'))
  path = join(fixture, 'main.cpp')
  files.setWorkspaceRoot(fixture)
  storage.clear()
  browser.createdValues.length = 0
  browser.editors.length = 0
  browser.disposals.held = false
  browser.disposals.pending.length = 0
  useStore.setState({ ...initial, ...workspaceScopedReset(), workspaceRoot: fixture, workspaceName: 'editor-bytes', tree: [] }, true)
  host = createHost()
})

afterEach(async () => {
  browser.disposals.held = false
  for (const listener of browser.disposals.pending.splice(0)) listener()
  await host.render(null)
  vi.restoreAllMocks()
  await useStore.getState().refreshTree()
  files.setWorkspaceRoot(null)
  useStore.setState(initial, true)
  await fs.rm(fixture, { recursive: true, force: true })
})

async function open(content: string): Promise<void> {
  await fs.writeFile(path, content, 'utf8')
  await useStore.getState().openFile(path)
  await host.render(createElement(CodeEditor, { path }))
  expect(browser.editors).toHaveLength(1)
}

async function typeAtStart(text: string): Promise<void> {
  await act(async () => {
    browser.editors.at(-1)!.executeEdits('fixture.type', [{
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text
    }])
  })
}

describe('actual CodeEditor persistence boundary', () => {
  it.each([
    { name: 'BOM and CRLF', disk: '\ufeff// original\r\n', editor: '// original\r\n' },
    { name: 'intentional interior U+FEFF', disk: '\ufeff// keep\ufeffthis\r\n', editor: '// keep\ufeffthis\r\n' },
    { name: 'one marker only', disk: '\ufeff\ufeff// literal leading character\n', editor: '\ufeff// literal leading character\n' },
    { name: 'empty file', disk: '', editor: '' },
    { name: 'no BOM', disk: '// plain\n', editor: '// plain\n' }
  ])('supplies editor text without changing the raw $name snapshot', async ({ disk, editor }) => {
    await open(disk)
    expect(browser.createdValues).toEqual([disk])
    expect(browser.editors[0].getValue()).toBe(editor)
    expect(useStore.getState().tabs[0]).toMatchObject({ content: disk, savedContent: disk })
    expect(await fs.readFile(path)).toEqual(Buffer.from(disk, 'utf8'))
  })

  it.each(['start', 'end'] as const)('preserves a literal leading U+FEFF when typing at the %s and saving', async (position) => {
    const disk = '\ufeff\ufeff// literal\r\n'
    await open(disk)
    const modelBefore = browser.editors[0].getValue()
    const prefix = '// prefix\r\n'
    const suffix = '// suffix\r\n'
    if (position === 'start') await typeAtStart(prefix)
    else await act(async () => {
      const full = browser.editors[0].getModel().getFullModelRange()
      browser.editors[0].executeEdits('fixture.type', [{ range: {
        startLineNumber: full.endLineNumber, startColumn: full.endColumn,
        endLineNumber: full.endLineNumber, endColumn: full.endColumn
      }, text: suffix }])
    })
    const expected = position === 'start' ? `\ufeff${prefix}\ufeff// literal\r\n` : `${disk}${suffix}`
    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(path)).toEqual(Buffer.from(expected, 'utf8'))
    expect(modelBefore).toBe('\ufeff// literal\r\n')
    expect(useStore.getState().tabs[0]).toMatchObject({ content: expected, savedContent: expected })
    expect(browser.editors[0].getValue()).toBe(expected.slice(1))
  })

  it('preserves a newly typed literal U+FEFF in a file with no encoding marker', async () => {
    await open('// plain\r\n')
    await typeAtStart('\ufeff')
    const expected = '\ufeff// plain\r\n'
    expect(browser.editors[0].getValue()).toBe(expected)
    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(path)).toEqual(Buffer.from(expected, 'utf8'))
    expect(useStore.getState().tabs[0]).toMatchObject({ content: expected, savedContent: expected })
    expect(browser.editors[0].getValue()).toBe(expected)

    await typeAtStart('// next prefix\r\n')
    const next = `// next prefix\r\n${expected}`
    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(path)).toEqual(Buffer.from(next, 'utf8'))
    expect(browser.editors[0].getValue()).toBe(next)
  })

  it.each([
    { name: 'adds', initial: '// plain\r\n', replacement: '\ufeff\ufeff// replaced\r\n', editor: '\ufeff// replaced\r\n', prefix: '\ufeff' },
    { name: 'removes', initial: '\ufeff// original\r\n', replacement: '// replaced\ufefftext\r\n', editor: '// replaced\ufefftext\r\n', prefix: '' }
  ])('adopts an external raw replacement that $name encoding metadata', async ({ initial, replacement, editor, prefix }) => {
    await open(initial)
    await fs.writeFile(path, replacement, 'utf8')
    await act(async () => { await useStore.getState().reloadActiveFromDisk() })
    expect(browser.editors).toHaveLength(1)
    expect(browser.editors[0].getValue()).toBe(editor)
    await typeAtStart('// after reload\r\n')
    const expected = `${prefix}// after reload\r\n${editor}`
    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(path)).toEqual(Buffer.from(expected, 'utf8'))
    expect(useStore.getState().tabs[0]).toMatchObject({ content: expected, savedContent: expected })
    expect(browser.editors[0].getValue()).toBe(`// after reload\r\n${editor}`)
  })

  it('constructs raw models when switching two owned paths without remounting CodeEditor', async () => {
    const disk = '\ufeff\ufeff// first\r\n'
    const secondPath = join(fixture, 'literal.cpp')
    const secondDisk = '\ufeff\ufeff// second\r\n'
    await open(disk)
    await fs.writeFile(secondPath, secondDisk, 'utf8')
    await act(async () => { await useStore.getState().openFile(secondPath) })
    await host.render(createElement(CodeEditor, { path: secondPath }))
    const firstEditor = browser.editors[0]
    const secondEditor = browser.editors.at(-1)!
    expect(firstEditor.getModel().isDisposed()).toBe(true)
    await typeAtStart('// second prefix\r\n')
    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(secondPath)).toEqual(Buffer.from('\ufeff// second prefix\r\n\ufeff// second\r\n', 'utf8'))
    expect(secondEditor.getValue()).toBe('// second prefix\r\n\ufeff// second\r\n')

    await act(async () => { useStore.getState().setActive(path) })
    await host.render(createElement(CodeEditor, { path }))
    expect(secondEditor.getModel().isDisposed()).toBe(true)
    await typeAtStart('// first prefix\r\n')
    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(path)).toEqual(Buffer.from('\ufeff// first prefix\r\n\ufeff// first\r\n', 'utf8'))
    expect(browser.createdValues).toEqual([disk, secondDisk, disk])
    expect(browser.editors).toHaveLength(3)
  })

  it('reconstructs the first raw model after an intervening path is cancelled before mounting', async () => {
    const disk = '\ufeff\ufeff// first\r\n'
    const secondPath = join(fixture, 'literal.cpp')
    await open(disk)
    await fs.writeFile(secondPath, '\ufeff\ufeff// never mounted\r\n', 'utf8')
    let resolve!: (api: typeof browser.api) => void
    let cancelled = false
    const waiting = new Promise<typeof browser.api>((done, reject) => {
      resolve = (api) => cancelled ? reject({ type: 'cancelation' }) : done(api)
    })
    const cancel = vi.fn(() => { cancelled = true })
    vi.spyOn(loader, 'init').mockReturnValueOnce(Object.assign(waiting, { cancel }) as unknown as ReturnType<typeof loader.init>)
    await act(async () => { await useStore.getState().openFile(secondPath) })
    await host.render(createElement(CodeEditor, { path: secondPath }))
    expect(browser.editors).toHaveLength(1)
    expect(browser.editors[0].getModel().isDisposed()).toBe(true)

    await act(async () => { useStore.getState().setActive(path) })
    await host.render(createElement(CodeEditor, { path }))
    await act(async () => { resolve(browser.api); await expect(waiting).rejects.toEqual({ type: 'cancelation' }) })
    expect(cancel).toHaveBeenCalledOnce()
    expect(browser.editors).toHaveLength(2)
    expect(browser.editors[1].getValue()).toBe('\ufeff// first\r\n')
    await typeAtStart('// returned\r\n')
    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(path)).toEqual(Buffer.from('\ufeff// returned\r\n\ufeff// first\r\n', 'utf8'))
    expect(await fs.readFile(secondPath)).toEqual(Buffer.from('\ufeff\ufeff// never mounted\r\n', 'utf8'))
    expect(browser.createdValues).toEqual([disk, disk])
  })

  it('keeps the new path controlled if the previous editor disposes after the new mount', async () => {
    await open('\ufeff\ufeff// first\r\n')
    const secondPath = join(fixture, 'literal.cpp')
    const secondDisk = '\ufeff\ufeff// second\r\n'
    await fs.writeFile(secondPath, secondDisk, 'utf8')
    browser.disposals.held = true
    await act(async () => { await useStore.getState().openFile(secondPath) })
    await host.render(createElement(CodeEditor, { path: secondPath }))
    expect(browser.editors).toHaveLength(2)
    expect(browser.disposals.pending).toHaveLength(1)
    await act(async () => { for (const listener of browser.disposals.pending.splice(0)) listener() })
    browser.disposals.held = false
    await act(async () => {
      useStore.setState({ agentEdits: [{
        id: 'second-approval', path: secondPath, oldContent: secondDisk.replace(/\r\n/g, '\n'),
        newContent: '// second approved\n', status: 'pending'
      }] })
      await useStore.getState().approveAgentEdit('second-approval')
    })
    expect(browser.editors[1].getValue()).toBe('// second approved\r\n')
    await typeAtStart('// second typed\r\n')
    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(secondPath)).toEqual(Buffer.from('\ufeff// second typed\r\n// second approved\r\n', 'utf8'))
    expect(await fs.readFile(path)).toEqual(Buffer.from('\ufeff\ufeff// first\r\n', 'utf8'))
  })

  it.each([{ name: 'CRLF', bom: '' }, { name: 'BOM/CRLF', bom: '\ufeff' }])('keeps exact $name bytes after approval updates an existing model, typing and repeated saves', async ({ bom }) => {
    const original = `${bom}// original\r\n`
    await open(original)
    await act(async () => {
      useStore.setState({ agentEdits: [{
        id: 'editor-approval', path, oldContent: original.replace(/\r\n/g, '\n'),
        newContent: '// approved\n// keep\ufeffthis\n', status: 'pending'
      }] })
      await useStore.getState().approveAgentEdit('editor-approval')
    })
    const approved = `${bom}// approved\r\n// keep\ufeffthis\r\n`
    expect(useStore.getState().agentEdits[0].status).toBe('approved')
    expect(await fs.readFile(path)).toEqual(Buffer.from(approved, 'utf8'))
    expect(browser.editors).toHaveLength(1)
    const approvedModelValue = browser.editors[0].getValue()

    await typeAtStart('// typed first\r\n')
    const saved = `${bom}// typed first\r\n// approved\r\n// keep\ufeffthis\r\n`
    const editedTab = useStore.getState().tabs[0]
    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(path)).toEqual(Buffer.from(saved, 'utf8'))
    expect(approvedModelValue).toBe('// approved\r\n// keep\ufeffthis\r\n')
    expect(editedTab).toMatchObject({ content: saved, savedContent: approved })
    expect(useStore.getState().tabs[0]).toMatchObject({ content: saved, savedContent: saved })
    expect(browser.editors[0].getValue()).toBe(saved.slice(bom.length))

    await act(async () => { await useStore.getState().saveActive() })
    expect(await fs.readFile(path)).toEqual(Buffer.from(saved, 'utf8'))
    expect(await fs.readdir(fixture)).toEqual(['main.cpp'])
  })
})
