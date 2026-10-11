import { beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'
import { CONSOLE_TEXT_LIMIT } from '../src/shared/consoleBuffer'
import type { Diagnostic, DiagnosticCapture } from '../src/shared/ipc'

const api = {
  writeFile: vi.fn(), readFile: vi.fn(), readDir: vi.fn(), exists: vi.fn(),
  watchStart: vi.fn(), watchStop: vi.fn(), lspDisposeRoot: vi.fn(), lspServers: vi.fn(),
  getProjectConfig: vi.fn(), setProjectConfig: vi.fn(), buildProjectModel: vi.fn(),
  boardStatus: vi.fn(), boardListConnected: vi.fn(), boardListAll: vi.fn(),
  runStart: vi.fn(), runStop: vi.fn(), boardCompile: vi.fn(), boardUpload: vi.fn(),
  debugStart: vi.fn(), debugStop: vi.fn(), coreInstall: vi.fn()
}
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key)
})
vi.stubGlobal('window', { api })
const { useStore, workspaceScopedReset } = await import('../src/renderer/src/store/useStore')
const initial = useStore.getState()
const root = 'D:/owned-diagnostic-store-fixture'
const problem: Diagnostic = {
  file: `${root}/main.cpp`, line: 3, column: 7, severity: 'error', message: 'missing value', code: 'E001'
}
const summary: DiagnosticCapture = { omittedDiagnostics: 2, unparsedBytes: 37 }

function tab(path = `${root}/main.cpp`) {
  return { path, name: path.split('/').pop()!, content: 'int main() {}', savedContent: 'int main() {}', language: langFromPath(path), group: 0 }
}

beforeEach(() => {
  storage.clear()
  Object.values(api).forEach((mock) => mock.mockReset().mockResolvedValue(undefined))
  api.readDir.mockResolvedValue([])
  api.exists.mockResolvedValue(false)
  api.getProjectConfig.mockResolvedValue({})
  api.lspServers.mockResolvedValue({ cpp: false, rust: false, python: false })
  api.boardStatus.mockResolvedValue({ available: true, setupRequired: false })
  api.boardListConnected.mockResolvedValue([])
  api.boardListAll.mockResolvedValue([])
  api.buildProjectModel.mockResolvedValue(null)
  useStore.setState({
    ...initial, workspaceRoot: root, tabs: [tab()], activePath: `${root}/main.cpp`,
    selectedFqbn: 'arduino:avr:uno', serialPath: 'owned-fixture-port', boards: [],
    notifications: [], notifUnread: 0
  }, true)
})

describe('actual store diagnostic capture state', () => {
  it('starts without an omission summary', () => {
    expect(initial.diagnostics).toEqual([])
    expect(initial.diagnosticCapture).toBe(null)
  })

  it.each(['runId', 'simRunId', 'debugRunId'] as const)('accepts diagnostics and capture under the current %s', (key) => {
    useStore.setState({ [key]: 'current-build' })
    useStore.getState().handleDiagnostics({ id: 'current-build', diagnostics: [problem], capture: summary })

    expect(useStore.getState().diagnostics).toEqual([problem])
    expect(useStore.getState().diagnosticCapture).toEqual(summary)
  })

  it('publishes the array and metadata in one accepted state update', () => {
    useStore.setState({ runId: 'current-build' })
    const updates: Array<{ diagnostics: Diagnostic[]; capture: DiagnosticCapture | null }> = []
    const unsubscribe = useStore.subscribe((state) => updates.push({ diagnostics: state.diagnostics, capture: state.diagnosticCapture }))
    try {
      useStore.getState().handleDiagnostics({ id: 'current-build', diagnostics: [problem], capture: summary })
      expect(updates).toEqual([{ diagnostics: [problem], capture: summary }])
    } finally { unsubscribe() }
  })

  it('rejects both parts of a superseded build result', () => {
    useStore.setState({ runId: 'current-build', diagnostics: [problem], diagnosticCapture: summary })
    useStore.getState().handleDiagnostics({ id: 'old-build', diagnostics: [], capture: { omittedDiagnostics: 99, unparsedBytes: 999 } })

    expect(useStore.getState().diagnostics).toEqual([problem])
    expect(useStore.getState().diagnosticCapture).toEqual(summary)
  })

  it('clears old capture metadata when a complete result has no summary', () => {
    useStore.setState({ runId: 'current-build', diagnostics: [problem], diagnosticCapture: summary })
    useStore.getState().handleDiagnostics({ id: 'current-build', diagnostics: [] })

    expect(useStore.getState().diagnostics).toEqual([])
    expect(useStore.getState().diagnosticCapture).toBe(null)
  })

  it('replaces a summary even when no located diagnostics can be retained', () => {
    const unknown = { omittedDiagnostics: 0, unparsedBytes: 65 }
    useStore.setState({ runId: 'current-build', diagnostics: [problem], diagnosticCapture: summary })
    useStore.getState().handleDiagnostics({ id: 'current-build', diagnostics: [], capture: unknown })

    expect(useStore.getState().diagnostics).toEqual([])
    expect(useStore.getState().diagnosticCapture).toEqual(unknown)
  })

  it('keeps diagnostics and their summary when Console is cleared', () => {
    useStore.setState({ diagnostics: [problem], diagnosticCapture: summary, output: [{ stream: 'system', text: 'Old console text' }] })
    useStore.getState().clearOutput()

    expect(useStore.getState().output).toEqual([])
    expect(useStore.getState().diagnostics).toEqual([problem])
    expect(useStore.getState().diagnosticCapture).toEqual(summary)
  })

  it('keeps diagnostics and their summary after console-tail eviction', () => {
    useStore.setState({ runId: 'current-build', diagnostics: [problem], diagnosticCapture: summary })
    useStore.getState().appendOutput({ id: 'current-build', stream: 'stdout', data: 'x'.repeat(CONSOLE_TEXT_LIMIT + 1) })

    expect(useStore.getState().output[0].text).toContain('[Earlier console output omitted]')
    expect(useStore.getState().diagnostics).toEqual([problem])
    expect(useStore.getState().diagnosticCapture).toEqual(summary)
  })

  it('keeps the last result on Stop while rejecting the stopped child later', async () => {
    useStore.setState({ runId: 'current-build', running: true, diagnostics: [problem], diagnosticCapture: summary })
    await useStore.getState().stopRun()
    useStore.getState().handleDiagnostics({ id: 'current-build', diagnostics: [] })

    expect(api.runStop).toHaveBeenCalledExactlyOnceWith('current-build')
    expect(useStore.getState().runId).toBe(null)
    expect(useStore.getState().diagnostics).toEqual([problem])
    expect(useStore.getState().diagnosticCapture).toEqual(summary)
  })

  it('pairs the workspace reset with diagnostics', () => {
    useStore.setState({ diagnostics: [problem], diagnosticCapture: summary })
    useStore.setState(workspaceScopedReset())

    expect(useStore.getState().diagnostics).toEqual([])
    expect(useStore.getState().diagnosticCapture).toBe(null)
  })

  it('clears both parts when a different project opens and rejects old IDs', async () => {
    useStore.setState({ runId: 'old-build', diagnostics: [problem], diagnosticCapture: summary })
    await useStore.getState().openWorkspace('D:/owned-diagnostic-other-fixture')
    useStore.getState().handleDiagnostics({ id: 'old-build', diagnostics: [problem], capture: summary })

    expect(useStore.getState().diagnostics).toEqual([])
    expect(useStore.getState().diagnosticCapture).toBe(null)
  })

  it('preserves the old project result when the new project cannot open', async () => {
    useStore.setState({ diagnostics: [problem], diagnosticCapture: summary })
    api.readDir.mockRejectedValueOnce(new Error('Folder unavailable'))
    await expect(useStore.getState().openWorkspace('D:/owned-diagnostic-other-fixture')).rejects.toThrow('Folder unavailable')

    expect(useStore.getState().workspaceRoot).toBe(root)
    expect(useStore.getState().diagnostics).toEqual([problem])
    expect(useStore.getState().diagnosticCapture).toEqual(summary)
  })

  it('clears the last result when its project closes', async () => {
    useStore.setState({ diagnostics: [problem], diagnosticCapture: summary })
    await useStore.getState().closeWorkspace()

    expect(useStore.getState().workspaceRoot).toBe(null)
    expect(useStore.getState().diagnostics).toEqual([])
    expect(useStore.getState().diagnosticCapture).toBe(null)
  })

  it.each(['setFqbn', 'setBoardAndPort'] as const)('%s clears both parts for a changed board', (action) => {
    useStore.setState({ diagnostics: [problem], diagnosticCapture: summary })
    if (action === 'setFqbn') useStore.getState().setFqbn('esp32:esp32:esp32')
    else useStore.getState().setBoardAndPort('esp32:esp32:esp32', 'owned-fixture-port')

    expect(useStore.getState().diagnostics).toEqual([])
    expect(useStore.getState().diagnosticCapture).toBe(null)
  })

  it.each(['setFqbn', 'setBoardAndPort'] as const)('%s retains both parts when the board is unchanged', (action) => {
    useStore.setState({ diagnostics: [problem], diagnosticCapture: summary })
    if (action === 'setFqbn') useStore.getState().setFqbn('arduino:avr:uno')
    else useStore.getState().setBoardAndPort('arduino:avr:uno', 'different-owned-fixture-port')

    expect(useStore.getState().diagnostics).toEqual([problem])
    expect(useStore.getState().diagnosticCapture).toEqual(summary)
  })

  it.each(['runActive', 'verifyBoard', 'uploadBoard', 'startDebug'] as const)('%s resets the previous diagnostic summary before its launch', async (action) => {
    const path = action === 'verifyBoard' || action === 'uploadBoard' ? `${root}/blink.ino` : `${root}/main.cpp`
    useStore.setState({ tabs: [tab(path)], activePath: path, diagnostics: [problem], diagnosticCapture: summary })
    await useStore.getState()[action]()
    const launch = action === 'runActive' ? api.runStart : action === 'verifyBoard' ? api.boardCompile : action === 'uploadBoard' ? api.boardUpload : api.debugStart

    expect(launch).toHaveBeenCalledOnce()
    expect(useStore.getState().diagnostics).toEqual([])
    expect(useStore.getState().diagnosticCapture).toBe(null)
  })

  it('resets the previous summary for a streamed package operation', async () => {
    useStore.setState({ diagnostics: [problem], diagnosticCapture: summary })
    const installing = useStore.getState().installCore('arduino:avr')
    const id = api.coreInstall.mock.calls[0][0].id
    try {
      expect(api.coreInstall).toHaveBeenCalledOnce()
      expect(useStore.getState().diagnostics).toEqual([])
      expect(useStore.getState().diagnosticCapture).toBe(null)
    } finally {
      useStore.getState().handleRunExit({ id, code: 0, signal: null, durationMs: 1, phase: 'run' })
      await installing
    }
  })
})
