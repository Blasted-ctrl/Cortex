import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureSession, decodeSessions, SESSION_STORAGE_KEY } from '../src/shared/workspaceSession'
import type { FileReadResult, FileNode } from '../src/shared/ipc'

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
const api = {
  readDir: vi.fn(), readFile: vi.fn(), readWorkspaceFile: vi.fn(), readWorkspaceDir: vi.fn(), writeFile: vi.fn(),
  watchStop: vi.fn(), watchStart: vi.fn(), lspDisposeRoot: vi.fn(), lspServers: vi.fn(), debugStop: vi.fn()
}
vi.stubGlobal('window', { api })
const { useStore, workspaceScopedReset } = await import('../src/renderer/src/store/useStore')
const root = 'C:/project'
const node = { path: `${root}/src`, name: 'src', isDir: true }
const saved = captureSession({ workspaceRoot: root, tabs: [{ path: `${root}/a.cpp`, group: 0 }, { path: `${root}/b.cpp`, group: 1 }], activeGroup: 1, groupActive: { 0: `${root}/a.cpp`, 1: `${root}/b.cpp` }, expanded: new Set([node.path]) })!
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(ok => { resolve = ok }); return { promise, resolve } }
beforeEach(() => {
  useStore.setState({ ...workspaceScopedReset(), workspaceRoot: null })
  storage.clear()
  vi.clearAllMocks()
  api.readDir.mockReset().mockResolvedValue([node])
  api.readWorkspaceDir.mockReset().mockResolvedValue([])
  api.readFile.mockReset().mockImplementation(async (path: string) => ({ kind: 'text', content: `disk:${path}` }))
  api.readWorkspaceFile.mockReset().mockImplementation(async (_root: string, path: string) => ({ kind: 'text', content: `disk:${path}` }))
  api.writeFile.mockReset().mockResolvedValue(undefined)
  api.watchStart.mockReset().mockResolvedValue(undefined)
  api.watchStop.mockResolvedValue(undefined)
  api.lspDisposeRoot.mockResolvedValue(undefined)
  api.lspServers.mockResolvedValue({ cpp: false, rust: false, python: false })
  useStore.setState({ notifications: [], loadProjectConfig: vi.fn().mockResolvedValue(undefined), loadDiagram: vi.fn().mockResolvedValue(undefined), refreshBoardStatus: vi.fn().mockResolvedValue(undefined), refreshProjectModel: vi.fn().mockResolvedValue(undefined) })
})

describe('actual store project session lifecycle', () => {
  it('treats Windows directory aliases as one pending expansion across collapse and reopen', async () => {
    await useStore.getState().openWorkspace(root)
    const native = { ...node, path: 'C:\\Project\\src' }
    const alias = { ...node, path: 'c:/project/SRC' }
    const stale = deferred<FileNode[]>()
    const fresh = deferred<FileNode[]>()
    api.readDir.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const first = useStore.getState().toggleDir(native)
    const collapse = useStore.getState().toggleDir(alias)
    const collapsed = [...useStore.getState().expanded]
    const second = useStore.getState().toggleDir(alias)
    stale.resolve([{ path: `${native.path}\\stale.cpp`, name: 'stale.cpp', isDir: false }])
    await first
    fresh.resolve([{ path: `${alias.path}/fresh.cpp`, name: 'fresh.cpp', isDir: false }])
    await collapse
    await second
    expect(collapsed).toEqual([])
    expect(useStore.getState().expanded).toEqual(new Set([alias.path]))
    expect(Object.values(useStore.getState().childrenCache).flat().map(entry => entry.name)).toEqual(['fresh.cpp'])
  })

  it('restores fresh disk bytes, two groups and expanded directories', async () => {
    storage.set(SESSION_STORAGE_KEY, JSON.stringify([saved]))
    await useStore.getState().openWorkspace(root)
    expect(useStore.getState()).toMatchObject({ activePath: `${root}/b.cpp`, activeGroup: 1, groupActive: { 0: `${root}/a.cpp`, 1: `${root}/b.cpp` } })
    expect(useStore.getState().tabs.map(tab => [tab.path, tab.content, tab.savedContent, tab.group])).toEqual([[`${root}/a.cpp`, `disk:${root}/a.cpp`, `disk:${root}/a.cpp`, 0], [`${root}/b.cpp`, `disk:${root}/b.cpp`, `disk:${root}/b.cpp`, 1]])
    expect(useStore.getState().expanded).toEqual(new Set([node.path]))
    expect(api.readFile).not.toHaveBeenCalled()
    expect(api.readWorkspaceFile).toHaveBeenCalledWith(root, `${root}/a.cpp`)
  })
  it('remembers metadata on changes/close without recording unsaved bytes', async () => {
    await useStore.getState().openWorkspace(root)
    await useStore.getState().openFile(`${root}/a.cpp`)
    await useStore.getState().toggleDir(node)
    useStore.getState().updateContent(`${root}/a.cpp`, 'UNSAVED SECRET')
    expect(storage.get(SESSION_STORAGE_KEY)).not.toContain('UNSAVED SECRET')
    await useStore.getState().closeWorkspace()
    expect(decodeSessions(storage.get(SESSION_STORAGE_KEY)!)[0]).toMatchObject({ root, tabs: [{ path: 'a.cpp', group: 0 }], expanded: ['src'] })
    await useStore.getState().openWorkspace(root)
    expect(useStore.getState().tabs[0].content).toBe(`disk:${root}/a.cpp`)
  })
  it('skips missing or forbidden files/folders and repairs layout', async () => {
    storage.set(SESSION_STORAGE_KEY, JSON.stringify([saved]))
    api.readWorkspaceFile.mockRejectedValueOnce(new Error('missing'))
    api.readWorkspaceDir.mockRejectedValueOnce(new Error('outside project'))
    await useStore.getState().openWorkspace(root)
    expect(useStore.getState().tabs).toHaveLength(1)
    expect(useStore.getState()).toMatchObject({ activePath: `${root}/b.cpp`, activeGroup: 0 })
    expect(useStore.getState().expanded.size).toBe(0)
  })
  it('does not overwrite a file the user opens while restore is pending', async () => {
    storage.set(SESSION_STORAGE_KEY, JSON.stringify([saved]))
    const read = deferred<FileReadResult>()
    api.readWorkspaceFile.mockReturnValueOnce(read.promise)
    const opening = useStore.getState().openWorkspace(root)
    await vi.waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalled())
    await useStore.getState().openFile(`${root}/new.cpp`)
    useStore.getState().updateContent(`${root}/new.cpp`, 'keep new edits')
    read.resolve({ kind: 'text', content: 'late saved data' })
    await opening
    expect(useStore.getState().tabs.map(tab => tab.path)).toEqual([`${root}/new.cpp`])
    expect(useStore.getState().tabs[0].content).toBe('keep new edits')
  })
  it('preserves the current project and session when switching fails', async () => {
    await useStore.getState().openWorkspace(root)
    await useStore.getState().openFile(`${root}/a.cpp`)
    api.watchStart.mockRejectedValueOnce(new Error('watch denied'))
    await expect(useStore.getState().openWorkspace('C:/other')).rejects.toThrow('watch denied')
    expect(useStore.getState().workspaceRoot).toBe(root)
    expect(useStore.getState().tabs[0].path).toBe(`${root}/a.cpp`)
    expect(decodeSessions(storage.get(SESSION_STORAGE_KEY)!)[0].tabs[0].path).toBe('a.cpp')
  })
  it('drops old directory reads after a project switch', async () => {
    await useStore.getState().openWorkspace(root)
    const read = deferred<FileNode[]>()
    api.readDir.mockReturnValueOnce(read.promise)
    const expansion = useStore.getState().toggleDir(node)
    await useStore.getState().openWorkspace('C:/other')
    read.resolve([{ path: `${node.path}/old.cpp`, name: 'old.cpp', isDir: false }])
    await expansion
    expect(useStore.getState().expanded.size).toBe(0)
    expect(useStore.getState().childrenCache).toEqual({})
  })
  it('keeps simultaneous folder expansions and respects collapse during a read', async () => {
    await useStore.getState().openWorkspace(root)
    const first = deferred<FileNode[]>()
    const second = deferred<FileNode[]>()
    api.readDir.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const other = { path: `${root}/include`, name: 'include', isDir: true }
    const a = useStore.getState().toggleDir(node)
    const b = useStore.getState().toggleDir(other)
    second.resolve([])
    await b
    first.resolve([])
    await a
    expect(useStore.getState().expanded).toEqual(new Set([node.path, other.path]))
    await useStore.getState().toggleDir(node)
    const delayed = deferred<FileNode[]>()
    api.readDir.mockReturnValueOnce(delayed.promise)
    useStore.setState({ childrenCache: {} })
    const opening = useStore.getState().toggleDir(node)
    await useStore.getState().toggleDir(node)
    delayed.resolve([])
    await opening
    expect(useStore.getState().expanded.has(node.path)).toBe(false)
  })
  it('a pending user folder action cancels late session restoration', async () => {
    storage.set(SESSION_STORAGE_KEY, JSON.stringify([saved]))
    const restored = deferred<FileReadResult>()
    api.readWorkspaceFile.mockReturnValueOnce(restored.promise)
    const opening = useStore.getState().openWorkspace(root)
    await vi.waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalled())
    const directory = deferred<FileNode[]>()
    api.readDir.mockReturnValueOnce(directory.promise)
    const expansion = useStore.getState().toggleDir(node)
    restored.resolve({ kind: 'text', content: 'late saved data' })
    await opening
    directory.resolve([])
    await expansion
    expect(useStore.getState().tabs).toEqual([])
    expect(useStore.getState().expanded).toEqual(new Set([node.path]))
  })
  it('never restores stale directory entries after a newer watcher refresh', async () => {
    await useStore.getState().openWorkspace(root)
    const directory = deferred<FileNode[]>()
    api.readDir.mockReturnValueOnce(directory.promise)
    const expansion = useStore.getState().toggleDir(node)
    api.readDir.mockResolvedValueOnce([node]).mockResolvedValueOnce([])
    await useStore.getState().refreshTree()
    directory.resolve([{ name: 'deleted.cpp', path: `${node.path}/deleted.cpp`, isDir: false }])
    await expansion
    expect(useStore.getState().childrenCache[node.path]).toEqual([])
  })
  it('a delayed discard confirmation cannot remove newer edits or a reopened tab', async () => {
    await useStore.getState().openWorkspace(root)
    await useStore.getState().openFile(`${root}/a.cpp`)
    useStore.getState().updateContent(`${root}/a.cpp`, 'old edits')
    const decision = deferred<boolean>()
    useStore.setState({ confirm: vi.fn().mockReturnValueOnce(decision.promise) })
    const close = useStore.getState().closeTab(`${root}/a.cpp`)
    useStore.getState().updateContent(`${root}/a.cpp`, 'new edits')
    decision.resolve(true)
    await close
    expect(useStore.getState().tabs[0].content).toBe('new edits')
    const delayed = deferred<boolean>()
    useStore.setState({ confirm: vi.fn().mockReturnValueOnce(delayed.promise) })
    const staleClose = useStore.getState().closeTab(`${root}/a.cpp`)
    await useStore.getState().closeWorkspace()
    await useStore.getState().openWorkspace(root)
    useStore.getState().updateContent(`${root}/a.cpp`, 'reopened edits')
    delayed.resolve(true)
    await staleClose
    expect(useStore.getState().tabs[0].content).toBe('reopened edits')
  })
  it('a newer watcher refresh takes precedence over late saved-folder restoration', async () => {
    storage.set(SESSION_STORAGE_KEY, JSON.stringify([saved]))
    const directory = deferred<FileNode[]>()
    api.readWorkspaceDir.mockReturnValueOnce(directory.promise)
    const opening = useStore.getState().openWorkspace(root)
    await vi.waitFor(() => expect(api.readWorkspaceDir).toHaveBeenCalled())
    api.readDir.mockResolvedValueOnce([node])
    await useStore.getState().refreshTree()
    directory.resolve([{ name: 'deleted.cpp', path: `${node.path}/deleted.cpp`, isDir: false }])
    await opening
    expect(useStore.getState().childrenCache[node.path]).toBeUndefined()
  })
})
